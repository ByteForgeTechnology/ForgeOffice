import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectDatabase, replicaIndex, type DatabaseHandle } from '@forge/db';
import { ClusterStore, createStoreNode, staticRegistry, type StorageSetup, type StoreNode, type StoreNodeInfo } from '@forge/storage';
import { repairStorage } from '../src/processors/storage';

const TOKEN = 'repair-test-token';
let handle: DatabaseHandle;
let dir: string;
const nodes: StoreNode[] = [];
const urls: string[] = [];
const draining = new Set<string>();
const kv = new Map<string, string>();
const redis = { get: async (k: string) => kv.get(k) ?? null, set: async (k: string, v: string) => (kv.set(k, v), 'OK') };
const log = { info: () => {}, warn: () => {} };

beforeAll(async () => {
  handle = await connectDatabase('pglite://memory');
  await handle.migrate(fileURLToPath(new URL('../../../packages/db/drizzle', import.meta.url)));
  dir = await mkdtemp(join(tmpdir(), 'forge-repair-'));
  for (let i = 0; i < 3; i++) {
    const node = await createStoreNode({ token: TOKEN, idFile: join(dir, `n${i}`, 'id'), namespaces: { drive: { blobs: join(dir, `n${i}`, 'drive') } } });
    await new Promise<void>((r) => node.server.listen(0, '127.0.0.1', r));
    nodes.push(node);
    urls.push(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`);
  }
});

afterAll(async () => {
  for (const n of nodes) n.server.close();
  await handle.close();
  await rm(dir, { recursive: true, force: true });
});

/** A storage setup over some of the nodes (the others "not yet added"). */
function setupWith(count: number): StorageSetup {
  const base = staticRegistry(urls.slice(0, count), TOKEN);
  const registry = { nodes: async () => (await base.nodes()).map((n: StoreNodeInfo) => ({ ...n, draining: draining.has(n.id) })) };
  const opts = { registry, token: TOKEN, replicas: 2, index: replicaIndex(handle.db), minFreeBytes: 0 };
  const drive = new ClusterStore('drive', opts);
  return { mode: 'cluster', registry, cluster: { drive, mail: new ClusterStore('mail', opts), team: new ClusterStore('team', opts) }, mail: drive, team: drive, drive: { blobs: drive, previews: null as never, uploads: null as never } };
}

describe('storage repair', () => {
  it('adopts data written before, copies onto a new node, and empties a retiring node', async () => {
    // One node to start with: every file has one copy.
    const one = setupWith(1);
    const a = await one.cluster!.drive.put(Buffer.from('first file'));
    const b = await one.cluster!.drive.put(Buffer.from('second file'));
    const index = replicaIndex(handle.db);
    expect(await index.locations('drive', a.sha256)).toEqual([nodes[0]!.id]);
    // Forget the index (as if written before the cluster): adoption finds them again.
    await index.remove('drive', a.sha256);
    await index.remove('drive', b.sha256);

    // A second node joins: the repair job adopts the old files and makes second copies.
    const two = setupWith(2);
    const stats = await repairStorage(handle.db, redis as never, two, log);
    expect(stats).toMatchObject({ nodes: 2, adopted: 2, copied: 2 });
    for (const sha of [a.sha256, b.sha256]) expect(new Set(await index.locations('drive', sha))).toEqual(new Set([nodes[0]!.id, nodes[1]!.id]));
    expect((await repairStorage(handle.db, redis as never, two, log)).copied).toBe(0);

    // A third joins and the first retires: copies move to the third, then leave the first.
    const three = setupWith(3);
    draining.add(nodes[0]!.id);
    await repairStorage(handle.db, redis as never, three, log); // copy to the third node
    await repairStorage(handle.db, redis as never, three, log); // then remove from the retiring one
    for (const sha of [a.sha256, b.sha256]) {
      const where = new Set(await index.locations('drive', sha));
      expect(where.has(nodes[0]!.id)).toBe(false);
      expect(where).toEqual(new Set([nodes[1]!.id, nodes[2]!.id]));
    }
    // And the retiring node really has nothing left.
    const left = await three.cluster!.drive.list((await three.registry!.nodes()).find((n) => n.id === nodes[0]!.id)!);
    expect(left).toEqual([]);
    expect((await three.cluster!.drive.read(a.sha256)).toString()).toBe('first file');
  }, 30_000);
});
