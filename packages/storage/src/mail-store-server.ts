import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { BlobStore, BlobTooLargeError } from './blob-store';

const SHA_PATH = /^\/blobs\/([a-f0-9]{64})$/;

export interface MailStoreOptions {
  /** Directory holding the blobs (on the mailbox volume). */
  root: string;
  /** Bearer token callers must present. */
  token: string;
  /** Largest message accepted (bytes). */
  maxBytes?: number;
  log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
}

/**
 * The mail-store service: the only process that touches mailbox storage.
 * SMTP, IMAP, the webmail back end and the worker store and read raw
 * messages through it (content-addressed: PUT returns the SHA-256).
 *
 *   PUT    /blobs          body = message bytes  → { sha256, size, created }
 *   GET    /blobs/:sha256  → bytes
 *   HEAD   /blobs/:sha256  → 200 / 404
 *   DELETE /blobs/:sha256  → 204 / 404
 *   GET    /healthz        (no auth)
 */
export function createMailStoreServer(opts: MailStoreOptions): Server {
  const store = new BlobStore(opts.root);
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

  return createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    try {
      if (path === '/healthz') return send(res, 200, { status: 'ok' });
      if (!authorised(req)) return send(res, 401, { error: 'unauthorized' });

      if (path === '/blobs' && req.method === 'PUT') {
        const result = await store.put(req, { maxBytes: opts.maxBytes });
        return send(res, result.created ? 201 : 200, result);
      }
      const m = SHA_PATH.exec(path);
      if (!m) return send(res, 404, { error: 'not_found' });
      const sha = m[1]!;
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (!(await store.exists(sha))) return send(res, 404, { error: 'not_found' });
        const size = await store.size(sha);
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size, 'cache-control': 'no-store' });
        if (req.method === 'HEAD') return void res.end();
        return void (await pipeline(store.createReadStream(sha), res));
      }
      if (req.method === 'DELETE') return send(res, (await store.delete(sha)) ? 204 : 404);
      return send(res, 405, { error: 'method_not_allowed' });
    } catch (err) {
      if (err instanceof BlobTooLargeError) return send(res, 413, { error: 'too_large', message: err.message });
      opts.log?.error({ err, method: req.method, path }, 'mail-store request failed');
      if (!res.headersSent) send(res, 500, { error: 'internal_error' });
      else res.destroy();
    }
  });
}
