import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { types as ms } from 'mediasoup';
import { MediaServer, Recorder, type Room } from '../src';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const senders: ChildProcess[] = [];
let dir = '';

/**
 * A participant without a browser: FFmpeg sends a test tone or test video as
 * RTP into a plain transport, which becomes a producer of that participant.
 */
async function fakeProducer(room: Room, peerId: string, kind: 'audio' | 'video', ssrc: number, source: 'mic' | 'cam' | 'screen') {
  // FFmpeg sends RTCP from its own port, so RTCP gets its own port here (with comedia).
  const transport: ms.PlainTransport = await room.router.createPlainTransport({ listenInfo: { protocol: 'udp', ip: '127.0.0.1' }, rtcpMux: false, comedia: true });
  const port = transport.tuple.localPort;
  const rtcpPort = transport.rtcpTuple!.localPort;
  const audio = kind === 'audio';
  const producer = await transport.produce({
    kind,
    rtpParameters: audio
      ? { codecs: [{ mimeType: 'audio/opus', payloadType: 100, clockRate: 48000, channels: 2, parameters: { 'sprop-stereo': 1 } }], encodings: [{ ssrc }] }
      : { codecs: [{ mimeType: 'video/VP8', payloadType: 101, clockRate: 90000 }], encodings: [{ ssrc }] },
    appData: { source },
  });
  const input = audio ? ['-f', 'lavfi', '-i', `sine=frequency=${300 + (ssrc % 500)}:sample_rate=48000`] : ['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=15'];
  const codec = audio ? ['-c:a', 'libopus', '-ac', '2', '-ar', '48000', '-payload_type', '100'] : ['-c:v', 'libvpx', '-deadline', 'realtime', '-b:v', '400k', '-g', '15', '-payload_type', '101'];
  senders.push(spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', ...input, ...codec, '-ssrc', String(ssrc), '-f', 'rtp', `rtp://127.0.0.1:${port}?rtcpport=${rtcpPort}`], { stdio: 'ignore' }));
  // Register it as the participant's stream, as Room.produce does for browsers.
  const peer = room.peers.get(peerId)!;
  peer.producers.set(producer.id, producer);
  producer.observer.on('close', () => {
    peer.producers.delete(producer.id);
    room.emit('producer-closed', { producerId: producer.id, peerId });
  });
  room.emit('producer-added', { id: producer.id, peerId, kind, source, paused: false });
  return producer;
}

const probe = (file: string) => {
  const out = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  return JSON.parse(out.stdout) as { streams: { codec_type: string; codec_name: string }[]; format: { duration: string } };
};

afterAll(async () => {
  for (const s of senders) s.kill('SIGKILL');
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!hasFfmpeg)('ForgeTeam SFU', () => {
  const server = new MediaServer({ listenIp: '127.0.0.1', minPort: 42000, maxPort: 42200 });
  afterAll(() => server.close());

  it('joins, forwards streams, records (across a change of speakers) and closes when empty', async () => {
    dir = await mkdtemp(join(tmpdir(), 'forge-team-'));
    const room = await server.room('meeting-1');
    expect(await server.room('meeting-1')).toBe(room);
    const events: string[] = [];
    room.on('peer-joined', (p) => events.push(`joined ${p.name}`));
    room.on('peer-left', (id) => events.push(`left ${id}`));

    room.join({ id: 'a', userId: 'u-a', name: 'Alice', guest: false, host: true });
    room.join({ id: 'b', userId: null, name: 'Guest Bob', guest: true, host: false });
    expect(() => room.join({ id: 'a', userId: 'u-a', name: 'Alice', guest: false, host: true })).toThrow(/Already/);

    // Browsers get a WebRTC transport with ICE candidates on the configured ports.
    const t = await room.createTransport('b');
    expect(t.iceCandidates.length).toBeGreaterThan(0);
    expect(t.iceCandidates.every((c) => c.port >= 42000 && c.port <= 42200)).toBe(true);

    const mic = await fakeProducer(room, 'a', 'audio', 11111, 'mic');
    await fakeProducer(room, 'a', 'video', 22222, 'cam');
    expect(room.producers().map((p) => [p.peerId, p.source])).toEqual([
      ['a', 'mic'],
      ['a', 'cam'],
    ]);

    // Bob receives Alice's microphone (paused until he asks for it).
    const consumer = await room.consume('b', t.id, mic.id, room.rtpCapabilities);
    expect(consumer).toMatchObject({ kind: 'audio', producerId: mic.id, peerId: 'a', source: 'mic' });
    await room.resumeConsumer('b', consumer.id);
    await expect(room.consume('a', t.id, mic.id, room.rtpCapabilities)).rejects.toThrow(/Unknown connection/);

    // Host mutes Alice: her microphone is paused for everyone.
    await room.muteAudio('a');
    expect(room.producers().find((p) => p.id === mic.id)?.paused).toBe(true);
    await room.setProducerPaused('a', mic.id, false);

    const out = join(dir, 'recordings', 'meeting-1.webm');
    const recorder = new Recorder(room, out);
    await recorder.start();
    await new Promise((r) => setTimeout(r, 3500));
    // Bob starts talking: a new segment with both voices.
    await fakeProducer(room, 'b', 'audio', 33333, 'mic');
    await new Promise((r) => setTimeout(r, 5000));
    const result = await recorder.stop();
    expect(result.path).toBe(out);
    expect((await stat(out)).size).toBeGreaterThan(10_000);
    const info = probe(out);
    expect(info.streams.map((s) => `${s.codec_type}:${s.codec_name}`).sort()).toEqual(['audio:opus', 'video:vp8']);
    expect(Number(info.format.duration)).toBeGreaterThan(4);

    room.leave('a');
    room.leave('b');
    expect(events).toEqual(['joined Alice', 'joined Guest Bob', 'left a', 'left b']);
    expect(room.router.closed).toBe(true);
    expect(server.rooms.size).toBe(0);
  }, 60_000);
});
