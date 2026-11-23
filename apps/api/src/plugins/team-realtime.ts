import type { Server as HttpServer } from 'node:http';
import { relative } from 'node:path';
import { Server, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { channels, featureEnabled, meetings, orm, recordings, teamMessages, type Meeting } from '@forge/db';
import { verifyToken } from '@forge/drive';
import { Recorder, channelAudience, computePresence, postMessage, recordingPath, requireChannel, serialiseMessages, type Room } from '@forge/team';
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
  // Meetings
  // ---------------------------------------------------------------------------

  const wired = new Set<string>();
  const recorders = new Map<string, { recorder: Recorder; by: string | null; meeting: Meeting }>();
  const callRoom = (id: string) => `call:${id}`;

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

  /** Save a finished recording and post it where the meeting was held. */
  const finishRecording = async (meetingId: string) => {
    const r = recorders.get(meetingId);
    if (!r) return;
    recorders.delete(meetingId);
    try {
      const result = await r.recorder.stop();
      const rel = relative(ctx.config.volumes.team.path, result.path);
      const [rec] = await db.insert(recordings).values({ meetingId, path: rel, size: result.size, durationMs: result.durationMs, startedBy: r.by }).returning();
      io.to(callRoom(meetingId)).emit('call:recording', { on: false, recordingId: rec!.id });
      if (r.meeting.channelId) {
        const [channel] = await db.select().from(channels).where(eq(channels.id, r.meeting.channelId)).limit(1);
        if (channel) {
          const msg = await postMessage({ db, drive: ctx.drive }, channel, null, { body: '', kind: 'recording', meta: { recordingId: rec!.id, meetingId, title: r.meeting.title, durationMs: result.durationMs, size: result.size } });
          ctx.team.hub.toUsers(await channelAudience(db, channel), 'message:new', { message: msg, channel: { id: channel.id, kind: channel.kind, teamId: channel.teamId, name: channel.name } });
        }
      }
    } catch (err) {
      log.warn({ err, meetingId }, 'could not save a meeting recording');
      io.to(callRoom(meetingId)).emit('call:recording', { on: false, error: 'The recording could not be saved' });
    }
  };

  /** When the last person leaves: the meeting ends, its card says so, and the recording is saved. */
  const meetingEnded = async (meetingId: string, participants: string[]) => {
    wired.delete(meetingId);
    await finishRecording(meetingId);
    const [meeting] = await db.update(meetings).set({ endedAt: new Date() }).where(eq(meetings.id, meetingId)).returning();
    if (meeting?.messageId) {
      const [msg] = await db.select().from(teamMessages).where(eq(teamMessages.id, meeting.messageId)).limit(1);
      if (msg) {
        const durationMs = meeting.startedAt ? Date.now() - meeting.startedAt.getTime() : 0;
        const [updated] = await db
          .update(teamMessages)
          .set({ meta: { ...(msg.meta ?? {}), endedAt: new Date().toISOString(), durationMs, participants } })
          .where(eq(teamMessages.id, msg.id))
          .returning();
        const [channel] = await db.select().from(channels).where(eq(channels.id, msg.channelId)).limit(1);
        if (channel) ctx.team.hub.toUsers(await channelAudience(db, channel), 'message:updated', { message: (await serialiseMessages(db, [updated!]))[0] });
      }
    }
  };

  const wire = (room: Room, meetingId: string) => {
    if (wired.has(meetingId)) return;
    wired.add(meetingId);
    const names = new Set<string>();
    const to = callRoom(meetingId);
    room.on('peer-joined', (p) => {
      names.add(p.name);
      io.to(to).emit('call:peer-joined', p);
    });
    room.on('peer-left', (id) => io.to(to).emit('call:peer-left', { peerId: id }));
    room.on('producer-added', (p) => io.to(to).emit('call:producer-added', p));
    room.on('producer-closed', (p) => io.to(to).emit('call:producer-closed', p));
    room.on('producer-paused', (p) => io.to(to).emit('call:producer-paused', p));
    room.on('consumer-closed', ({ peerId, consumerId }) => io.to(peerId).emit('call:consumer-closed', { consumerId }));
    room.once('closed', () => void meetingEnded(meetingId, [...names]).catch((err) => log.warn({ err }, 'could not end a meeting')));
  };

  const leaveCall = async (socket: Socket<never, never, never, SocketData>) => {
    const meetingId = socket.data.meetingId;
    if (!meetingId) return;
    socket.data.meetingId = null;
    void socket.leave(callRoom(meetingId));
    ctx.team.media.rooms.get(meetingId)?.leave(socket.id);
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
    const room = () => {
      const r = d.meetingId ? ctx.team.media.rooms.get(d.meetingId) : null;
      if (!r) throw new Error('You are not in a meeting');
      return r;
    };
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
      const r = ctx.team.media.rooms.get(meeting.id);
      return {
        meeting: { id: meeting.id, title: meeting.title, code: meeting.code },
        you: { name: d.name, guest: !d.userId, host: await isHost(meeting, d.userId) },
        lobby: !d.userId && !d.admitted,
        participants: r?.peerInfos().map((x) => ({ name: x.name, guest: x.guest })) ?? [],
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
      return { waiting: true, inMeeting: ctx.team.media.rooms.get(meeting.id)?.peers.size ?? 0 };
    });

    on('call:admit', async (p) => {
      const r = room();
      const me = r.peers.get(socket.id);
      if (!me || me.guest) throw new Error('Only people from the organisation can admit guests');
      const target = (await io.in(`lobby:${r.id}`).fetchSockets()).find((s) => s.id === p.guestId);
      if (!target) throw new Error('They’re no longer waiting');
      target.leave(`lobby:${r.id}`);
      if (p.admit === false) {
        target.emit('call:denied', {});
      } else {
        target.data.admitted = true;
        target.emit('call:admitted', {});
      }
      await announceLobby(r.id);
    });

    on('call:join', async (p) => {
      if (d.meetingId) throw new Error('You are already in a meeting');
      const meeting = await prepare(str(p.code, 'meeting'));
      if (!d.userId && !d.admitted) throw new Error('Wait to be admitted');
      const settings = await teamSettings(ctx, meeting.orgId);
      const r = await ctx.team.media.room(meeting.id);
      if (r.peers.size >= settings.maxParticipants) throw new Error(`This meeting is full (${settings.maxParticipants} people)`);
      wire(r, meeting.id);
      if (!meeting.startedAt || meeting.endedAt) await db.update(meetings).set({ startedAt: meeting.endedAt || !meeting.startedAt ? new Date() : meeting.startedAt, endedAt: null }).where(eq(meetings.id, meeting.id));
      // Calendar meetings: the first person from the organisation to open it hosts it.
      if (!meeting.createdBy && d.userId) await db.update(meetings).set({ createdBy: d.userId }).where(and(eq(meetings.id, meeting.id)));
      const host = await isHost({ ...meeting, createdBy: meeting.createdBy ?? d.userId }, d.userId);
      const peers = r.peerInfos();
      const you = r.join({ id: socket.id, userId: d.userId, name: d.name, guest: !d.userId, host });
      d.meetingId = meeting.id;
      d.knocking = null;
      void socket.leave(`lobby:${meeting.id}`);
      await socket.join(callRoom(meeting.id));
      if (d.userId) {
        await ctx.team.presence.setInCall(d.userId, true);
        await publishPresence(d.userId, d.orgId);
      }
      return {
        you,
        peers,
        producers: r.producers(),
        rtpCapabilities: r.rtpCapabilities,
        recording: recorders.has(meeting.id),
        recordingAllowed: settings.recording && host,
        lobby: host || d.userId ? await lobbyList(meeting.id) : [],
        meeting: { id: meeting.id, title: meeting.title, code: meeting.code, channelId: meeting.channelId },
      };
    });

    on('call:transport', async () => ({ transport: await room().createTransport(socket.id) }));
    on('call:connect', async (p) => {
      await room().connectTransport(socket.id, str(p.transportId, 'connection'), p.dtlsParameters as never);
    });
    on('call:produce', async (p) => {
      const source = p.source === 'screen' || p.source === 'cam' ? p.source : 'mic';
      const id = await room().produce(socket.id, str(p.transportId, 'connection'), p.kind === 'video' ? 'video' : 'audio', p.rtpParameters as never, source);
      return { id };
    });
    on('call:consume', async (p) => ({ consumer: await room().consume(socket.id, str(p.transportId, 'connection'), str(p.producerId, 'stream'), p.rtpCapabilities as never) }));
    on('call:resume', async (p) => {
      await room().resumeConsumer(socket.id, str(p.consumerId, 'stream'));
    });
    on('call:pause', async (p) => {
      await room().setProducerPaused(socket.id, str(p.producerId, 'stream'), p.paused === true);
    });
    on('call:close-producer', async (p) => {
      room().closeProducer(socket.id, str(p.producerId, 'stream'));
    });
    on('call:hand', async (p) => {
      const r = room();
      r.setHand(socket.id, p.raised === true);
      io.to(callRoom(r.id)).emit('call:hand', { peerId: socket.id, raised: p.raised === true });
    });
    on('call:reaction', async (p) => {
      const emoji = typeof p.emoji === 'string' && p.emoji.length <= 8 ? p.emoji : null;
      if (emoji) io.to(callRoom(room().id)).emit('call:reaction', { peerId: socket.id, emoji });
    });

    const requireHost = () => {
      const r = room();
      if (!r.peers.get(socket.id)?.host) throw new Error('Only the meeting’s organisers can do this');
      return r;
    };
    on('call:mute', async (p) => {
      const r = requireHost();
      const target = str(p.peerId, 'person');
      await r.muteAudio(target);
      io.to(target).emit('call:muted', { by: d.name });
    });
    on('call:remove', async (p) => {
      const r = requireHost();
      const target = str(p.peerId, 'person');
      if (target === socket.id) throw new Error('Leave the meeting instead');
      const s = (await io.in(callRoom(r.id)).fetchSockets()).find((x) => x.id === target);
      s?.emit('call:removed', { by: d.name });
      const local = io.sockets.sockets.get(target) as unknown as Socket<never, never, never, SocketData> | undefined;
      if (local) await leaveCall(local);
      else r.leave(target);
    });
    on('call:record', async (p) => {
      const r = requireHost();
      const [meeting] = await db.select().from(meetings).where(eq(meetings.id, r.id)).limit(1);
      if (!meeting) throw new Error('Meeting not found');
      if (p.on === true) {
        if (!(await teamSettings(ctx, meeting.orgId)).recording) throw new Error('Recording is turned off for your organisation');
        if (recorders.has(r.id)) return { recording: true };
        const recorder = new Recorder(r, recordingPath(ctx.config.volumes.team.path, r.id), { ffmpegPath: ctx.config.team.ffmpegPath, log });
        recorders.set(r.id, { recorder, by: d.userId, meeting });
        try {
          await recorder.start();
        } catch (err) {
          recorders.delete(r.id);
          throw new Error(`Recording could not start: ${(err as Error).message}`);
        }
        io.to(callRoom(r.id)).emit('call:recording', { on: true, by: d.name });
        return { recording: true };
      }
      await finishRecording(r.id);
      return { recording: false };
    });

    on('call:leave', async () => {
      await leaveCall(socket);
    });

    socket.on('disconnect', () => {
      void leaveCall(socket).catch(() => {});
      if (d.knocking) void announceLobby(d.knocking).catch(() => {});
      if (d.userId) setTimeout(() => void publishPresence(d.userId!, d.orgId).catch(() => {}), 1000);
    });
  });

  return {
    io,
    async close() {
      clearInterval(sweep);
      clearInterval(callBeat);
      for (const id of [...recorders.keys()]) await finishRecording(id).catch(() => {});
      await io.close();
      cleanups.forEach((c) => c());
    },
  };
}

export type { SocketData };
