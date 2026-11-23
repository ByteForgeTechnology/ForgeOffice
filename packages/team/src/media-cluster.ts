import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Redis } from 'ioredis';
import { MediaError, MediaServer, type PeerInfo, type Room } from './media';
import { Recorder } from './recorder';

/**
 * Meetings across several media servers. Each meeting's room lives on one
 * media node (assigned when the first person joins: the least busy live
 * node); the team service's sockets send that meeting's signalling to it as
 * request/reply messages on a bus (Redis pub/sub; in memory in a single
 * process), and the node sends room events straight to Socket.IO rooms
 * (call:<meeting id>, or one person's socket id).
 */

// ---------------------------------------------------------------------------
// Bus and directory (Redis, or in memory for one process)
// ---------------------------------------------------------------------------

export interface MediaBus {
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, onMessage: (message: string) => void): Promise<() => Promise<void>>;
}

export function memoryBus(): MediaBus {
  const subs = new Map<string, Set<(m: string) => void>>();
  return {
    async publish(channel, message) {
      // Asynchronous, like Redis.
      for (const fn of subs.get(channel) ?? []) queueMicrotask(() => fn(message));
    },
    async subscribe(channel, fn) {
      if (!subs.has(channel)) subs.set(channel, new Set());
      subs.get(channel)!.add(fn);
      return async () => void subs.get(channel)?.delete(fn);
    },
  };
}

/** `pub` publishes; `sub` must be a connection used only for subscribing. */
export function redisBus(pub: Pick<Redis, 'publish'>, sub: Redis): MediaBus {
  const handlers = new Map<string, Set<(m: string) => void>>();
  sub.on('message', (channel: string, message: string) => handlers.get(channel)?.forEach((fn) => fn(message)));
  return {
    async publish(channel, message) {
      await pub.publish(channel, message);
    },
    async subscribe(channel, fn) {
      if (!handlers.has(channel)) {
        handlers.set(channel, new Set());
        await sub.subscribe(channel);
      }
      handlers.get(channel)!.add(fn);
      return async () => {
        handlers.get(channel)?.delete(fn);
        if (!handlers.get(channel)?.size) {
          handlers.delete(channel);
          await sub.unsubscribe(channel);
        }
      };
    },
  };
}

export interface MediaNodeRecord {
  id: string;
  /** The address browsers send media to. */
  address: string | null;
  peers: number;
  meetings: { id: string; peers: number; guests: number; recording: boolean }[];
  seenAt: number;
}

/** Live media nodes, and which node hosts which meeting. */
export interface MediaDirectory {
  nodes(): Promise<MediaNodeRecord[]>;
  heartbeat(rec: MediaNodeRecord): Promise<void>;
  /** The node hosting a meeting, if any (and it is alive). */
  nodeFor(meetingId: string): Promise<string | null>;
  /** Claim a meeting for a node; returns the node that has it (another may have been first). */
  assign(meetingId: string, nodeId: string): Promise<string>;
  release(meetingId: string, nodeId: string): Promise<void>;
  /** A node going away on purpose (its meetings move elsewhere straight away). */
  forget(nodeId: string): Promise<void>;
}

const NODE_TTL_S = 15;
const MEETING_TTL_S = 60;

export function memoryDirectory(): MediaDirectory {
  const nodes = new Map<string, MediaNodeRecord>();
  const meetings = new Map<string, string>();
  const alive = (id: string) => {
    const n = nodes.get(id);
    return !!n && Date.now() - n.seenAt < NODE_TTL_S * 1000;
  };
  return {
    async nodes() {
      return [...nodes.values()].filter((n) => alive(n.id));
    },
    async heartbeat(rec) {
      nodes.set(rec.id, rec);
    },
    async nodeFor(meetingId) {
      const id = meetings.get(meetingId);
      return id && alive(id) ? id : null;
    },
    async assign(meetingId, nodeId) {
      const current = meetings.get(meetingId);
      if (current && alive(current)) return current;
      meetings.set(meetingId, nodeId);
      return nodeId;
    },
    async release(meetingId, nodeId) {
      if (meetings.get(meetingId) === nodeId) meetings.delete(meetingId);
    },
    async forget(nodeId) {
      nodes.delete(nodeId);
    },
  };
}

