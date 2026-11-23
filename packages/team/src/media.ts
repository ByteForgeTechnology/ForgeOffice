import { EventEmitter } from 'node:events';
import { cpus } from 'node:os';
import * as mediasoup from 'mediasoup';
import type { types as ms } from 'mediasoup';

/**
 * The meeting SFU (selective forwarding unit), on mediasoup: each meeting is
 * a router on a mediasoup worker; each participant sends their microphone,
 * camera and screen once and receives everyone else's. Signalling (which
 * calls these methods) is the team service's Socket.IO layer.
 */

export interface MediaConfig {
  /** Address the RTC ports listen on inside the container. */
  listenIp: string;
  /** Address browsers send media to (the host's LAN or public IP). */
  announcedIp?: string | null;
  minPort: number;
  maxPort: number;
  workers?: number;
  /**
   * One port (UDP and TCP) for every call instead of a range: worker n uses
   * port + n. Easier to open in a firewall, and needed where ranges can't be
   * published (Docker Swarm host-mode ports).
   */
  port?: number | null;
}

// Opus and VP8 everywhere (Safari included), so recordings can copy streams.
export const MEDIA_CODECS: ms.RouterRtpCodecCapability[] = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2, preferredPayloadType: 100 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: 101, parameters: { 'x-google-start-bitrate': 1000 } },
];

export type MediaSource = 'mic' | 'cam' | 'screen';

export interface PeerInfo {
  id: string;
  userId: string | null;
  name: string;
  guest: boolean;
  host: boolean;
  handRaised: boolean;
  joinedAt: number;
}

interface Peer extends PeerInfo {
  transports: Map<string, ms.WebRtcTransport>;
  producers: Map<string, ms.Producer>;
  consumers: Map<string, ms.Consumer>;
}

export interface ProducerInfo {
  id: string;
  peerId: string;
  kind: ms.MediaKind;
  source: MediaSource;
  paused: boolean;
}

export class MediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaError';
  }
}

/**
 * Events: peer-joined(PeerInfo), peer-left(peerId), producer-added(ProducerInfo),
 * producer-closed({ producerId, peerId }), producer-paused({ producerId, paused }),
 * consumer-closed({ peerId, consumerId }), closed().
 */
export class Room extends EventEmitter {
  readonly peers = new Map<string, Peer>();

  constructor(
    readonly id: string,
    readonly router: ms.Router,
    private readonly server: MediaServer,
  ) {
    super();
  }

  get rtpCapabilities() {
    return this.router.rtpCapabilities;
  }

  peerInfos(): PeerInfo[] {
    return [...this.peers.values()].map(({ transports: _t, producers: _p, consumers: _c, ...info }) => info);
  }

  producers(): ProducerInfo[] {
    return [...this.peers.values()].flatMap((p) => [...p.producers.values()].map((pr) => this.producerInfo(p, pr)));
  }

  private producerInfo(peer: Peer, pr: ms.Producer): ProducerInfo {
    return { id: pr.id, peerId: peer.id, kind: pr.kind, source: (pr.appData.source as MediaSource) ?? (pr.kind === 'audio' ? 'mic' : 'cam'), paused: pr.paused };
  }

  findProducer(producerId: string) {
    for (const peer of this.peers.values()) {
      const pr = peer.producers.get(producerId);
      if (pr) return { peer, producer: pr };
    }
    return null;
  }

  private peer(id: string) {
    const p = this.peers.get(id);
    if (!p) throw new MediaError('Not in this meeting');
    return p;
  }

  join(info: Omit<PeerInfo, 'joinedAt' | 'handRaised'>): PeerInfo {
    if (this.peers.has(info.id)) throw new MediaError('Already in this meeting');
    const peer: Peer = { ...info, handRaised: false, joinedAt: Date.now(), transports: new Map(), producers: new Map(), consumers: new Map() };
    this.peers.set(info.id, peer);
    const { transports: _t, producers: _p, consumers: _c, ...pub } = peer;
    this.emit('peer-joined', pub);
    return pub;
  }

