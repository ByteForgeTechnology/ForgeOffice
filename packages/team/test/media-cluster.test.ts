import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MediaClient, MediaNode, MediaServer, memoryBus, memoryDirectory, type MeetingHost } from '../src';

const emitted: [string[], string, any][] = [];
const ended: [string, string[]][] = [];
const host: MeetingHost = {
  emit: (rooms, event, payload) => void emitted.push([rooms, event, payload]),
  meetingEnded: async (id, names) => void ended.push([id, names]),
  recordingFinished: async () => null,
  log: { warn: () => {}, info: () => {} },
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('meetings across media nodes', () => {
  const bus = memoryBus();
  const directory = memoryDirectory();
  let dir = '';
  const nodes: MediaNode[] = [];
  afterAll(async () => {
    for (const n of nodes) await n.stop().catch(() => {});
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('assigns each meeting to the least busy node and relays signalling', async () => {
    dir = await mkdtemp(join(tmpdir(), 'forge-media-'));
    for (const [i, id] of ['media-a', 'media-b'].entries()) {
      const server = new MediaServer({ listenIp: '127.0.0.1', minPort: 44000 + i * 100, maxPort: 44099 + i * 100 });
      const node = new MediaNode(id, server, bus, directory, host, { address: `10.0.0.${i + 1}`, recordingDir: dir, ffmpegPath: 'ffmpeg' });
      await node.start();
      nodes.push(node);
    }
    const client = new MediaClient(bus, directory);
    await client.start();
    expect((await directory.nodes()).map((n) => n.id).sort()).toEqual(['media-a', 'media-b']);

    // Two people in one meeting land on the same node.
    const a = await client.call<any>('m1', 'join', { peer: { id: 'sock-1', userId: 'u1', name: 'Alice', guest: false, host: true }, max: 10 });
    expect(a.you).toMatchObject({ name: 'Alice', host: true });
    expect(a.rtpCapabilities.codecs.length).toBeGreaterThan(0);
    const b = await client.call<any>('m1', 'join', { peer: { id: 'sock-2', userId: 'u2', name: 'Bob', guest: false, host: false }, max: 10 });
    expect(b.peers.map((p: { name: string }) => p.name)).toEqual(['Alice']);
    const m1Node = await directory.nodeFor('m1');
    // The next meeting goes to the other (less busy) node.
    await client.call('m2', 'join', { peer: { id: 'sock-3', userId: 'u3', name: 'Carol', guest: false, host: true }, max: 10 });
    expect(await directory.nodeFor('m2')).not.toBe(m1Node);

    // Signalling, and events for the meeting's sockets.
    const t = await client.call<any>('m1', 'transport', { peerId: 'sock-2' });
    expect(t.transport.iceCandidates[0].port).toBeGreaterThanOrEqual(44000);
    await wait(10);
    expect(emitted.some(([rooms, ev, p]) => rooms[0] === 'call:m1' && ev === 'call:peer-joined' && p.name === 'Bob')).toBe(true);
    await expect(client.call('m1', 'mute', { peerId: 'sock-2', target: 'sock-1', byName: 'Bob' })).rejects.toThrow(/organisers/);
    await expect(client.call('m1', 'join', { peer: { id: 'sock-9', userId: null, name: 'X', guest: true, host: false }, max: 2 })).rejects.toThrow(/full/);
    expect((await client.info('m1'))?.peers.length).toBe(2);
    expect((await client.live()).map((m) => m.id).sort()).toEqual(['m1', 'm2']);

    // Everyone leaves: the meeting ends and its node lets it go.
    await client.call('m1', 'leave', { peerId: 'sock-1' });
    await client.call('m1', 'leave', { peerId: 'sock-2' });
    await wait(20);
    expect(ended).toEqual([['m1', ['Alice', 'Bob']]]);
    expect(await directory.nodeFor('m1')).toBeNull();
    await expect(client.call('m1', 'transport', { peerId: 'sock-1' })).rejects.toThrow(/not in a meeting/);

    // A node that stops (or dies) loses its meetings; they start again elsewhere.
    const deadId = (await directory.nodeFor('m2'))!;
    const dead = nodes.find((n) => n.id === deadId)!;
    await dead.stop();
    expect((await directory.nodes()).map((n) => n.id)).not.toContain(deadId);
    expect(await directory.nodeFor('m2')).toBeNull();
    await client.call('m2', 'join', { peer: { id: 'sock-4', userId: 'u3', name: 'Carol', guest: false, host: true }, max: 10 });
    expect(await directory.nodeFor('m2')).not.toBe(deadId);
    await client.stop();
  }, 30_000);

  it('one port for every call (FORGE_RTC_PORT)', async () => {
    const server = new MediaServer({ listenIp: '127.0.0.1', minPort: 0, maxPort: 0, port: 45123 });
    const room = await server.room('single-port');
    room.join({ id: 'p1', userId: null, name: 'A', guest: false, host: true });
    room.join({ id: 'p2', userId: null, name: 'B', guest: false, host: false });
    const a = await room.createTransport('p1');
    const b = await room.createTransport('p2');
    expect(new Set([...a.iceCandidates, ...b.iceCandidates].map((c) => c.port))).toEqual(new Set([45123]));
    expect(new Set(a.iceCandidates.map((c) => c.protocol))).toEqual(new Set(['udp', 'tcp']));
    await server.close();
  });

  it('says so when no media server is running', async () => {
    const client = new MediaClient(memoryBus(), memoryDirectory());
    await client.start();
    await expect(client.call('m', 'join', { peer: { id: 's', userId: null, name: 'A', guest: false, host: true }, max: 5 })).rejects.toThrow(/No meeting server/);
    await client.stop();
  });
});