export function redisDirectory(redis: Redis): MediaDirectory {
  const nodeKey = (id: string) => `forge:media:node:${id}`;
  const meetingKey = (id: string) => `forge:media:meeting:${id}`;
  const alive = async (id: string) => (await redis.exists(nodeKey(id))) === 1;
  return {
    async nodes() {
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [next, batch] = await redis.scan(cursor, 'MATCH', 'forge:media:node:*', 'COUNT', 200);
        cursor = next;
        keys.push(...batch);
      } while (cursor !== '0');
      const values = keys.length ? await redis.mget(keys) : [];
      return values.filter(Boolean).map((v) => JSON.parse(v!) as MediaNodeRecord);
    },
    async heartbeat(rec) {
      await redis.set(nodeKey(rec.id), JSON.stringify(rec), 'EX', NODE_TTL_S);
      // Keep this node's meetings assigned to it.
      for (const m of rec.meetings) await redis.set(meetingKey(m.id), rec.id, 'EX', MEETING_TTL_S);
    },
    async nodeFor(meetingId) {
      const id = await redis.get(meetingKey(meetingId));
      return id && (await alive(id)) ? id : null;
    },
    async assign(meetingId, nodeId) {
      const ok = await redis.set(meetingKey(meetingId), nodeId, 'EX', MEETING_TTL_S, 'NX');
      if (ok) return nodeId;
      const current = await redis.get(meetingKey(meetingId));
      if (current && (await alive(current))) return current;
      // Its node is gone: the meeting starts again here.
      await redis.set(meetingKey(meetingId), nodeId, 'EX', MEETING_TTL_S);
      return nodeId;
    },
    async release(meetingId, nodeId) {
      if ((await redis.get(meetingKey(meetingId))) === nodeId) await redis.del(meetingKey(meetingId));
    },
    async forget(nodeId) {
      await redis.del(nodeKey(nodeId));
    },
  };
}

// ---------------------------------------------------------------------------
// The media node
// ---------------------------------------------------------------------------

/** What a node needs from ForgeOffice: sending events to sockets, and saving meetings. */
export interface MeetingHost {
  /** Send an event to Socket.IO rooms (call:<meeting>, or a socket id). */
  emit(rooms: string[], event: string, payload: unknown): void;
  /** The last person left: record it (the meeting's card, duration, who came). */
  meetingEnded(meetingId: string, participants: string[]): Promise<void>;
  /** Store a finished recording (the file is removed afterwards); returns its id. */
  recordingFinished(input: { meetingId: string; file: string; durationMs: number; size: number; startedBy: string | null }): Promise<string | null>;
  log: { warn: (o: unknown, m?: string) => void; info: (o: unknown, m?: string) => void };
}

export interface JoinResult {
  you: PeerInfo;
  peers: PeerInfo[];
  producers: ReturnType<Room['producers']>;
  rtpCapabilities: Room['rtpCapabilities'];
  recording: boolean;
}

type Handler = (args: Record<string, any>) => Promise<unknown>;

export class MediaNode {
  private readonly recorders = new Map<string, { recorder: Recorder; by: string | null }>();
  private readonly names = new Map<string, Set<string>>();
  private stopFns: (() => unknown)[] = [];
  private stopped = false;
  private readonly handlers: Record<string, Handler>;