  leave(peerId: string) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    for (const t of peer.transports.values()) t.close(); // closes its producers and consumers
    this.peers.delete(peerId);
    this.emit('peer-left', peerId);
    if (!this.peers.size) this.close();
  }

  setHand(peerId: string, raised: boolean) {
    this.peer(peerId).handRaised = raised;
  }

  async createTransport(peerId: string) {
    const peer = this.peer(peerId);
    if (peer.transports.size >= 4) throw new MediaError('Too many connections');
    const webRtcServer = this.server.webRtcServerFor(this.router);
    const transport = webRtcServer
      ? await this.router.createWebRtcTransport({ webRtcServer, enableUdp: true, enableTcp: true, preferUdp: true, initialAvailableOutgoingBitrate: 1_000_000 })
      : await this.router.createWebRtcTransport({
      listenInfos: [
        { protocol: 'udp', ip: this.server.config.listenIp, announcedAddress: this.server.config.announcedIp ?? undefined, portRange: { min: this.server.config.minPort, max: this.server.config.maxPort } },
        { protocol: 'tcp', ip: this.server.config.listenIp, announcedAddress: this.server.config.announcedIp ?? undefined, portRange: { min: this.server.config.minPort, max: this.server.config.maxPort } },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1_000_000,
    });
    peer.transports.set(transport.id, transport);
    transport.observer.on('close', () => peer.transports.delete(transport.id));
    return { id: transport.id, iceParameters: transport.iceParameters, iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters };
  }

  async connectTransport(peerId: string, transportId: string, dtlsParameters: ms.DtlsParameters) {
    const t = this.peer(peerId).transports.get(transportId);
    if (!t) throw new MediaError('Unknown connection');
    await t.connect({ dtlsParameters });
  }

  async produce(peerId: string, transportId: string, kind: ms.MediaKind, rtpParameters: ms.RtpParameters, source: MediaSource) {
    const peer = this.peer(peerId);
    const t = peer.transports.get(transportId);
    if (!t) throw new MediaError('Unknown connection');
    if ((source === 'mic') !== (kind === 'audio')) throw new MediaError('Microphones send audio; cameras and screens send video');
    // One of each source per person (a new camera replaces the old one).
    for (const pr of peer.producers.values()) if (pr.appData.source === source) this.closeProducer(peerId, pr.id);
    const producer = await t.produce({ kind, rtpParameters, appData: { source } });
    peer.producers.set(producer.id, producer);
    producer.observer.on('close', () => {
      peer.producers.delete(producer.id);
      this.emit('producer-closed', { producerId: producer.id, peerId });
    });
    this.emit('producer-added', this.producerInfo(peer, producer));
    return producer.id;
  }

  closeProducer(peerId: string, producerId: string) {
    this.peer(peerId).producers.get(producerId)?.close();
  }

  async setProducerPaused(peerId: string, producerId: string, paused: boolean) {
    const pr = this.peer(peerId).producers.get(producerId);
    if (!pr) throw new MediaError('Unknown stream');
    if (paused) await pr.pause();
    else await pr.resume();
    this.emit('producer-paused', { producerId, peerId, paused });
  }

  /** Mute someone's microphone (host action). They can unmute themselves. */
  async muteAudio(peerId: string) {
    const peer = this.peer(peerId);
    for (const pr of peer.producers.values()) if (pr.kind === 'audio' && !pr.paused) await this.setProducerPaused(peerId, pr.id, true);
  }

  /** Receive another participant's stream; starts paused until resumeConsumer. */
  async consume(peerId: string, transportId: string, producerId: string, rtpCapabilities: ms.RtpCapabilities) {
    const peer = this.peer(peerId);
    const t = peer.transports.get(transportId);
    if (!t) throw new MediaError('Unknown connection');
    const found = this.findProducer(producerId);
    if (!found) throw new MediaError('That stream has ended');
    if (found.peer.id === peerId) throw new MediaError('That is your own stream');
    if (!this.router.canConsume({ producerId, rtpCapabilities })) throw new MediaError('Your browser cannot receive this stream');
    const consumer = await t.consume({ producerId, rtpCapabilities, paused: true });
    peer.consumers.set(consumer.id, consumer);
    const gone = () => {
      if (!peer.consumers.delete(consumer.id)) return;
      this.emit('consumer-closed', { peerId, consumerId: consumer.id });
    };
    consumer.on('producerclose', gone);
    consumer.observer.on('close', gone);
    return {
      id: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      producerPaused: consumer.producerPaused,
      source: found.producer.appData.source as MediaSource,
      peerId: found.peer.id,
    };
  }

  async resumeConsumer(peerId: string, consumerId: string) {
    const c = this.peer(peerId).consumers.get(consumerId);
    if (!c) throw new MediaError('Unknown stream');
    await c.resume();
    if (c.kind === 'video') await c.requestKeyFrame();
  }

  close() {
    if (this.router.closed) return;
    for (const peer of this.peers.values()) for (const t of peer.transports.values()) t.close();
    this.peers.clear();
    this.router.close();
    this.server.rooms.delete(this.id);
    this.emit('closed');
  }
}

