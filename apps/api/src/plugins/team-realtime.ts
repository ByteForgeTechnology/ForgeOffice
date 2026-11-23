import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { featureEnabled, meetings, orm, type Meeting } from '@forge/db';
import { verifyToken } from '@forge/drive';
import { channelAudience, computePresence, requireChannel, type JoinResult } from '@forge/team';
import type { AppContext } from '../context';
import { meetingByCode, teamSettings } from '../routes/team';
import { loadPrincipalData } from './auth';

const { and, eq } = orm;

interface SocketData {
  userId: string | null;
  orgId: string;
  name: string;
  /** Guests: the meeting their pass is for. */
  guestMeetingId: string | null;
  /** Guests let in from the lobby. */
  admitted: boolean;
  /** The meeting this connection is in. */
  meetingId: string | null;
  knocking: string | null;
}

type Ack = (res: { ok: true; [k: string]: unknown } | { ok: false; error: string }) => void;

/**
 * ForgeTeam's Socket.IO server (path /team-socket, in the team service):
 * live messages, typing, presence and meeting signalling for the SFU.
 * Rooms: user:<id> (a person's tabs and devices), org:<id> (presence),
 * call:<meeting id> (people in a meeting), lobby:<meeting id> (guests waiting).
 */
export function attachTeamRealtime(server: HttpServer, ctx: AppContext, log: { warn: (o: unknown, m?: string) => void; info: (o: unknown, m?: string) => void }) {
  const { db } = ctx;
  const io = new Server<Record<string, (...a: never[]) => void>, Record<string, (...a: unknown[]) => void>, Record<string, never>, SocketData>(server, {
    path: '/team-socket',
    serveClient: false,
    maxHttpBufferSize: 1_000_000,
  });
  const cleanups: (() => void)[] = [];
  if (ctx.redis) {
    const pub = ctx.redis.duplicate();
    const sub = ctx.redis.duplicate();
    io.adapter(createAdapter(pub, sub, { key: 'forge:team-socket' }));
    cleanups.push(() => (pub.disconnect(), sub.disconnect()));
  }

  ctx.team.hub = {
    toUsers: (ids, event, payload) => {
      if (ids.length) io.to([...new Set(ids)].map((id) => `user:${id}`)).emit(event, payload);
    },
    toRoom: (room, event, payload) => void io.to(room).emit(event, payload),
  };

  io.use(async (socket, next) => {
    try {
      const auth = (socket.handshake.auth ?? {}) as { token?: unknown; guest?: unknown };
      if (typeof auth.guest === 'string') {
        const claims = verifyToken<{ m: string; n: string; g: string }>(ctx.keys.shareLinkKey, auth.guest, 'team-guest');
        if (!claims) return next(new Error('unauthorized'));
        const [meeting] = await db.select().from(meetings).where(eq(meetings.id, claims.m)).limit(1);
        if (!meeting || !(await teamSettings(ctx, meeting.orgId)).guestAccess) return next(new Error('guests_not_allowed'));
        socket.data = { userId: null, orgId: meeting.orgId, name: claims.n, guestMeetingId: meeting.id, admitted: false, meetingId: null, knocking: null };
        return next();
      }
      if (typeof auth.token !== 'string') return next(new Error('unauthorized'));
      const claims = await ctx.verifyAccessToken(auth.token);
      const data = await loadPrincipalData(ctx, claims.sub);
      if (!data || data.user.status !== 'active') return next(new Error('unauthorized'));
      if (!(await featureEnabled(db, 'team'))) return next(new Error('feature_disabled'));
      socket.data = { userId: data.user.id, orgId: data.user.orgId, name: data.user.displayName, guestMeetingId: null, admitted: true, meetingId: null, knocking: null };
      void socket.join([`user:${data.user.id}`, `org:${data.user.orgId}`]);
      if (claims.exp) {
        const timer = setTimeout(() => socket.disconnect(true), Math.max(0, claims.exp * 1000 - Date.now()));
        socket.once('disconnect', () => clearTimeout(timer));
      }
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  // ---------------------------------------------------------------------------
  // Presence: heartbeats from open tabs; changes go to everyone in the organisation
  // ---------------------------------------------------------------------------

  const lastPresence = new Map<string, { orgId: string; status: string }>();
  const publishPresence = async (userId: string, orgId: string) => {
    const p = (await computePresence(db, ctx.team.presence, [userId]))[userId];
    if (!p) return;
    const key = `${p.status}|${p.message}|${p.until}`;
    if (lastPresence.get(userId)?.status === key) return;
    if (p.status === 'offline') lastPresence.delete(userId);
    else lastPresence.set(userId, { orgId, status: key });
    io.to(`org:${orgId}`).emit('presence', { userId, ...p });
  };
  // Calendar meetings start and end, and closed tabs stop heart-beating: look again regularly.
  const sweep = setInterval(() => {
    for (const [userId, { orgId }] of lastPresence) void publishPresence(userId, orgId).catch(() => {});
  }, 30_000);
  sweep.unref();

  // ---------------------------------------------------------------------------
  // Meetings (each hosted by a media server; see @forge/team media-cluster)
  // ---------------------------------------------------------------------------

  /** Guests admitted while connected to this team service (other services check Redis). */
  const admittedHere = new Map<string, string>();

  const callRoom = (id: string) => `call:${id}`;
  const media = ctx.team.media;

  const lobbyList = async (meetingId: string) =>
    (await io.in(`lobby:${meetingId}`).fetchSockets()).map((s) => ({ id: s.id, name: s.data.name }));
  const announceLobby = async (meetingId: string) => io.to(callRoom(meetingId)).emit('call:lobby', { waiting: await lobbyList(meetingId) });

  const isHost = async (meeting: Meeting, userId: string | null) => {
    if (!userId) return false;
    if (meeting.createdBy === userId) return true;
    if (!meeting.channelId) return !meeting.createdBy; // calendar meetings: everyone from the organisation
    try {
      const a = await requireChannel(db, userId, meeting.orgId, meeting.channelId);
      return a.canManage || a.channel.kind === 'dm' || a.channel.kind === 'group';
    } catch {
      return false;
    }
  };

  const leaveCall = async (socket: Socket<never, never, never, SocketData>) => {
    const meetingId = socket.data.meetingId;
    if (!meetingId) return;
    socket.data.meetingId = null;
    void socket.leave(callRoom(meetingId));
    // The media server hosting the meeting forgets this connection (ends the meeting if it was the last).
    await media.call(meetingId, 'leave', { peerId: socket.id }).catch(() => {});
    if (socket.data.userId) {
      // Still in a call in another tab?
      const others = (await io.in(`user:${socket.data.userId}`).fetchSockets()).some((s) => s.id !== socket.id && s.data.meetingId);
      if (!others) {
        await ctx.team.presence.setInCall(socket.data.userId, false);
        await publishPresence(socket.data.userId, socket.data.orgId);
      }
    }
  };

  // Being in a call keeps "In a call" fresh.
  const callBeat = setInterval(async () => {
    for (const s of await io.local.fetchSockets()) if (s.data.userId && s.data.meetingId) await ctx.team.presence.setInCall(s.data.userId, true).catch(() => {});
  }, 30_000);
  callBeat.unref();

  io.on('connection', (raw) => {
    const socket = raw as unknown as Socket<never, never, never, SocketData>;
    const d = socket.data;
    const on = (event: string, fn: (payload: Record<string, unknown>) => Promise<Record<string, unknown> | void>) =>
      (socket as unknown as Socket).on(event, async (payload: unknown, ack?: Ack) => {
        try {
          const res = await fn((payload ?? {}) as Record<string, unknown>);
          if (typeof ack === 'function') ack({ ok: true, ...(res ?? {}) });
        } catch (err) {
          if (typeof ack === 'function') ack({ ok: false, error: (err as Error).message });
          else log.warn({ err, event }, 'team socket handler failed');
        }
      });
    /** The meeting this connection is in (its signalling goes to that meeting's media server). */
    const inMeeting = () => {
      if (!d.meetingId) throw new Error('You are not in a meeting');
      return d.meetingId;
    };
    const call = <T = Record<string, unknown>>(method: string, args: Record<string, unknown> = {}) => media.call<T>(inMeeting(), method, { peerId: socket.id, ...args });
    const str = (v: unknown, what: string) => {
      if (typeof v !== 'string' || !v || v.length > 200) throw new Error(`Missing ${what}`);
      return v;
    };

    if (d.userId) {
      void ctx.team.presence.heartbeat(d.userId, true).then(() => publishPresence(d.userId!, d.orgId)).catch(() => {});
      on('presence:heartbeat', async (p) => {
        await ctx.team.presence.heartbeat(d.userId!, p.active !== false);
        await publishPresence(d.userId!, d.orgId);
      });

      let lastTyping = 0;
      on('typing', async (p) => {
        if (Date.now() - lastTyping < 2000) return;
        lastTyping = Date.now();
        const a = await requireChannel(db, d.userId!, d.orgId, str(p.channelId, 'channel'));
        const others = (await channelAudience(db, a.channel)).filter((id) => id !== d.userId);
        if (others.length) io.to(others.map((id) => `user:${id}`)).emit('typing', { channelId: a.channel.id, userId: d.userId, name: d.name });
      });
    }

    // ---- meetings --------------------------------------------------------------

    /** What someone needs to know before joining: the meeting, and whether they wait in the lobby. */
    const prepare = async (code: string) => {
      const meeting = d.guestMeetingId
        ? (await db.select().from(meetings).where(eq(meetings.id, d.guestMeetingId)).limit(1))[0]
        : await meetingByCode(ctx, code, d.orgId);
      if (!meeting || meeting.orgId !== d.orgId || (d.guestMeetingId && meeting.code !== code)) throw new Error('Meeting not found');
      if (d.userId && meeting.channelId) await requireChannel(db, d.userId, d.orgId, meeting.channelId).catch(() => {
        throw new Error('This meeting is for the members of a channel you’re not in');
      });
      return meeting;
    };

    on('call:prepare', async (p) => {
      const meeting = await prepare(str(p.code, 'meeting'));
      const settings = await teamSettings(ctx, meeting.orgId);
      const info = await media.info(meeting.id);
      return {
        meeting: { id: meeting.id, title: meeting.title, code: meeting.code },
        you: { name: d.name, guest: !d.userId, host: await isHost(meeting, d.userId) },
        lobby: !d.userId && !d.admitted,
        participants: info?.peers.map((x) => ({ name: x.name, guest: x.guest })) ?? [],
        recordingAllowed: settings.recording,
      };
    });

    // Guests knock; anyone from the organisation in the meeting can let them in.
    on('call:knock', async (p) => {
      if (d.userId) throw new Error('Only guests wait in the lobby');
      const meeting = await prepare(str(p.code, 'meeting'));
      d.knocking = meeting.id;
      await socket.join(`lobby:${meeting.id}`);
      await announceLobby(meeting.id);
      return { waiting: true, inMeeting: (await media.info(meeting.id))?.peers.length ?? 0 };
    });

    on('call:admit', async (p) => {
      const meetingId = inMeeting();
      const me = await call<{ guest: boolean } | null>('peer');
      if (!me || me.guest) throw new Error('Only people from the organisation can admit guests');
      const target = (await io.in(`lobby:${meetingId}`).fetchSockets()).find((s) => s.id === p.guestId);
      if (!target) throw new Error('They’re no longer waiting');
      target.leave(`lobby:${meetingId}`);
      if (p.admit === false) {
        target.emit('call:denied', {});
      } else {
        // The guest's connection may be on another team service: it learns it was admitted from this event.
        target.emit('call:admitted', { meetingId });
        await ctx.redis?.set(`forge:team:admitted:${target.id}`, meetingId, 'EX', 3600);
        admittedHere.set(target.id, meetingId);
      }
      await announceLobby(meetingId);
    });

    on('call:join', async (p) => {
      if (d.meetingId) throw new Error('You are already in a meeting');
      const meeting = await prepare(str(p.code, 'meeting'));
      if (!d.userId && !d.admitted) {
        const ok = admittedHere.get(socket.id) === meeting.id || (await ctx.redis?.get(`forge:team:admitted:${socket.id}`)) === meeting.id;
        if (!ok) throw new Error('Wait to be admitted');
        d.admitted = true;
      }
      const settings = await teamSettings(ctx, meeting.orgId);
      if (!meeting.startedAt || meeting.endedAt) await db.update(meetings).set({ startedAt: meeting.endedAt || !meeting.startedAt ? new Date() : meeting.startedAt, endedAt: null }).where(eq(meetings.id, meeting.id));
      // Calendar meetings: the first person from the organisation to open it hosts it.
      if (!meeting.createdBy && d.userId) await db.update(meetings).set({ createdBy: d.userId }).where(and(eq(meetings.id, meeting.id)));
      const host = await isHost({ ...meeting, createdBy: meeting.createdBy ?? d.userId }, d.userId);
      // Join the meeting's room first, so this connection hears everything from now on.
      await socket.join(callRoom(meeting.id));
      let joined: JoinResult;
      try {
        joined = await media.call<JoinResult>(meeting.id, 'join', { peer: { id: socket.id, userId: d.userId, name: d.name, guest: !d.userId, host }, max: settings.maxParticipants });
      } catch (err) {
        void socket.leave(callRoom(meeting.id));
        throw err;
      }
      d.meetingId = meeting.id;
      d.knocking = null;
      void socket.leave(`lobby:${meeting.id}`);
      if (d.userId) {
        await ctx.team.presence.setInCall(d.userId, true);
        await publishPresence(d.userId, d.orgId);
      }
      return {
        ...joined,
        recordingAllowed: settings.recording && host,
        lobby: host || d.userId ? await lobbyList(meeting.id) : [],
        meeting: { id: meeting.id, title: meeting.title, code: meeting.code, channelId: meeting.channelId },
      };
    });

    on('call:transport', async () => call('transport'));
    on('call:connect', async (p) => call('connect', { transportId: str(p.transportId, 'connection'), dtlsParameters: p.dtlsParameters }));
    on('call:produce', async (p) => {
      const source = p.source === 'screen' || p.source === 'cam' ? p.source : 'mic';
      return call('produce', { transportId: str(p.transportId, 'connection'), kind: p.kind === 'video' ? 'video' : 'audio', rtpParameters: p.rtpParameters, source });
    });
    on('call:consume', async (p) => call('consume', { transportId: str(p.transportId, 'connection'), producerId: str(p.producerId, 'stream'), rtpCapabilities: p.rtpCapabilities }));
    on('call:resume', async (p) => call('resume', { consumerId: str(p.consumerId, 'stream') }));
    on('call:pause', async (p) => call('pause', { producerId: str(p.producerId, 'stream'), paused: p.paused === true }));
    on('call:close-producer', async (p) => call('closeProducer', { producerId: str(p.producerId, 'stream') }));
    on('call:hand', async (p) => call('hand', { raised: p.raised === true }));
    on('call:reaction', async (p) => {
      const emoji = typeof p.emoji === 'string' && p.emoji.length <= 8 ? p.emoji : null;
      if (emoji) await call('reaction', { emoji });
    });
    on('call:mute', async (p) => call('mute', { target: str(p.peerId, 'person'), byName: d.name }));
    on('call:remove', async (p) => {
      const target = str(p.peerId, 'person');
      await call('remove', { target, byName: d.name });
      // Their connection (here or on another team service) leaves the meeting's room.
      io.in(target).socketsLeave(callRoom(inMeeting()));
    });
    on('call:record', async (p) => {
      const meetingId = inMeeting();
      const [meeting] = await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1);
      if (!meeting) throw new Error('Meeting not found');
      if (p.on === true && !(await teamSettings(ctx, meeting.orgId)).recording) throw new Error('Recording is turned off for your organisation');
      return call('record', { on: p.on === true, byName: d.name, userId: d.userId });
    });

    on('call:leave', async () => {
      await leaveCall(socket);
    });

    socket.on('disconnect', () => {
      void leaveCall(socket).catch(() => {});
      if (d.knocking) void announceLobby(d.knocking).catch(() => {});
      admittedHere.delete(socket.id);
      if (d.userId) setTimeout(() => void publishPresence(d.userId!, d.orgId).catch(() => {}), 1000);
    });
  });

  return {
    io,
    async close() {
      clearInterval(sweep);
      clearInterval(callBeat);
      await io.close();
      cleanups.forEach((c) => c());
    },
  };
}

export type { SocketData };