  constructor(
    readonly id: string,
    private readonly server: MediaServer,
    private readonly bus: MediaBus,
    private readonly directory: MediaDirectory,
    private readonly host: MeetingHost,
    private readonly opts: { address: string | null; recordingDir: string; ffmpegPath: string },
  ) {
    const room = (meetingId: string) => {
      const r = this.server.rooms.get(meetingId);
      if (!r) throw new MediaError('You are not in a meeting');
      return r;
    };
    const isHost = (r: Room, peerId: string) => {
      if (!r.peers.get(peerId)?.host) throw new MediaError('Only the meeting’s organisers can do this');
    };
    this.handlers = {
      join: async ({ meetingId, peer, max }) => {
        const r = await this.server.room(meetingId);
        this.wire(r, meetingId);
        if (r.peers.size >= max) throw new MediaError(`This meeting is full (${max} people)`);
        const peers = r.peerInfos();
        const you = r.join(peer);
        this.names.get(meetingId)?.add(peer.name);
        void this.beat();
        return { you, peers, producers: r.producers(), rtpCapabilities: r.rtpCapabilities, recording: this.recorders.has(meetingId) } satisfies JoinResult;
      },
      leave: async ({ meetingId, peerId }) => {
        this.server.rooms.get(meetingId)?.leave(peerId);
        return {};
      },
      info: async ({ meetingId }) => {
        const r = this.server.rooms.get(meetingId);
        return r ? { peers: r.peerInfos(), recording: this.recorders.has(meetingId) } : null;
      },
      peer: async ({ meetingId, peerId }) => this.server.rooms.get(meetingId)?.peerInfos().find((p) => p.id === peerId) ?? null,
      transport: async ({ meetingId, peerId }) => ({ transport: await room(meetingId).createTransport(peerId) }),
      connect: async ({ meetingId, peerId, transportId, dtlsParameters }) => {
        await room(meetingId).connectTransport(peerId, transportId, dtlsParameters);
        return {};
      },
      produce: async ({ meetingId, peerId, transportId, kind, rtpParameters, source }) => ({ id: await room(meetingId).produce(peerId, transportId, kind, rtpParameters, source) }),
      consume: async ({ meetingId, peerId, transportId, producerId, rtpCapabilities }) => ({ consumer: await room(meetingId).consume(peerId, transportId, producerId, rtpCapabilities) }),
      resume: async ({ meetingId, peerId, consumerId }) => {
        await room(meetingId).resumeConsumer(peerId, consumerId);
        return {};
      },
      pause: async ({ meetingId, peerId, producerId, paused }) => {
        await room(meetingId).setProducerPaused(peerId, producerId, paused);
        return {};
      },
      closeProducer: async ({ meetingId, peerId, producerId }) => {
        room(meetingId).closeProducer(peerId, producerId);
        return {};
      },
      hand: async ({ meetingId, peerId, raised }) => {
        room(meetingId).setHand(peerId, raised);
        this.host.emit([`call:${meetingId}`], 'call:hand', { peerId, raised });
        return {};
      },
      reaction: async ({ meetingId, peerId, emoji }) => {
        room(meetingId);
        this.host.emit([`call:${meetingId}`], 'call:reaction', { peerId, emoji });
        return {};
      },
      mute: async ({ meetingId, peerId, target, byName }) => {
        const r = room(meetingId);
        isHost(r, peerId);
        await r.muteAudio(target);
        this.host.emit([target], 'call:muted', { by: byName });
        return {};
      },
      remove: async ({ meetingId, peerId, target, byName }) => {
        const r = room(meetingId);
        isHost(r, peerId);
        if (target === peerId) throw new MediaError('Leave the meeting instead');
        this.host.emit([target], 'call:removed', { by: byName });
        r.leave(target);
        return {};
      },
      record: async ({ meetingId, peerId, on, byName, userId }) => {
        const r = room(meetingId);
        isHost(r, peerId);
        if (!on) {
          await this.finishRecording(meetingId);
          return { recording: false };
        }
        if (this.recorders.has(meetingId)) return { recording: true };
        await mkdir(this.opts.recordingDir, { recursive: true });
        const recorder = new Recorder(r, join(this.opts.recordingDir, `${meetingId}-${Date.now()}.webm`), { ffmpegPath: this.opts.ffmpegPath, log: this.host.log });
        this.recorders.set(meetingId, { recorder, by: userId ?? null });
        try {
          await recorder.start();
        } catch (err) {
          this.recorders.delete(meetingId);
          throw new MediaError(`Recording could not start: ${(err as Error).message}`);
        }
        this.host.emit([`call:${meetingId}`], 'call:recording', { on: true, by: byName });
        return { recording: true };
      },
    };
  }

  private wire(r: Room, meetingId: string) {
    if (this.names.has(meetingId)) return;
    this.names.set(meetingId, new Set());
    const to = [`call:${meetingId}`];
    r.on('peer-joined', (p) => this.host.emit(to, 'call:peer-joined', p));
    r.on('peer-left', (id) => this.host.emit(to, 'call:peer-left', { peerId: id }));
    r.on('producer-added', (p) => this.host.emit(to, 'call:producer-added', p));
    r.on('producer-closed', (p) => this.host.emit(to, 'call:producer-closed', p));
    r.on('producer-paused', (p) => this.host.emit(to, 'call:producer-paused', p));
    r.on('consumer-closed', ({ peerId, consumerId }) => this.host.emit([peerId], 'call:consumer-closed', { consumerId }));
    r.once('closed', () => {
      const participants = [...(this.names.get(meetingId) ?? [])];
      this.names.delete(meetingId);
      void (async () => {
        await this.finishRecording(meetingId);
        await this.directory.release(meetingId, this.id);
        await this.host.meetingEnded(meetingId, participants);
        await this.beat();
      })().catch((err) => this.host.log.warn({ err, meetingId }, 'could not end a meeting'));
    });
  }

  private async finishRecording(meetingId: string) {
    const r = this.recorders.get(meetingId);
    if (!r) return;
    this.recorders.delete(meetingId);
    try {
      const result = await r.recorder.stop();
      const size = (await stat(result.path)).size;
      const recordingId = await this.host.recordingFinished({ meetingId, file: result.path, durationMs: result.durationMs, size, startedBy: r.by });
      this.host.emit([`call:${meetingId}`], 'call:recording', { on: false, recordingId });
    } catch (err) {
      this.host.log.warn({ err, meetingId }, 'could not save a meeting recording');
      this.host.emit([`call:${meetingId}`], 'call:recording', { on: false, error: 'The recording could not be saved' });
    }
  }