export class MediaServer {
  readonly rooms = new Map<string, Room>();
  private workers: ms.Worker[] = [];
  private readonly webRtcServers = new Map<ms.Worker, ms.WebRtcServer>();
  private readonly routerWorker = new WeakMap<ms.Router, ms.Worker>();
  private next = 0;
  private starting: Promise<void> | null = null;
  private pending = new Map<string, Promise<Room>>();

  constructor(
    readonly config: MediaConfig,
    private readonly log: { error: (o: unknown, m?: string) => void } = console,
  ) {}

  /** Workers start on first use, so services that never host a meeting stay light. */
  private async ensureWorkers() {
    if (this.workers.length) return;
    this.starting ??= (async () => {
      const count = Math.max(1, Math.min(this.config.workers ?? 1, cpus().length));
      for (let i = 0; i < count; i++) {
        const worker = await mediasoup.createWorker({ logLevel: 'warn' });
        if (this.config.port) {
          const port = this.config.port + i;
          const listen = (protocol: 'udp' | 'tcp') => ({ protocol, ip: this.config.listenIp, announcedAddress: this.config.announcedIp ?? undefined, port });
          this.webRtcServers.set(worker, await worker.createWebRtcServer({ listenInfos: [listen('udp'), listen('tcp')] }));
        }
        worker.on('died', (err) => {
          this.log.error({ err }, 'mediasoup worker died; its meetings ended');
          this.workers = this.workers.filter((w) => w !== worker);
          for (const room of this.rooms.values()) if (room.router.closed) room.close();
        });
        this.workers.push(worker);
      }
    })();
    await this.starting;
    this.starting = null;
  }

  async room(id: string): Promise<Room> {
    const existing = this.rooms.get(id);
    if (existing && !existing.router.closed) return existing;
    let p = this.pending.get(id);
    if (!p) {
      p = (async () => {
        await this.ensureWorkers();
        const worker = this.workers[this.next++ % this.workers.length]!;
        const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
        this.routerWorker.set(router, worker);
        const room = new Room(id, router, this);
        this.rooms.set(id, room);
        return room;
      })().finally(() => this.pending.delete(id));
      this.pending.set(id, p);
    }
    return p;
  }

  /** The single-port server of the worker running this router (FORGE_RTC_PORT), if any. */
  webRtcServerFor(router: ms.Router) {
    const w = this.routerWorker.get(router);
    return w ? (this.webRtcServers.get(w) ?? null) : null;
  }

  async close() {
    for (const r of [...this.rooms.values()]) r.close();
    for (const w of this.workers) w.close();
    this.workers = [];
  }
}
