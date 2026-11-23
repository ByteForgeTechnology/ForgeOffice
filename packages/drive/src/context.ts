import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { blobs, orm, type Database } from '@forge/db';
import type { BlobStore } from '@forge/storage';

const { eq, sql } = orm;

export interface DriveLogger {
  info: (o: unknown, m?: string) => void;
  warn: (o: unknown, m?: string) => void;
  error: (o: unknown, m?: string) => void;
}

/** Minimal Redis surface for locks (ioredis compatible). */
export interface LockStore {
  set(key: string, value: string, px: 'PX', ttl: number, nx: 'NX'): Promise<'OK' | null>;
  eval(script: string, keys: number, ...args: string[]): Promise<unknown>;
}

export interface DriveContext {
  db: Database;
  /** Content-addressed blobs on forge_drive_data (shared with organisation assets). */
  blobs: BlobStore;
  /** Root of forge_drive_data: uploads in progress (.uploads) and previews (.previews) live here. */
  root: string;
  log: DriveLogger;
  /** Redis for locks; without it an in-process lock is used (single process). */
  redis?: LockStore | null;
  /** Called after a new file version is stored (scan, thumbnails, text extraction). */
  onVersionStored?: (job: { itemId: string; versionId: string }) => void | Promise<void>;
  /** ClamAV daemon (host:port); unset = scanning off. */
  clamav?: { host: string; port: number } | null;
}

/** Take a reference on a stored blob (identical content is stored once). */
export async function retain(ctx: Pick<DriveContext, 'db'>, sha256: string, size: number, mime: string | null) {
  await ctx.db
    .insert(blobs)
    .values({ sha256, volume: 'drive', size, mime, refCount: 1 })
    .onConflictDoUpdate({ target: blobs.sha256, set: { refCount: sql`${blobs.refCount} + 1` } });
}

/** Drop a reference; the bytes are deleted when nothing uses them any more. */
export async function release(ctx: Pick<DriveContext, 'db' | 'blobs'> & Partial<Pick<DriveContext, 'root'>>, sha256: string) {
  const [row] = await ctx.db
    .update(blobs)
    .set({ refCount: sql`greatest(${blobs.refCount} - 1, 0)` })
    .where(eq(blobs.sha256, sha256))
    .returning();
  if (row && row.refCount === 0) {
    await ctx.db.delete(blobs).where(eq(blobs.sha256, sha256));
    await ctx.blobs.delete(sha256);
    if (ctx.root) await rm(join(ctx.root, '.previews', sha256.slice(0, 2), `${sha256}.webp`), { force: true });
  }
}

// ---------------------------------------------------------------------------
// Locks: Redis mutex (SET NX PX) across containers, in-process otherwise
// ---------------------------------------------------------------------------

const local = new Map<string, Promise<void>>();
const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export class LockedError extends Error {
  constructor(message = 'Someone else is changing this item. Try again in a moment.') {
    super(message);
    this.name = 'LockedError';
  }
}

/** Run `fn` while holding a short mutex on `key` (e.g. while committing a new version of a file). */
export async function withLock<T>(ctx: Pick<DriveContext, 'redis'>, key: string, fn: () => Promise<T>, ttlMs = 60_000): Promise<T> {
  const name = `forge:drive:lock:${key}`;
  if (ctx.redis) {
    const token = `${process.pid}:${Math.random().toString(36).slice(2)}`;
    for (let i = 0; i < 50; i++) {
      if ((await ctx.redis.set(name, token, 'PX', ttlMs, 'NX')) === 'OK') {
        try {
          return await fn();
        } finally {
          await ctx.redis.eval(RELEASE, 1, name, token).catch(() => {});
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new LockedError();
  }
  const previous = local.get(name) ?? Promise.resolve();
  let done!: () => void;
  const mine = new Promise<void>((r) => (done = r));
  local.set(name, previous.then(() => mine));
  await previous;
  try {
    return await fn();
  } finally {
    done();
    if (local.get(name) === mine) local.delete(name);
  }
}