  /** Tell the directory this node is alive, how busy it is, and which meetings it hosts. */
  async beat() {
    // Rooms closing while stopping must not make a stopped node look alive again.
    if (this.stopped) return;
    const meetings = [...this.server.rooms.values()].map((r) => ({ id: r.id, peers: r.peers.size, guests: r.peerInfos().filter((p) => p.guest).length, recording: this.recorders.has(r.id) }));
    await this.directory.heartbeat({ id: this.id, address: this.opts.address, peers: meetings.reduce((a, m) => a + m.peers, 0), meetings, seenAt: Date.now() });
  }

  async start() {
    const unsubscribe = await this.bus.subscribe(`forge:media:rpc:${this.id}`, (raw) => void this.handle(raw));
    this.stopFns.push(unsubscribe);
    await this.beat();
    const t = setInterval(() => void this.beat().catch((err) => this.host.log.warn({ err }, 'media node heartbeat failed')), 5000);
    t.unref();
    this.stopFns.push(() => clearInterval(t));
  }

  private async handle(raw: string) {
    let req: { id: string; replyTo: string; method: string; args: Record<string, unknown> };
    try {
      req = JSON.parse(raw);
    } catch {
      return;
    }
    const reply = (body: Record<string, unknown>) => this.bus.publish(req.replyTo, JSON.stringify({ id: req.id, ...body }));
    const fn = this.handlers[req.method];
    try {
      if (!fn) throw new MediaError(`Unknown request ${req.method}`);
      await reply({ ok: true, result: (await fn(req.args)) ?? null });
    } catch (err) {
      await reply({ ok: false, error: (err as Error).message, media: err instanceof MediaError });
    }
  }

  async stop() {
    this.stopped = true;
    for (const id of [...this.recorders.keys()]) await this.finishRecording(id).catch(() => {});
    for (const fn of this.stopFns.splice(0)) await fn();
    await this.directory.forget(this.id).catch(() => {});
    await this.server.close();
  }
}

// ---------------------------------------------------------------------------
// The client (in the team service)
// ---------------------------------------------------------------------------

export class MediaClient {
  private readonly instance = `forge:media:reply:${randomUUID()}`;
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private unsubscribe: (() => Promise<void>) | null = null;

  constructor(
    /** Shared with a media node in the same process (no Redis). */
    readonly bus: MediaBus,
    readonly directory: MediaDirectory,
    private readonly timeoutMs = 15_000,
  ) {}

  async start() {
    this.unsubscribe = await this.bus.subscribe(this.instance, (raw) => {
      const res = JSON.parse(raw) as { id: string; ok: boolean; result?: unknown; error?: string; media?: boolean };
      const p = this.pending.get(res.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(res.id);
      if (res.ok) p.resolve(res.result);
      else p.reject(res.media ? new MediaError(res.error ?? 'Meeting error') : new Error(res.error ?? 'Meeting error'));
    });
  }

  async stop() {
    await this.unsubscribe?.();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Shutting down'));
    }
    this.pending.clear();
  }

  /** The node for a meeting; with `create`, assigns the least busy live node if it has none. */
  async nodeFor(meetingId: string, create = false): Promise<string | null> {
    const current = await this.directory.nodeFor(meetingId);
    if (current || !create) return current;
    const nodes = await this.directory.nodes();
    if (!nodes.length) throw new MediaError('No meeting server is running. Ask your administrator to check the media service.');
    const least = Math.min(...nodes.map((n) => n.peers));
    const candidates = nodes.filter((n) => n.peers === least);
    const pick = candidates[Math.floor(Math.random() * candidates.length)]!;
    return this.directory.assign(meetingId, pick.id);
  }

  async call<T = Record<string, unknown>>(meetingId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
    const node = await this.nodeFor(meetingId, method === 'join');
    if (!node) throw new MediaError('You are not in a meeting');
    const id = randomUUID();
    const result = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new MediaError('The meeting server did not answer'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    });
    await this.bus.publish(`forge:media:rpc:${node}`, JSON.stringify({ id, replyTo: this.instance, method, args: { ...args, meetingId } }));
    return result;
  }

  /** People in a meeting right now (empty if it isn't running). */
  async info(meetingId: string): Promise<{ peers: PeerInfo[]; recording: boolean } | null> {
    if (!(await this.directory.nodeFor(meetingId))) return null;
    return this.call<{ peers: PeerInfo[]; recording: boolean } | null>(meetingId, 'info').catch(() => null);
  }

  /** Meetings happening now, across every node. */
  async live() {
    return (await this.directory.nodes()).flatMap((n) => n.meetings.map((m) => ({ ...m, node: n.id })));
  }
}

/** Where a node keeps recordings while they're being made (removed once stored). */
export const recordingTempDir = (teamVolume: string) => join(teamVolume, 'recording-tmp');
export const removeQuietly = (path: string) => rm(path, { force: true }).catch(() => {});
