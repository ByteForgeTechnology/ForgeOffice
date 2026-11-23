import sharp from 'sharp';
import { orm, users, type User } from '@forge/db';
import type { AppContext } from '../context';
import { badRequest } from '../errors';
import { releaseBlob, retainBlob } from './assets';

const { eq } = orm;

/** Largest picture accepted before resizing (phone photos are often 5–10 MB). */
export const MAX_AVATAR_BYTES = 15 * 1024 * 1024;
const SIZE = 512;

/** Where a user's picture is served (no session needed, so <img> works anywhere), or null. */
export const avatarUrl = (u: Pick<User, 'id' | 'avatarSha'>) => (u.avatarSha ? `/api/v1/avatars/${u.id}?v=${u.avatarSha.slice(0, 12)}` : null);

/**
 * Any common photo format as a data URL → a square 512×512 WebP: turned the
 * right way up (EXIF), cropped around the most interesting area, metadata
 * (location and camera details) dropped.
 */
export async function processAvatar(dataUrl: string): Promise<Buffer> {
  const m = /^data:image\/(png|jpeg|jpg|webp|gif|avif|heic|heif|tiff);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!m) throw badRequest('Choose a photo (JPEG, PNG, WebP, GIF or AVIF)');
  const input = Buffer.from(m[2]!, 'base64');
  if (!input.length) throw badRequest('That picture is empty');
  if (input.length > MAX_AVATAR_BYTES) throw badRequest('Choose a picture smaller than 15 MB');
  try {
    return await sharp(input, { limitInputPixels: 60_000_000, animated: false })
      .rotate()
      .resize(SIZE, SIZE, { fit: 'cover', position: sharp.strategy.attention })
      .webp({ quality: 85 })
      .toBuffer();
  } catch {
    throw badRequest('That file isn’t a picture we can read');
  }
}

/** Set (or with null, remove) someone's picture; the old one's blob is released. */
export async function setAvatar(ctx: AppContext, user: Pick<User, 'id' | 'avatarSha'>, image: Buffer | null) {
  const sha = image ? await retainBlob(ctx.db, ctx.assets, 'drive', image, 'image/webp') : null;
  await ctx.db.update(users).set({ avatarSha: sha, updatedAt: new Date() }).where(eq(users.id, user.id));
  // Re-uploading the same picture took a second reference: keep one.
  if (user.avatarSha) await releaseBlob(ctx.db, ctx.assets, user.avatarSha);
  return sha;
}
