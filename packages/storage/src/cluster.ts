import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { BlobTooLargeError, InvalidBlobIdError, type PutOptions, type PutResult } from './blob-store';
import { KEY_RE, OffsetMismatchError, TooMuchDataError, UPLOAD_ID_RE, type KeyedStore, type ObjectStore, type UploadStore } from './object-store';

/**
 * Storage across several nodes (store-node.ts). Every blob is kept on
 * `replicas` nodes (2 by default, or as many as there are): it is written to
 * one node, then copied to others; a replica index (in the database) records
 * where each blob is, and the worker's repair job tops up missing copies,
 * copies onto new nodes and empties nodes being retired. Reads try the known
 * copies first and fall back to asking every node, so data written before a
 * node was added (or before the index existed) is still found.
 */

export interface StoreNodeInfo {
  id: string;
  url: string;
  namespaces: string[];
  freeBytes: number;
  totalBytes: number;
  /** Being retired: read from it, never write to it; the repair job moves its blobs away. */
  draining: boolean;
  seenAt: number;
}

/** Where the live nodes are: Redis heartbeats (cluster) and/or a fixed list (FORGE_STORE_NODES). */
export interface NodeRegistry {
  nodes(): Promise<StoreNodeInfo[]>;
}

/** Which nodes hold which blobs (the blob_replicas table). */
export interface ReplicaIndex {
  locations(ns: string, sha256: string): Promise<string[]>;
  add(ns: string, sha256: string, nodeId: string): Promise<void>;
  remove(ns: string, sha256: string, nodeId?: string): Promise<void>;
}

/** Minimal Redis surface for the registry (ioredis compatible). */
export interface RegistryRedis {
  set(key: string, value: string, ex: 'EX', seconds: number): Promise<unknown>;
  scan(cursor: string, match: 'MATCH', pattern: string, count: 'COUNT', n: number): Promise<[string, string[]]>;
  mget(keys: string[]): Promise<(string | null)[]>;
  smembers(key: string): Promise<string[]>;
}

const HEARTBEAT_TTL = 30;
const nodeKey = (id: string) => `forge:store:node:${id}`;
export const DRAINING_SET = 'forge:store:draining';

/** A node announcing itself every 10 seconds. */
export function startNodeHeartbeat(redis: RegistryRedis, info: () => Promise<Omit<StoreNodeInfo, 'draining' | 'seenAt' | 'url'>>, url: string, onError?: (err: unknown) => void) {
  const beat = async () => {
    try {
      const i = await info();
      await redis.set(nodeKey(i.id), JSON.stringify({ ...i, url, seenAt: Date.now() }), 'EX', HEARTBEAT_TTL);
    } catch (err) {
      onError?.(err);
    }
  };
  void beat();
  const t = setInterval(beat, 10_000);
  t.unref();
  return () => clearInterval(t);
}

export function redisRegistry(redis: RegistryRedis): NodeRegistry {
  let cache: { at: number; nodes: StoreNodeInfo[] } | null = null;
  return {
    async nodes() {
      if (cache && Date.now() - cache.at < 3000) return cache.nodes;
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [next, batch] = await redis.scan(cursor, 'MATCH', 'forge:store:node:*', 'COUNT', 200);
        cursor = next;
        keys.push(...batch);
      } while (cursor !== '0');
      const values = keys.length ? await redis.mget(keys) : [];
      const draining = new Set(await redis.smembers(DRAINING_SET));
      const nodes = values.filter(Boolean).map((v) => {
        const n = JSON.parse(v!) as StoreNodeInfo;
        return { ...n, draining: draining.has(n.id) };
      });
      cache = { at: Date.now(), nodes };
      return nodes;
    },
  };
}

