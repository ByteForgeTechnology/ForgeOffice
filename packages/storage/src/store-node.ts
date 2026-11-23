import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { BlobStore, BlobTooLargeError, parseRange } from './blob-store';
import { KEY_RE, LocalKeyedStore, LocalUploadStore, OffsetMismatchError, TooMuchDataError, UPLOAD_ID_RE } from './object-store';
import { diskUsage } from './volumes';

/**
 * A ForgeOffice storage node. Holds one or more namespaces on its own disks:
 *   mail   raw messages (forge_mail_data/blobs)
 *   drive  Drive files and organisation pictures (forge_drive_data/blobs),
 *          previews (.previews) and uploads in progress (.uploads)
 *   team   meeting recordings (forge_team_media/blobs)
 * Any number of nodes can run; clients (cluster.ts) keep copies of every
 * blob on several of them. All requests but /healthz need the service token.
 *
 *   GET    /healthz
 *   GET    /v1/info                              node id, namespaces, free space
 *   PUT    /v1/:ns/blobs                         body → { sha256, size, created }
 *   GET    /v1/:ns/blobs/:sha256                 bytes (Range supported); HEAD → size
 *   DELETE /v1/:ns/blobs/:sha256
 *   GET    /v1/:ns/list?after=<sha>&limit=1000   blob ids, in order
 *   PUT    /v1/:ns/objects/:key                  keyed object (previews)
 *   GET    /v1/:ns/objects/:key  ·  DELETE
 *   PATCH  /v1/:ns/uploads/:id?offset=&limit=    append → { size }
 *   GET    /v1/:ns/uploads/:id                   { size }
 *   POST   /v1/:ns/uploads/:id/commit            → { sha256, size, created }
 *   DELETE /v1/:ns/uploads/:id
 *   GET    /v1/:ns/snapshot                      tar.gz of the namespace (backups)
 *   /blobs[/:sha256]                             the mail namespace (older clients)
 */

export interface NamespaceDirs {
  /** Content-addressed blobs. */
  blobs: string;
  /** Keyed objects (optional). */
  objects?: { root: string; suffix?: string };
  /** Upload sessions (optional). */
  uploads?: string;
}

export interface StoreNodeOptions {
  namespaces: Record<string, NamespaceDirs>;
  token: string;
  /** Where this node keeps its id (a file that survives restarts). */
  idFile: string;
  maxBytes?: number;
  log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
}

/** The node's id: made once and kept with its data, so a restarted node is the same node. */
export async function loadNodeId(idFile: string): Promise<string> {
  try {
    const id = (await readFile(idFile, 'utf8')).trim();
    if (/^[a-z0-9-]{4,64}$/.test(id)) return id;
  } catch {
    /* first start */
  }
  const id = `store-${randomBytes(4).toString('hex')}`;
  await mkdir(dirname(idFile), { recursive: true });
  await writeFile(idFile, id + '\n', { flag: 'wx' }).catch(async (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EEXIST') throw err;
  });
  return (await readFile(idFile, 'utf8')).trim();
}

/** This container's address on its network (when FORGE_STORE_URL isn't set). */
export function localAddress(): string {
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  return '127.0.0.1';
}

export interface StoreNode {
  server: Server;
  id: string;
  /** Free and total bytes across the namespaces' disks, and their names. */
  info(): Promise<{ id: string; namespaces: string[]; freeBytes: number; totalBytes: number }>;
}

