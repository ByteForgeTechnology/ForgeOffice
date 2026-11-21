import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { driveUploads, orm, type DriveLibrary } from '@forge/db';
import type { DriveContext } from './context';
import { DriveError, checkName, storeFile, type Conflict } from './items';

const { and, eq, lt } = orm;

/**
 * Resumable uploads: create a session, send the file in chunks (each with its
 * offset), and resume after a dropped connection by asking how much arrived.
 * Chunks are appended to a temp file on forge_drive_data; when the last byte
 * arrives the file is hashed into the blob store and a version is recorded.
 */
const dir = (ctx: Pick<DriveContext, 'root'>) => join(ctx.root, '.uploads');
const partPath = (ctx: Pick<DriveContext, 'root'>, id: string) => join(dir(ctx), `${id}.part`);

export async function createUpload(ctx: DriveContext, input: { lib: DriveLibrary; parentId: string | null; itemId?: string; name: string; mime?: string | null; size: number; userId: string; maxBytes: number }) {
  checkName(input.name);
  if (input.size < 0 || input.size > input.maxBytes) throw new DriveError(413, `Files can be at most ${Math.round(input.maxBytes / 1048576)} MB`, 'too_large');
  await mkdir(dir(ctx), { recursive: true });
  const [row] = await ctx.db
    .insert(driveUploads)
    .values({ libraryId: input.lib.id, parentId: input.parentId, itemId: input.itemId ?? null, name: input.name, mime: input.mime ?? null, size: input.size, createdBy: input.userId, expiresAt: new Date(Date.now() + 24 * 3600_000) })
    .returning();
  await rm(partPath(ctx, row!.id), { force: true });
  return row!;
}

export async function uploadStatus(ctx: DriveContext, id: string, userId: string) {
  const [row] = await ctx.db.select().from(driveUploads).where(and(eq(driveUploads.id, id), eq(driveUploads.createdBy, userId))).limit(1);
  if (!row) throw new DriveError(404, 'Upload not found or expired');
  return row;
}

/**
 * Append a chunk at `offset` (must equal the bytes received so far). Returns
 * the session, and the stored file once the upload is complete.
 */
export async function appendChunk(ctx: DriveContext, input: { id: string; userId: string; offset: number; body: Readable; lib: DriveLibrary; conflict?: Conflict }) {
  const up = await uploadStatus(ctx, input.id, input.userId);
  if (input.offset !== up.received) throw new DriveError(409, `Expected offset ${up.received}`, 'offset_mismatch');
  const path = partPath(ctx, up.id);
  let written = 0;
  const limit = up.size - up.received;
  await pipeline(
    input.body,
    async function* (source) {
      for await (const chunk of source as AsyncIterable<Buffer>) {
        written += chunk.length;
        if (written > limit) throw new DriveError(400, 'More data than the declared file size', 'too_much_data');
        yield chunk;
      }
    },
    createWriteStream(path, { flags: 'a' }),
  );
  // The file on disk is the truth (a failed request may have written part of a chunk).
  const received = (await stat(path).catch(() => ({ size: 0 }))).size;
  const [row] = await ctx.db.update(driveUploads).set({ received }).where(eq(driveUploads.id, up.id)).returning();
  if (received < up.size) return { upload: row!, stored: null };

  try {
    const stored = await storeFile(ctx, {
      lib: input.lib,
      parentId: up.parentId,
      itemId: up.itemId ?? undefined,
      name: up.name,
      mime: up.mime,
      source: createReadStream(path),
      userId: input.userId,
      conflict: input.conflict ?? 'rename',
    });
    return { upload: row!, stored };
  } finally {
    await rm(path, { force: true });
    await ctx.db.delete(driveUploads).where(eq(driveUploads.id, up.id));
  }
}

export async function cancelUpload(ctx: DriveContext, id: string, userId: string) {
  const up = await uploadStatus(ctx, id, userId);
  await rm(partPath(ctx, up.id), { force: true });
  await ctx.db.delete(driveUploads).where(eq(driveUploads.id, up.id));
}

/** Scheduled clean-up of uploads that were never finished. */
export async function cleanupUploads(ctx: DriveContext) {
  const stale = await ctx.db.delete(driveUploads).where(lt(driveUploads.expiresAt, new Date())).returning({ id: driveUploads.id });
  for (const s of stale) await rm(partPath(ctx, s.id), { force: true });
  return stale.length;
}
