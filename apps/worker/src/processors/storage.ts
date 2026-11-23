import type { Redis } from 'ioredis';
import { blobsOnNode, replicaIndex, underReplicated, type Database } from '@forge/db';
import { rendezvous, type StorageSetup, type StoreNodeInfo } from '@forge/storage';

const NAMESPACES = ['mail', 'drive', 'team'] as const;
/** Entries to adopt per node and namespace per run (the rest on the next run). */
const ADOPT_BATCH = 20_000;

export interface RepairStats {
  nodes: number;
  adopted: number;
  copied: number;
  moved: number;
  underReplicated: number;
}

/**
 * Keep every blob on enough storage nodes (every 10 minutes):
 *   1. adopt: record blobs a node holds that the index doesn't know (data
 *      from before the cluster, or a node restored from backup);
 *   2. repair: copy blobs with too few copies on healthy nodes (a new node,
 *      or one that went away) from a node that has them;
 *   3. retire: once a node being retired has no blob that isn't safely
 *      elsewhere, its copies are deleted.
 */
export async function repairStorage(db: Database, redis: Pick<Redis, 'get' | 'set'>, storage: StorageSetup, log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void }): Promise<RepairStats> {
  const stats: RepairStats = { nodes: 0, adopted: 0, copied: 0, moved: 0, underReplicated: 0 };
  if (!storage.cluster || !storage.registry) return stats;
  const index = replicaIndex(db);
  const nodes = await storage.registry.nodes();
  stats.nodes = nodes.length;

  for (const ns of NAMESPACES) {
    const store = storage.cluster[ns];
    const live = nodes.filter((n) => n.namespaces.includes(ns));
    if (!live.length) continue;
    const good = live.filter((n) => !n.draining);
    const byId = new Map(live.map((n) => [n.id, n]));
    const want = Math.min(store.replicas, good.length);

    // 1. Adopt what nodes hold (resumable: a cursor per node, then once a day).
    for (const node of live) {
      const doneKey = `forge:store:adopted:${node.id}:${ns}`;
      if (await redis.get(doneKey)) continue;
      const cursorKey = `forge:store:adopt-cursor:${node.id}:${ns}`;
      let after = (await redis.get(cursorKey)) ?? '';
      let n = 0;
      try {
        for (;;) {
          const page = await store.list(node, after, 1000);
          for (const sha of page) await index.add(ns, sha, node.id);
          n += page.length;
          if (page.length < 1000) {
            await redis.set(doneKey, '1', 'EX', 24 * 3600);
            await redis.set(cursorKey, '', 'EX', 1);
            break;
          }
          after = page[page.length - 1]!;
          if (n >= ADOPT_BATCH) {
            await redis.set(cursorKey, after, 'EX', 7 * 24 * 3600);
            break;
          }
        }
      } catch (err) {
        log.warn({ err, node: node.id, ns }, 'could not list a storage node');
      }
      stats.adopted += n;
    }

    // 2. Repair: copies on healthy nodes, up to `want`.
    if (want > 0) {
      const short = await underReplicated(db, ns, good.map((n) => n.id), want, 500);
      stats.underReplicated += short.length;
      for (const row of short) {
        const holders = row.nodes.map((id) => byId.get(id)).filter(Boolean) as StoreNodeInfo[];
        const source = holders.find((n) => !n.draining) ?? holders[0];
        if (!source) {
          log.warn({ ns, sha: row.sha256, nodes: row.nodes }, 'a blob has no copy on any live storage node');
          continue;
        }
        let have = row.good;
        for (const target of rendezvous(good, row.sha256)) {
          if (have >= want) break;
          if (row.nodes.includes(target.id)) continue;
          if (await store.copy(row.sha256, source, target)) {
            have++;
            stats.copied++;
          }
        }
      }
    }

    // 3. Retire: delete copies from draining nodes when they're safe elsewhere.
    for (const node of live.filter((n) => n.draining)) {
      for (const sha of await blobsOnNode(db, ns, node.id, 500)) {
        const elsewhere = (await index.locations(ns, sha)).filter((id) => id !== node.id && good.some((g) => g.id === id));
        if (elsewhere.length >= Math.max(1, want)) {
          await store.deleteFrom(node, sha).catch(() => {});
          stats.moved++;
        }
      }
    }
  }
  if (stats.copied || stats.moved || stats.adopted) log.info({ ...stats }, 'storage repair');
  return stats;
}
