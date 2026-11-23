import type { Readable } from 'node:stream';
import { OffsetMismatchError, TooMuchDataError } from '@forge/storage';
import { driveUploads, orm, type DriveLibrary } from '@forge/db';
import type { DriveContext } from './context';
import { DriveError, checkName, storeFile, type Conflict } from './items';

const { and, eq, lt } = orm;

/**
 * Resumable uploads: create a session, send the file in chunks (each with its
 * offset), and resume after a dropped connection by asking how much arrived.
 * Chunks go to the upload store (a part file on forge_drive_data, or one
 * storage node in a cluster, so any drive-api instance can take the next
 * chunk); when the last byte arrives it becomes a blob and a version is recorded.
 */
export async function createUpload(ctx: DriveContext, input: { lib: DriveLibrary; parentId: string | null; itemId?: string; name: string; mime?: string | null; size: number; userId: string; maxBytes: number }) {
  checkName(input.name);
  if (input.size < 0 || input.size > input.maxBytes) throw new DriveError(413, `Files can be at most ${Math.round(input.maxBytes / 1048576)} MB`, 'too_large');
  const [row] = await ctx.db
    .insert(driveUploads)
    .values({ libraryId: input.lib.id, parentId: input.parentId, itemId: input.itemId ?? null, name: input.name, mime: input.mime ?? null, size: input.size, createdBy: input.userId, expiresAt: new Date(Date.now() + 24 * 3600_000) })
    .returning();
  await ctx.uploads.discard(row!.id);
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
  let received: number;
  try {
    received = await ctx.uploads.append(up.id, input.offset, input.body, up.size - up.received);
  } catch (err) {
    if (err instanceof OffsetMismatchError) {
      await ctx.db.update(driveUploads).set({ received: err.expected }).where(eq(driveUploads.id, up.id));
      throw new DriveError(409, `Expected offset ${err.expected}`, 'offset_mismatch');
    }
    if (err instanceof TooMuchDataError) throw new DriveError(400, 'More data than the declared file size', 'too_much_data');
    // Part of a chunk may have arrived: record what is really there.
    await ctx.db.update(driveUploads).set({ received: await ctx.uploads.size(up.id) }).where(eq(driveUploads.id, up.id));
    throw err;
  }
  const [row] = await ctx.db.update(driveUploads).set({ received }).where(eq(driveUploads.id, up.id)).returning();
  if (received < up.size) return { upload: row!, stored: null };

  try {
    const blob = await ctx.uploads.commit(up.id);
    const stored = await storeFile(ctx, {
      lib: input.lib,
      parentId: up.parentId,
      itemId: up.itemId ?? undefined,
      name: up.name,
      mime: up.mime,
      source: { sha256: blob.sha256, size: blob.size },
      userId: input.userId,
      conflict: input.conflict ?? 'rename',
    });
    return { upload: row!, stored };
  } finally {
    await ctx.uploads.discard(up.id).catch(() => {});
    await ctx.db.delete(driveUploads).where(eq(driveUploads.id, up.id));
  }
}

export async function cancelUpload(ctx: DriveContext, id: string, userId: string) {
  const up = await uploadStatus(ctx, id, userId);
  await ctx.uploads.discard(up.id);
  await ctx.db.delete(driveUploads).where(eq(driveUploads.id, up.id));
}

/** Scheduled clean-up of uploads that were never finished. */
export async function cleanupUploads(ctx: DriveContext) {
  const stale = await ctx.db.delete(driveUploads).where(lt(driveUploads.expiresAt, new Date())).returning({ id: driveUploads.id });
  for (const s of stale) await ctx.uploads.discard(s.id).catch(() => {});
  return stale.length;
}
