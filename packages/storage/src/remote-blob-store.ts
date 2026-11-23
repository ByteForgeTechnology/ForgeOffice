import { Readable } from 'node:stream';
import { BlobTooLargeError, InvalidBlobIdError, type BlobSource, type PutOptions, type PutResult } from './blob-store';

/** What mail needs from a blob store: a local BlobStore or the mail-store service. */
export interface ContentStore {
  put(source: BlobSource, opts?: PutOptions): Promise<PutResult>;
  read(sha256: string): Promise<Buffer>;
  exists(sha256: string): Promise<boolean>;
  delete(sha256: string): Promise<boolean>;
}

const SHA256_RE = /^[a-f0-9]{64}$/;

async function toBuffer(source: BlobSource): Promise<Buffer> {
  if (Buffer.isBuffer(source)) return source;
  if (source instanceof Uint8Array) return Buffer.from(source);
  const chunks: Buffer[] = [];
  for await (const c of Readable.from(source)) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks);
}

/**
 * Client for the mail-store service: the only container that mounts the
 * mailbox volume. Speaks a tiny authenticated HTTP API (see apps/mailstore).
 */
export class RemoteBlobStore implements ContentStore {
  private readonly base: string;

  constructor(
    url: string,
    private readonly token: string,
    private readonly timeoutMs = 60_000,
  ) {
    this.base = url.replace(/\/+$/, '');
  }

  private async call(method: string, sha256: string | null, body?: Buffer): Promise<Response> {
    if (sha256 !== null && !SHA256_RE.test(sha256)) throw new InvalidBlobIdError(sha256);
    const res = await fetch(`${this.base}/blobs${sha256 ? `/${sha256}` : ''}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body ? { 'content-type': 'application/octet-stream' } : {}) },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 401 || res.status === 403) throw new Error('mail-store rejected the service token (check FORGE_SECRET / forge_certs)');
    return res;
  }

  async put(source: BlobSource, opts: PutOptions = {}): Promise<PutResult> {
    const data = await toBuffer(source);
    if (opts.maxBytes !== undefined && data.length > opts.maxBytes) throw new BlobTooLargeError(opts.maxBytes);
    const res = await this.call('PUT', null, data);
    if (!res.ok) throw new Error(`mail-store put failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as PutResult;
  }

  async read(sha256: string): Promise<Buffer> {
    const res = await this.call('GET', sha256);
    if (res.status === 404) throw Object.assign(new Error(`blob ${sha256} not found`), { code: 'ENOENT' });
    if (!res.ok) throw new Error(`mail-store read failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async exists(sha256: string): Promise<boolean> {
    const res = await this.call('HEAD', sha256);
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`mail-store check failed: ${res.status}`);
    return true;
  }

  async delete(sha256: string): Promise<boolean> {
    const res = await this.call('DELETE', sha256);
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`mail-store delete failed: ${res.status}`);
    return true;
  }
}
