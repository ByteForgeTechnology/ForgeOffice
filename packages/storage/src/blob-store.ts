import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const SHA256_RE = /^[a-f0-9]{64}$/;

export class BlobTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`Blob exceeds the maximum allowed size of ${limit} bytes`);
    this.name = 'BlobTooLargeError';
  }
}

export class InvalidBlobIdError extends Error {
  constructor(id: string) {
    super(`Invalid blob id: ${JSON.stringify(id).slice(0, 80)}`);
    this.name = 'InvalidBlobIdError';
  }
}

export interface PutResult {
  sha256: string;
  size: number;
  /** false when an identical blob already existed (deduplicated). */
  created: boolean;
}

export interface PutOptions {
  /** Abort and discard the write once this many bytes have been received. */
  maxBytes?: number;
}

export type BlobSource = Readable | Buffer | Uint8Array | AsyncIterable<Uint8Array>;

/**
 * Content-addressable blob store on the local filesystem.
 *
 * Blobs live at `<root>/<aa>/<bb>/<sha256>`. Writes stream to a temp file in
 * `<root>/.tmp` (same filesystem) while hashing, are fsynced, then atomically
 * renamed into place, so readers never observe a partial blob and identical
 * content is stored exactly once.
 */
export class BlobStore {
  readonly tmpDir: string;

  constructor(readonly root: string) {
    this.tmpDir = join(root, '.tmp');
  }

  static isValidId(id: string): boolean {
    return SHA256_RE.test(id);
  }

  pathFor(sha256: string): string {
    if (!SHA256_RE.test(sha256)) throw new InvalidBlobIdError(sha256);
    return join(this.root, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  }

  async init(): Promise<void> {
    await mkdir(this.tmpDir, { recursive: true, mode: 0o750 });
  }

  async put(source: BlobSource, opts: PutOptions = {}): Promise<PutResult> {
    await this.init();
    const tmp = join(this.tmpDir, `${randomUUID()}.part`);
    const hash = createHash('sha256');
    let size = 0;
    const limit = opts.maxBytes;

    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (limit !== undefined && size > limit) return cb(new BlobTooLargeError(limit));
        hash.update(chunk);
        cb(null, chunk);
      },
    });

    const input = Buffer.isBuffer(source) || source instanceof Uint8Array ? Readable.from([source]) : Readable.from(source);
    try {
      await pipeline(input, meter, createWriteStream(tmp, { flags: 'wx', mode: 0o640 }));
      const fh = await open(tmp, 'r');
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }

    const sha256 = hash.digest('hex');
    const target = this.pathFor(sha256);
    if (await this.exists(sha256)) {
      await unlink(tmp);
      return { sha256, size, created: false };
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o750 });
    await rename(tmp, target);
    return { sha256, size, created: true };
  }

  async exists(sha256: string): Promise<boolean> {
    try {
      return (await stat(this.pathFor(sha256))).isFile();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  async size(sha256: string): Promise<number> {
    return (await stat(this.pathFor(sha256))).size;
  }

  /** Stream a blob, optionally a byte range (inclusive `end`, as in HTTP Range). */
  createReadStream(sha256: string, range?: { start: number; end: number }): ReadStream {
    return createReadStream(this.pathFor(sha256), range);
  }

  async read(sha256: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.createReadStream(sha256)) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  /** Remove a blob. Callers are responsible for reference counting. */
  async delete(sha256: string): Promise<boolean> {
    try {
      await unlink(this.pathFor(sha256));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }
}

/**
 * Parse a single-range HTTP `Range` header (`bytes=start-end`, `bytes=start-`,
 * `bytes=-suffix`). Returns null when absent/unsupported, 'unsatisfiable' when
 * the range lies outside the resource.
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}
