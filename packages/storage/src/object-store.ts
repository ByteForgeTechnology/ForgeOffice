import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { BlobStore, PutOptions, PutResult } from './blob-store';

/**
 * Storage interfaces used by ForgeOffice. Each has a local implementation
 * (one machine, files on a volume) and a cluster implementation (storage
 * nodes over HTTP, with copies on several nodes; see cluster.ts).
 */

/** Content-addressed blobs (mail messages, Drive file versions, recordings, pictures). */
export interface ObjectStore {
  put(source: Readable | Buffer | Uint8Array | AsyncIterable<Uint8Array>, opts?: PutOptions): Promise<PutResult>;
  read(sha256: string): Promise<Buffer>;
  exists(sha256: string): Promise<boolean>;
  size(sha256: string): Promise<number>;
  /** Stream a blob, optionally a byte range (inclusive end, as HTTP Range). Errors surface on the stream. */
  createReadStream(sha256: string, range?: { start: number; end: number }): Readable;
  delete(sha256: string): Promise<boolean>;
}

/** Objects under a key you choose (Drive previews, keyed by the file's SHA-256). */
export interface KeyedStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

/** Resumable uploads: chunks appended at an offset, then turned into a blob. */
export interface UploadStore {
  /** Append `body` at `offset` (must equal the bytes stored so far); returns the new size. */
  append(id: string, offset: number, body: Readable | AsyncIterable<Uint8Array>, limit: number): Promise<number>;
  /** Bytes stored so far (0 for an unknown upload). */
  size(id: string): Promise<number>;
  /** Hash the upload into the blob store and forget it. */
  commit(id: string, opts?: PutOptions): Promise<PutResult>;
  discard(id: string): Promise<void>;
}

export const KEY_RE = /^[a-f0-9]{64}$/;
export const UPLOAD_ID_RE = /^[a-zA-Z0-9-]{8,64}$/;

export class OffsetMismatchError extends Error {
  constructor(readonly expected: number) {
    super(`Expected offset ${expected}`);
    this.name = 'OffsetMismatchError';
  }
}
export class TooMuchDataError extends Error {
  constructor() {
    super('More data than the declared size');
    this.name = 'TooMuchDataError';
  }
}

/** Previews and similar on a local directory: <root>/<aa>/<key><suffix>. */
export class LocalKeyedStore implements KeyedStore {
  constructor(
    readonly root: string,
    private readonly suffix = '',
  ) {}

  path(key: string) {
    if (!KEY_RE.test(key)) throw new Error('invalid key');
    return join(this.root, key.slice(0, 2), `${key}${this.suffix}`);
  }

  async put(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, data);
    await import('node:fs/promises').then((fs) => fs.rename(tmp, p));
  }

  async get(key: string) {
    return readFile(this.path(key)).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
  }

  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
}

/** Upload sessions as part files in a local directory, committed into a local blob store. */
export class LocalUploadStore implements UploadStore {
  constructor(
    readonly dir: string,
    private readonly blobs: Pick<BlobStore, 'put'>,
  ) {}

  private path(id: string) {
    if (!UPLOAD_ID_RE.test(id)) throw new Error('invalid upload id');
    return join(this.dir, `${id}.part`);
  }

  async size(id: string) {
    return (await stat(this.path(id)).catch(() => ({ size: 0 }))).size;
  }

  async append(id: string, offset: number, body: Readable | AsyncIterable<Uint8Array>, limit: number) {
    const path = this.path(id);
    await mkdir(this.dir, { recursive: true });
    const current = await this.size(id);
    if (offset !== current) throw new OffsetMismatchError(current);
    let written = 0;
    await pipeline(
      Readable.from(body),
      async function* (source) {
        for await (const chunk of source as AsyncIterable<Buffer>) {
          written += chunk.length;
          if (written > limit) throw new TooMuchDataError();
          yield chunk;
        }
      },
      createWriteStream(path, { flags: 'a' }),
    );
    // The file is the truth (a failed request may have written part of a chunk).
    return this.size(id);
  }

  async commit(id: string, opts?: PutOptions) {
    const path = this.path(id);
    try {
      return await this.blobs.put(createReadStream(path), opts);
    } finally {
      await rm(path, { force: true });
    }
  }

  async discard(id: string) {
    await rm(this.path(id), { force: true });
  }
}