/** Nodes at fixed addresses (no Redis, or a single store): asks each for its id. */
export function staticRegistry(urls: string[], token: string): NodeRegistry {
  let cache: { at: number; nodes: StoreNodeInfo[] } | null = null;
  return {
    async nodes() {
      if (cache && Date.now() - cache.at < 10_000) return cache.nodes;
      const found = await Promise.all(
        urls.map(async (url) => {
          try {
            const res = await fetch(`${url.replace(/\/+$/, '')}/v1/info`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
            if (!res.ok) return null;
            const i = (await res.json()) as Omit<StoreNodeInfo, 'url' | 'draining' | 'seenAt'>;
            return { ...i, url: url.replace(/\/+$/, ''), draining: false, seenAt: Date.now() };
          } catch {
            return null;
          }
        }),
      );
      cache = { at: Date.now(), nodes: found.filter(Boolean) as StoreNodeInfo[] };
      return cache.nodes;
    },
  };
}

/** Both: heartbeats, plus fixed addresses (useful to bootstrap, or when one node's Redis is unavailable). */
export function combinedRegistry(...registries: NodeRegistry[]): NodeRegistry {
  return {
    async nodes() {
      const all = (await Promise.all(registries.map((r) => r.nodes().catch(() => [])))).flat();
      const byId = new Map<string, StoreNodeInfo>();
      for (const n of all) if (!byId.has(n.id) || n.draining) byId.set(n.id, { ...byId.get(n.id), ...n, draining: n.draining || !!byId.get(n.id)?.draining });
      return [...byId.values()];
    },
  };
}

/** Rendezvous (highest random weight) order of nodes for a key: stable as nodes come and go. */
export function rendezvous<T extends { id: string }>(nodes: T[], key: string): T[] {
  const score = (id: string) => createHash('sha256').update(`${id}:${key}`).digest().readBigUInt64BE(0);
  return [...nodes].sort((a, b) => (score(b.id) > score(a.id) ? 1 : score(b.id) < score(a.id) ? -1 : 0));
}

export interface ClusterOptions {
  registry: NodeRegistry;
  token: string;
  /** Copies of each blob to keep (capped at the number of nodes). */
  replicas?: number;
  index?: ReplicaIndex | null;
  log?: { warn: (o: unknown, m?: string) => void };
  /** Keep this much free space on a node before writing elsewhere. */
  minFreeBytes?: number;
}

class NodeClient {
  constructor(
    private readonly token: string,
    private readonly log?: ClusterOptions['log'],
  ) {}

  fetch(node: StoreNodeInfo, path: string, init: RequestInit & { timeoutMs?: number } = {}) {
    const { timeoutMs, ...rest } = init;
    return fetch(`${node.url}${path}`, {
      ...rest,
      headers: { authorization: `Bearer ${this.token}`, ...(rest.headers ?? {}) },
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
      ...(rest.body && typeof rest.body !== 'string' && !(rest.body instanceof Uint8Array) ? { duplex: 'half' } : {}),
    } as RequestInit);
  }

  warn(o: unknown, m: string) {
    this.log?.warn(o, m);
  }
}

const toBody = (source: Readable | Buffer | Uint8Array | AsyncIterable<Uint8Array>) => (Buffer.isBuffer(source) || source instanceof Uint8Array ? source : Readable.from(source));
const notFound = (sha: string) => Object.assign(new Error(`blob ${sha} not found on any storage node`), { code: 'ENOENT' });

/** Content-addressed blobs in one namespace, across the cluster. */
export class ClusterStore implements ObjectStore {
  private readonly client: NodeClient;
  readonly replicas: number;

  constructor(
    readonly ns: string,
    private readonly opts: ClusterOptions,
  ) {
    this.client = new NodeClient(opts.token, opts.log);
    this.replicas = Math.max(1, opts.replicas ?? 2);
  }

  async live() {
    return (await this.opts.registry.nodes()).filter((n) => n.namespaces.includes(this.ns));
  }

  async writable() {
    const min = this.opts.minFreeBytes ?? 1024 ** 3;
    const live = (await this.live()).filter((n) => !n.draining);
    const roomy = live.filter((n) => n.freeBytes > min);
    return roomy.length ? roomy : live;
  }

  /** Nodes to read a blob from: known copies first (stable order), then everyone else. */
  private async candidates(sha: string) {
    const live = await this.live();
    const known = new Set(this.opts.index ? await this.opts.index.locations(this.ns, sha).catch(() => []) : []);
    const ordered = rendezvous(live, sha);
    return [...ordered.filter((n) => known.has(n.id)), ...ordered.filter((n) => !known.has(n.id))];
  }

  /** Pick a node for a new blob: weighted by free space, so nodes fill evenly. */
  private pickPrimary(nodes: StoreNodeInfo[]) {
    const total = nodes.reduce((a, n) => a + Math.max(1, n.freeBytes), 0);
    let r = Math.random() * total;
    for (const n of nodes) if ((r -= Math.max(1, n.freeBytes)) <= 0) return n;
    return nodes[0]!;
  }

  async put(source: Readable | Buffer | Uint8Array | AsyncIterable<Uint8Array>, opts: PutOptions = {}): Promise<PutResult> {
    const targets = await this.writable();
    if (!targets.length) throw new Error(`No storage node is available for ${this.ns}`);
    const primary = this.pickPrimary(targets);
    const res = await this.client.fetch(primary, `/v1/${this.ns}/blobs`, { method: 'PUT', body: toBody(source) as never, headers: { 'content-type': 'application/octet-stream' } });
    if (res.status === 413) throw new BlobTooLargeError(opts.maxBytes ?? 0);
    if (!res.ok) throw new Error(`storage node ${primary.id} refused the write: ${res.status}`);
    const result = (await res.json()) as PutResult;
    if (opts.maxBytes !== undefined && result.size > opts.maxBytes) {
      // The node accepted it (its own limit is larger): undo if it was new.
      if (result.created) await this.client.fetch(primary, `/v1/${this.ns}/blobs/${result.sha256}`, { method: 'DELETE', timeoutMs: 10_000 }).catch(() => {});
      throw new BlobTooLargeError(opts.maxBytes);
    }
    // Already stored with enough copies elsewhere (the same content uploaded again): don't keep an extra one.
    if (this.opts.index) {
      const live = new Set((await this.live()).map((n) => n.id));
      const known = (await this.opts.index.locations(this.ns, result.sha256)).filter((id) => live.has(id) && id !== primary.id);
      if (known.length >= Math.min(this.replicas, live.size)) {
        if (result.created) await this.client.fetch(primary, `/v1/${this.ns}/blobs/${result.sha256}`, { method: 'DELETE', timeoutMs: 10_000 }).catch(() => {});
        return { ...result, created: false };
      }
    }
    await this.opts.index?.add(this.ns, result.sha256, primary.id);
    await this.replicate(result.sha256, primary);
    return result;
  }

  /** Copy a blob from `from` to other nodes until it has enough copies. */
  async replicate(sha: string, from: StoreNodeInfo) {
    const writable = await this.writable();
    const want = Math.min(this.replicas, writable.length + (writable.some((n) => n.id === from.id) ? 0 : 1));
    const known = new Set([from.id, ...(this.opts.index ? await this.opts.index.locations(this.ns, sha).catch(() => []) : [])]);
    const live = new Set((await this.live()).map((n) => n.id));
    let have = [...known].filter((id) => live.has(id) && writable.some((n) => n.id === id)).length || 1;
    for (const target of rendezvous(writable, sha)) {
      if (have >= want) break;
      if (known.has(target.id)) continue;
      if (await this.copy(sha, from, target)) have++;
    }
  }

  /** Stream a blob from one node to another; records the new copy. */
  async copy(sha: string, from: StoreNodeInfo, to: StoreNodeInfo): Promise<boolean> {
    try {
      const src = await this.client.fetch(from, `/v1/${this.ns}/blobs/${sha}`);
      if (!src.ok || !src.body) return false;
      const res = await this.client.fetch(to, `/v1/${this.ns}/blobs`, { method: 'PUT', body: Readable.fromWeb(src.body as never) as never, headers: { 'content-type': 'application/octet-stream' } });
      if (!res.ok) return false;
      const out = (await res.json()) as PutResult;
      if (out.sha256 !== sha) {
        this.client.warn({ sha, got: out.sha256, from: from.id, to: to.id }, 'a copied blob had different content');
        return false;
      }
      await this.opts.index?.add(this.ns, sha, to.id);
      return true;
    } catch (err) {
      this.client.warn({ err, sha, from: from.id, to: to.id }, 'could not copy a blob between storage nodes');
      return false;
    }
  }

  private async firstOk(sha: string, method: 'GET' | 'HEAD', range?: { start: number; end: number }) {
    if (!KEY_RE.test(sha)) throw new InvalidBlobIdError(sha);
    for (const node of await this.candidates(sha)) {
      try {
        const res = await this.client.fetch(node, `/v1/${this.ns}/blobs/${sha}`, { method, headers: range ? { range: `bytes=${range.start}-${range.end}` } : {}, timeoutMs: method === 'HEAD' ? 10_000 : undefined });
        if (res.ok) return { res, node };
        await res.body?.cancel().catch(() => {});
      } catch {
        /* that node is down: try the next */
      }
    }
    return null;
  }

  async exists(sha256: string) {
    return !!(await this.firstOk(sha256, 'HEAD'));
  }

  async size(sha256: string) {
    const hit = await this.firstOk(sha256, 'HEAD');
    if (!hit) throw notFound(sha256);
    return Number(hit.res.headers.get('x-blob-size') ?? hit.res.headers.get('content-length'));
  }

  async read(sha256: string) {
    const hit = await this.firstOk(sha256, 'GET');
    if (!hit) throw notFound(sha256);
    return Buffer.from(await hit.res.arrayBuffer());
  }

  createReadStream(sha256: string, range?: { start: number; end: number }): Readable {
    const out = new PassThrough();
    void this.firstOk(sha256, 'GET', range).then(
      (hit) => {
        if (!hit?.res.body) return out.destroy(notFound(sha256));
        const body = Readable.fromWeb(hit.res.body as never);
        body.on('error', (err) => out.destroy(err));
        body.pipe(out);
      },
      (err) => out.destroy(err as Error),
    );
    return out;
  }

  async delete(sha256: string) {
    if (!KEY_RE.test(sha256)) throw new InvalidBlobIdError(sha256);
    let deleted = false;
    // Every node: copies can exist that the index doesn't know about (older data).
    await Promise.all(
      (await this.live()).map(async (node) => {
        try {
          const res = await this.client.fetch(node, `/v1/${this.ns}/blobs/${sha256}`, { method: 'DELETE', timeoutMs: 10_000 });
          if (res.status === 204) deleted = true;
        } catch {
          /* a node that is down keeps a stray copy; the repair job's index ignores it */
        }
      }),
    );
    await this.opts.index?.remove(this.ns, sha256);
    return deleted;
  }

  /** Blob ids a node holds (for adopting older data into the index). */
  async list(node: StoreNodeInfo, after = '', limit = 1000): Promise<string[]> {
    const res = await this.client.fetch(node, `/v1/${this.ns}/list?after=${after}&limit=${limit}`, { timeoutMs: 60_000 });
    if (!res.ok) throw new Error(`could not list ${this.ns} on ${node.id}: ${res.status}`);
    return ((await res.json()) as { items: string[] }).items;
  }

  /** Remove one node's copy (after it has enough copies elsewhere). */
  async deleteFrom(node: StoreNodeInfo, sha: string) {
    const res = await this.client.fetch(node, `/v1/${this.ns}/blobs/${sha}`, { method: 'DELETE', timeoutMs: 10_000 });
    if (res.ok || res.status === 404) await this.opts.index?.remove(this.ns, sha, node.id);
  }

  /** A tar.gz of a node's namespace (backups). */
  async snapshot(node: StoreNodeInfo): Promise<Readable> {
    const res = await this.client.fetch(node, `/v1/${this.ns}/snapshot`);
    if (!res.ok || !res.body) throw new Error(`could not snapshot ${this.ns} on ${node.id}: ${res.status}`);
    return Readable.fromWeb(res.body as never);
  }
}

/** Keyed objects (previews): kept on the `replicas` nodes the key hashes to. */
export class ClusterKeyedStore implements KeyedStore {
  private readonly client: NodeClient;

  constructor(
    readonly ns: string,
    private readonly opts: ClusterOptions,
  ) {
    this.client = new NodeClient(opts.token, opts.log);
  }

  private async live() {
    return (await this.opts.registry.nodes()).filter((n) => n.namespaces.includes(this.ns));
  }

  async put(key: string, data: Buffer) {
    if (!KEY_RE.test(key)) throw new Error('invalid key');
    const targets = rendezvous((await this.live()).filter((n) => !n.draining), key).slice(0, Math.max(1, this.opts.replicas ?? 2));
    const ok = await Promise.all(targets.map((n) => this.client.fetch(n, `/v1/${this.ns}/objects/${key}`, { method: 'PUT', body: data, timeoutMs: 60_000 }).then((r) => r.ok, () => false)));
    if (!ok.some(Boolean)) throw new Error(`No storage node accepted ${this.ns} object ${key}`);
  }

  async get(key: string) {
    if (!KEY_RE.test(key)) throw new Error('invalid key');
    for (const n of rendezvous(await this.live(), key)) {
      try {
        const res = await this.client.fetch(n, `/v1/${this.ns}/objects/${key}`, { timeoutMs: 30_000 });
        if (res.ok) return Buffer.from(await res.arrayBuffer());
      } catch {
        /* next */
      }
    }
    return null;
  }

  async delete(key: string) {
    await Promise.all((await this.live()).map((n) => this.client.fetch(n, `/v1/${this.ns}/objects/${key}`, { method: 'DELETE', timeoutMs: 10_000 }).catch(() => null)));
  }
}

/** Resumable uploads: each upload lives on one node (by its id), then becomes a replicated blob. */
export class ClusterUploadStore implements UploadStore {
  private readonly client: NodeClient;

  constructor(
    readonly ns: string,
    private readonly store: ClusterStore,
    private readonly opts: ClusterOptions,
  ) {
    this.client = new NodeClient(opts.token, opts.log);
  }

  /** The node holding an upload: the first (by its id) that has bytes for it, else the first writable one. */
  private async nodeFor(id: string, writing = false) {
    if (!UPLOAD_ID_RE.test(id)) throw new Error('invalid upload id');
    const nodes = rendezvous(await this.store.writable(), id);
    for (const n of nodes.slice(0, 3)) {
      const size = await this.client
        .fetch(n, `/v1/${this.ns}/uploads/${id}`, { timeoutMs: 10_000 })
        .then(async (r) => (r.ok ? ((await r.json()) as { size: number }).size : 0))
        .catch(() => 0);
      if (size > 0) return { node: n, size };
    }
    if (!nodes[0]) throw new Error(`No storage node is available for ${this.ns}`);
    void writing;
    return { node: nodes[0], size: 0 };
  }

  async size(id: string) {
    return (await this.nodeFor(id)).size;
  }

  async append(id: string, offset: number, body: Readable | AsyncIterable<Uint8Array>, limit: number) {
    const { node } = await this.nodeFor(id, true);
    const res = await this.client.fetch(node, `/v1/${this.ns}/uploads/${id}?offset=${offset}&limit=${limit}`, { method: 'PATCH', body: Readable.from(body) as never, headers: { 'content-type': 'application/octet-stream' } });
    if (res.status === 409) throw new OffsetMismatchError(((await res.json()) as { expected: number }).expected);
    if (res.status === 400) throw new TooMuchDataError();
    if (!res.ok) throw new Error(`storage node ${node.id} refused the upload: ${res.status}`);
    return ((await res.json()) as { size: number }).size;
  }

  async commit(id: string, opts: PutOptions = {}) {
    const { node } = await this.nodeFor(id);
    const res = await this.client.fetch(node, `/v1/${this.ns}/uploads/${id}/commit`, { method: 'POST' });
    if (res.status === 413) throw new BlobTooLargeError(opts.maxBytes ?? 0);
    if (!res.ok) throw new Error(`storage node ${node.id} could not finish the upload: ${res.status}`);
    const result = (await res.json()) as PutResult;
    if (opts.maxBytes !== undefined && result.size > opts.maxBytes) throw new BlobTooLargeError(opts.maxBytes);
    await this.opts.index?.add(this.ns, result.sha256, node.id);
    await this.store.replicate(result.sha256, node);
    return result;
  }

  async discard(id: string) {
    if (!UPLOAD_ID_RE.test(id)) return;
    await Promise.all(rendezvous(await this.store.writable(), id).slice(0, 3).map((n) => this.client.fetch(n, `/v1/${this.ns}/uploads/${id}`, { method: 'DELETE', timeoutMs: 10_000 }).catch(() => null)));
  }
}
