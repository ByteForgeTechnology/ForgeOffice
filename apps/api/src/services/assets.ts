import { blobs, orm, type Database } from '@forge/db';
import type { BlobStore } from '@forge/storage';
import { badRequest } from '../errors';

const { eq, sql } = orm;

const IMAGE_TYPES: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

export const MAX_LOGO_BYTES = 512 * 1024;

/**
 * Decode a `data:image/...;base64,` URL and check the bytes really are the
 * declared raster format. SVG is rejected because it can carry script.
 */
export function decodeImageDataUrl(dataUrl: string, maxBytes = MAX_LOGO_BYTES): { mime: string; data: Buffer } {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!m) throw badRequest('Logo must be a PNG, JPEG or WebP image');
  const mime = m[1]!;
  const data = Buffer.from(m[2]!, 'base64');
  if (data.length === 0) throw badRequest('Logo image is empty');
  if (data.length > maxBytes) throw badRequest(`Logo must be smaller than ${Math.round(maxBytes / 1024)} KB`);
  if (!IMAGE_TYPES[mime]!(data)) throw badRequest('Logo content does not match its declared image type');
  return { mime, data };
}

/** Store bytes in the blob store and take a reference on the blob row. */
export async function retainBlob(db: Database, store: BlobStore, volume: string, data: Buffer, mime: string | null): Promise<string> {
  const { sha256, size } = await store.put(data);
  await db
    .insert(blobs)
    .values({ sha256, volume, size, mime, refCount: 1 })
    .onConflictDoUpdate({ target: blobs.sha256, set: { refCount: sql`${blobs.refCount} + 1` } });
  return sha256;
}

/** Drop a reference; the file is deleted when nothing references it any more. */
export async function releaseBlob(db: Database, store: BlobStore, sha256: string): Promise<void> {
  const [row] = await db
    .update(blobs)
    .set({ refCount: sql`greatest(${blobs.refCount} - 1, 0)` })
    .where(eq(blobs.sha256, sha256))
    .returning();
  if (row && row.refCount === 0) {
    await db.delete(blobs).where(eq(blobs.sha256, sha256));
    await store.delete(sha256);
  }
}
