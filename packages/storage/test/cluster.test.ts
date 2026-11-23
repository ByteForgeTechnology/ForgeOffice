import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClusterKeyedStore, ClusterStore, ClusterUploadStore, createStoreNode, staticRegistry, type ReplicaIndex, type StoreNode, type StoreNodeInfo } from '../src';

const TOKEN = 'test-token-0123456789';
let dir: string;
const nodes: { node: StoreNode; url: string; root: string }[] = [];

/** An in-memory replica index (the database table, in production). */
const index = (): ReplicaIndex & { rows: Set<string> } => {
  const rows = new Set<string>();
  return {
    rows,
    async locations(ns, sha) {
      return [...rows].filter((r) => r.startsWith(`${ns}:${sha}:`)).map((r) => r.split(':')[2]!);
    },
    async add(ns, sha, node) {
      rows.add(`${ns}:${sha}:${node}`);
    },
    async remove(ns, sha, node) {
      for (const r of [...rows]) if (r.startsWith(`${ns}:${sha}:${node ?? ''}`)) rows.delete(r);
    },
  };
};

/** A registry over the test nodes, where nodes can be "down". */
const down = new Set<string>();
const registry = () => {
  const inner = staticRegistry(nodes.map((n) => n.url), TOKEN);
  return { nodes: async () => (await inner.nodes()).filter((n: StoreNodeInfo) => !down.has(n.id)) };
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-store-'));
  for (let i = 0; i < 3; i++) {
    const root = join(dir, `node${i}`);
    const node = await createStoreNode({
      token: TOKEN,
      idFile: join(root, 'node-id'),
      namespaces: { mail: { blobs: join(root, 'mail', 'blobs') }, drive: { blobs: join(root, 'drive', 'blobs'), objects: { root: join(root, 'drive', '.previews'), suffix: '.webp' }, uploads: join(root, 'drive', '.uploads') } },
      maxBytes: 1024 * 1024,
    });
    await new Promise<void>((r) => node.server.listen(0, '127.0.0.1', r));
    nodes.push({ node, url: `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`, root });
  }
});

afterAll(async () => {
  for (const n of nodes) n.node.server.close();
  await rm(dir, { recursive: true, force: true });
});

describe('storage cluster', () => {
  it('keeps two copies of each blob, and reads survive a node going down', async () => {
    const idx = index();
    const store = new ClusterStore('drive', { registry: registry(), token: TOKEN, replicas: 2, index: idx, minFreeBytes: 0 });
    const data = Buffer.from('hello cluster');
    const put = await store.put(Readable.from([data]));
    expect(put.sha256).toBe(createHash('sha256').update(data).digest('hex'));
    const where = await idx.locations('drive', put.sha256);
    expect(where).toHaveLength(2);
    expect(new Set(where).size).toBe(2);

    // Either copy's node can go down.
    down.add(where[0]!);
    expect((await store.read(put.sha256)).toString()).toBe('hello cluster');
    const chunks: Buffer[] = [];
    for await (const c of store.createReadStream(put.sha256, { start: 6, end: 12 })) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('cluster');
    expect(await store.size(put.sha256)).toBe(13);
    down.clear();

    // The same content again: no new copies needed.
    await store.put(data);
    expect(await idx.locations('drive', put.sha256)).toHaveLength(2);

    expect(await store.delete(put.sha256)).toBe(true);
    expect(await store.exists(put.sha256)).toBe(false);
    expect(idx.rows.size).toBe(0);
    await expect(store.read(put.sha256)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.put(Buffer.alloc(2048), { maxBytes: 1000 })).rejects.toThrow(/at most|limit|1000/);
  });

  it('finds blobs written before the index knew about them', async () => {
    // Written straight to one node's disk, as an older single mail-store would have.
    const data = Buffer.from('legacy message');
    const sha = createHash('sha256').update(data).digest('hex');
    const p = join(nodes[2]!.root, 'mail', 'blobs', sha.slice(0, 2), sha.slice(2, 4));
    await mkdir(p, { recursive: true });
    await writeFile(join(p, sha), data);
    const store = new ClusterStore('mail', { registry: registry(), token: TOKEN, index: index(), minFreeBytes: 0 });
    expect((await store.read(sha)).toString()).toBe('legacy message');
    const listed = await store.list((await registry().nodes()).find((n) => n.id === nodes[2]!.node.id)!);
    expect(listed).toContain(sha);
  });

  it('older mail clients still use /blobs', async () => {
    const res = await fetch(`${nodes[0]!.url}/blobs`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}` }, body: Buffer.from('From: x\r\n\r\nhi') });
    expect(res.status).toBeLessThan(300);
    expect((await fetch(`${nodes[0]!.url}/blobs`, { method: 'PUT', body: 'x' })).status).toBe(401);
  });

  it('previews: on the nodes the key hashes to', async () => {
    const keyed = new ClusterKeyedStore('drive', { registry: registry(), token: TOKEN, replicas: 2 });
    const key = 'a'.repeat(64);
    await keyed.put(key, Buffer.from('webp!'));
    expect((await keyed.get(key))?.toString()).toBe('webp!');
    await keyed.delete(key);
    expect(await keyed.get(key)).toBeNull();
  });

  it('uploads: chunks to one node, resumable, then a replicated blob', async () => {
    const idx = index();
    const opts = { registry: registry(), token: TOKEN, replicas: 2, index: idx, minFreeBytes: 0 };
    const store = new ClusterStore('drive', opts);
    const uploads = new ClusterUploadStore('drive', store, opts);
    const id = 'upload-0001';
    expect(await uploads.size(id)).toBe(0);
    expect(await uploads.append(id, 0, Readable.from([Buffer.from('part one, ')]), 100)).toBe(10);
    await expect(uploads.append(id, 0, Readable.from([Buffer.from('again')]), 100)).rejects.toMatchObject({ name: 'OffsetMismatchError', expected: 10 });
    expect(await uploads.size(id)).toBe(10);
    expect(await uploads.append(id, 10, Readable.from([Buffer.from('part two')]), 100)).toBe(18);
    const done = await uploads.commit(id);
    expect(done.size).toBe(18);
    expect((await store.read(done.sha256)).toString()).toBe('part one, part two');
    expect(await idx.locations('drive', done.sha256)).toHaveLength(2);
    expect(await uploads.size(id)).toBe(0);
  });

  it('snapshots a node’s namespace for backups', async () => {
    const store = new ClusterStore('mail', { registry: registry(), token: TOKEN, minFreeBytes: 0 });
    const node = (await registry().nodes()).find((n) => n.id === nodes[0]!.node.id)!;
    const chunks: Buffer[] = [];
    for await (const c of await store.snapshot(node)) chunks.push(c as Buffer);
    const gz = Buffer.concat(chunks);
    expect(gz.subarray(0, 2).toString('hex')).toBe('1f8b');
  });
});