export async function createStoreNode(opts: StoreNodeOptions): Promise<StoreNode> {
  const id = await loadNodeId(opts.idFile);
  const spaces = new Map(
    Object.entries(opts.namespaces).map(([ns, dirs]) => {
      const blobs = new BlobStore(dirs.blobs);
      return [ns, { dirs, blobs, objects: dirs.objects ? new LocalKeyedStore(dirs.objects.root, dirs.objects.suffix) : null, uploads: dirs.uploads ? new LocalUploadStore(dirs.uploads, blobs) : null }] as const;
    }),
  );
  for (const s of spaces.values()) await s.blobs.init();
  const expected = Buffer.from(`Bearer ${opts.token}`);
  const authorised = (req: IncomingMessage) => {
    const got = Buffer.from(req.headers.authorization ?? '');
    return got.length === expected.length && timingSafeEqual(got, expected);
  };
  const send = (res: ServerResponse, status: number, body?: unknown) => {
    if (body === undefined) return void res.writeHead(status).end();
    const json = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) }).end(json);
  };

  const info = async () => {
    // Several namespaces may share a disk: count each filesystem once.
    const seen = new Map<string, { free: number; total: number }>();
    for (const s of spaces.values()) {
      const u = await diskUsage(s.dirs.blobs).catch(() => null);
      if (u) seen.set(`${u.totalBytes}:${u.freeBytes}`, { free: u.freeBytes, total: u.totalBytes });
    }
    const all = [...seen.values()];
    return { id, namespaces: [...spaces.keys()], freeBytes: all.reduce((a, b) => a + b.free, 0), totalBytes: all.reduce((a, b) => a + b.total, 0) };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://node');
    let path = url.pathname;
    try {
      if (path === '/healthz') return send(res, 200, { status: 'ok', id });
      if (!authorised(req)) return send(res, 401, { error: 'unauthorized' });
      if (path === '/v1/info') return send(res, 200, await info());
      // Older mail clients: /blobs means the mail namespace.
      if (path === '/blobs' || path.startsWith('/blobs/')) path = `/v1/mail${path}`;
      const m = /^\/v1\/([a-z]+)\/(blobs|objects|uploads|list|snapshot)(?:\/([^/]+))?(?:\/(commit))?$/.exec(path);
      const space = m ? spaces.get(m[1]!) : undefined;
      if (!m || !space) return send(res, 404, { error: 'not_found' });
      const [, ns, kind, key, action] = m;

      if (kind === 'blobs') {
        if (!key) {
          if (req.method !== 'PUT') return send(res, 405, { error: 'method_not_allowed' });
          const result = await space.blobs.put(req, { maxBytes: opts.maxBytes });
          return send(res, result.created ? 201 : 200, result);
        }
        if (!KEY_RE.test(key)) return send(res, 400, { error: 'bad_id' });
        if (req.method === 'GET' || req.method === 'HEAD') {
          if (!(await space.blobs.exists(key))) return send(res, 404, { error: 'not_found' });
          const size = await space.blobs.size(key);
          const range = parseRange(req.headers.range, size);
          if (range === 'unsatisfiable') return void res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
          const headers = { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'accept-ranges': 'bytes', 'x-blob-size': String(size) };
          if (range) {
            res.writeHead(206, { ...headers, 'content-length': range.end - range.start + 1, 'content-range': `bytes ${range.start}-${range.end}/${size}` });
            if (req.method === 'HEAD') return void res.end();
            return void (await pipeline(space.blobs.createReadStream(key, range), res));
          }
          res.writeHead(200, { ...headers, 'content-length': size });
          if (req.method === 'HEAD') return void res.end();
          return void (await pipeline(space.blobs.createReadStream(key), res));
        }
        if (req.method === 'DELETE') return send(res, (await space.blobs.delete(key)) ? 204 : 404);
        return send(res, 405, { error: 'method_not_allowed' });
      }

      if (kind === 'list') {
        const after = url.searchParams.get('after') ?? '';
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 1000) || 1000, 5000);
        return send(res, 200, { items: await listBlobs(space.dirs.blobs, after, limit) });
      }

      if (kind === 'objects') {
        if (!space.objects || !key || !KEY_RE.test(key)) return send(res, 404, { error: 'not_found' });
        if (req.method === 'PUT') {
          const chunks: Buffer[] = [];
          let n = 0;
          for await (const c of req) {
            n += (c as Buffer).length;
            if (n > 50 * 1024 * 1024) return send(res, 413, { error: 'too_large' });
            chunks.push(c as Buffer);
          }
          await space.objects.put(key, Buffer.concat(chunks));
          return send(res, 204);
        }
        if (req.method === 'GET') {
          const data = await space.objects.get(key);
          if (!data) return send(res, 404, { error: 'not_found' });
          return void res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length }).end(data);
        }
        if (req.method === 'DELETE') {
          await space.objects.delete(key);
          return send(res, 204);
        }
        return send(res, 405, { error: 'method_not_allowed' });
      }

      if (kind === 'uploads') {
        if (!space.uploads || !key || !UPLOAD_ID_RE.test(key)) return send(res, 404, { error: 'not_found' });
        if (action === 'commit' && req.method === 'POST') {
          const result = await space.uploads.commit(key, { maxBytes: opts.maxBytes });
          return send(res, 200, result);
        }
        if (req.method === 'PATCH') {
          const offset = Number(url.searchParams.get('offset'));
          const limit = Number(url.searchParams.get('limit') ?? Number.MAX_SAFE_INTEGER);
          const size = await space.uploads.append(key, offset, req, limit);
          return send(res, 200, { size });
        }
        if (req.method === 'GET') return send(res, 200, { size: await space.uploads.size(key) });
        if (req.method === 'DELETE') {
          await space.uploads.discard(key);
          return send(res, 204);
        }
        return send(res, 405, { error: 'method_not_allowed' });
      }

      if (kind === 'snapshot' && req.method === 'GET') {
        // A consistent-enough archive of this namespace for backups (temp files excluded).
        res.writeHead(200, { 'content-type': 'application/gzip', 'content-disposition': `attachment; filename="${id}-${ns}.tar.gz"` });
        const tar = spawn('tar', ['--create', '--gzip', `--directory=${dirname(space.dirs.blobs)}`, '--exclude=.tmp', '--exclude=.uploads', '--warning=no-file-changed', '.'], { stdio: ['ignore', 'pipe', 'ignore'] });
        req.once('close', () => tar.kill());
        return void (await pipeline(tar.stdout, res));
      }
      return send(res, 404, { error: 'not_found' });
    } catch (err) {
      if (err instanceof BlobTooLargeError) return send(res, 413, { error: 'too_large', message: err.message });
      if (err instanceof OffsetMismatchError) return send(res, 409, { error: 'offset_mismatch', expected: err.expected });
      if (err instanceof TooMuchDataError) return send(res, 400, { error: 'too_much_data' });
      opts.log?.error({ err, method: req.method, path }, 'storage request failed');
      if (!res.headersSent) send(res, 500, { error: 'internal_error' });
      else res.destroy();
    }
  });
  return { server, id, info };
}

/** Blob ids under a BlobStore root (<aa>/<bb>/<sha>), in order, after `after`. */
async function listBlobs(root: string, after: string, limit: number): Promise<string[]> {
  const out: string[] = [];
  const hex = (names: string[], len: number) => names.filter((n) => n.length === len && /^[a-f0-9]+$/.test(n)).sort();
  for (const a of hex(await readdir(root).catch(() => []), 2)) {
    if (after && a < after.slice(0, 2)) continue;
    for (const b of hex(await readdir(join(root, a)).catch(() => []), 2)) {
      if (after && `${a}${b}` < after.slice(0, 4)) continue;
      for (const sha of hex(await readdir(join(root, a, b)).catch(() => []), 64)) {
        if (sha <= after) continue;
        out.push(sha);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

