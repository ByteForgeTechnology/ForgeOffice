import { connect } from 'node:net';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { driveItems, driveVersions, orm } from '@forge/db';
import type { DriveContext } from './context';

const { and, eq } = orm;

// ---------------------------------------------------------------------------
// Virus scanning (ClamAV clamd INSTREAM)
// ---------------------------------------------------------------------------

/** Send bytes to clamd and return its verdict. */
export function clamdScan(host: string, port: number, data: AsyncIterable<Buffer>, timeoutMs = 120_000): Promise<{ clean: boolean; signature: string | null; raw: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let reply = '';
    const timer = setTimeout(() => socket.destroy(new Error('ClamAV timed out')), timeoutMs);
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on('data', (d) => (reply += d.toString()));
    socket.on('end', () => {
      clearTimeout(timer);
      const raw = reply.replace(/\0/g, '').trim();
      if (/ERROR$/.test(raw)) return reject(new Error(raw));
      const found = /: (.+) FOUND$/.exec(raw);
      resolve({ clean: /: OK$/.test(raw), signature: found?.[1] ?? null, raw });
    });
    socket.on('connect', async () => {
      try {
        socket.write('zINSTREAM\0');
        for await (const chunk of data) {
          for (let i = 0; i < chunk.length; i += 64 * 1024) {
            const part = chunk.subarray(i, i + 64 * 1024);
            const len = Buffer.alloc(4);
            len.writeUInt32BE(part.length);
            socket.write(len);
            socket.write(part);
          }
        }
        socket.end(Buffer.alloc(4)); // zero-length chunk ends the stream
      } catch (err) {
        socket.destroy(err as Error);
      }
    });
  });
}

/** Is clamd answering? (admin status) */
export function clamdPing(host: string, port: number, timeoutMs = 3_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let reply = '';
    const timer = setTimeout(() => socket.destroy(new Error('timed out')), timeoutMs);
    socket.on('error', (e) => (clearTimeout(timer), reject(e)));
    socket.on('connect', () => socket.end('zVERSION\0'));
    socket.on('data', (d) => (reply += d.toString()));
    socket.on('end', () => (clearTimeout(timer), resolve(reply.replace(/\0/g, '').trim())));
  });
}

async function versionFor(ctx: Pick<DriveContext, 'db'>, itemId: string, versionId: string) {
  const [row] = await ctx.db.select({ item: driveItems, version: driveVersions }).from(driveVersions).innerJoin(driveItems, eq(driveItems.id, driveVersions.itemId)).where(and(eq(driveVersions.id, versionId), eq(driveVersions.itemId, itemId))).limit(1);
  return row ?? null;
}

/**
 * Scan a stored version. Infected files are marked so they can't be
 * downloaded or shared. Only the current version updates the item's status.
 */
export async function scanVersion(ctx: DriveContext, job: { itemId: string; versionId: string }) {
  const row = await versionFor(ctx, job.itemId, job.versionId);
  if (!row) return 'gone' as const;
  if (!ctx.clamav) {
    if (row.item.versionId === job.versionId) await ctx.db.update(driveItems).set({ scanStatus: 'skipped' }).where(eq(driveItems.id, job.itemId));
    return 'skipped' as const;
  }
  const verdict = await clamdScan(ctx.clamav.host, ctx.clamav.port, ctx.blobs.createReadStream(row.version.blobSha) as AsyncIterable<Buffer>);
  if (row.item.versionId === job.versionId)
    await ctx.db
      .update(driveItems)
      .set({ scanStatus: verdict.clean ? 'clean' : 'infected', scanDetail: verdict.clean ? null : (verdict.signature ?? verdict.raw) })
      .where(eq(driveItems.id, job.itemId));
  if (!verdict.clean) ctx.log.warn({ itemId: job.itemId, signature: verdict.signature }, 'virus found in uploaded file');
  return verdict.clean ? ('clean' as const) : ('infected' as const);
}

// ---------------------------------------------------------------------------
// Thumbnails (sharp → WebP in forge_drive_data/.previews) and text for search
// ---------------------------------------------------------------------------

const IMAGE = /^image\/(png|jpeg|gif|webp|avif|tiff|bmp|heic|heif|svg\+xml)$/;
const TEXT = /^(text\/|application\/(json|xml))/;
const MAX_TEXT = 2 * 1024 * 1024;

export const previewPath = (ctx: Pick<DriveContext, 'root'>, sha256: string) => join(ctx.root, '.previews', sha256.slice(0, 2), `${sha256}.webp`);

export async function makeThumbnail(input: Buffer): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  return sharp(input, { failOn: 'none', limitInputPixels: 100_000_000 }).rotate().resize(480, 480, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
}

export async function pdfText(data: Uint8Array, maxPages = 300): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  try {
    let out = '';
    for (let i = 1; i <= Math.min(doc.numPages, maxPages) && out.length < MAX_TEXT; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      out += content.items.map((it) => ('str' in it ? it.str : '')).join(' ') + '\n';
    }
    return out.slice(0, MAX_TEXT);
  } finally {
    await task.destroy();
  }
}

/** Thumbnail and searchable text for a version. Failures are logged, never fatal. */
export async function processVersion(ctx: DriveContext, job: { itemId: string; versionId: string }) {
  const row = await versionFor(ctx, job.itemId, job.versionId);
  if (!row || row.item.versionId !== job.versionId || row.item.scanStatus === 'infected') return { thumbnail: false, text: false };
  const { blobSha: sha, mime, size } = row.version;
  let thumbnail = false;
  let text: string | null = null;
  try {
    if (mime && IMAGE.test(mime) && size < 200 * 1024 * 1024) {
      const path = previewPath(ctx, sha);
      const exists = await readFile(path).then(() => true).catch(() => false);
      if (!exists) {
        const webp = await makeThumbnail(await ctx.blobs.read(sha));
        await mkdir(join(path, '..'), { recursive: true });
        await writeFile(path, webp);
      }
      thumbnail = true;
    }
  } catch (err) {
    ctx.log.warn({ err: (err as Error).message, itemId: job.itemId }, 'thumbnail failed');
  }
  try {
    if (mime === 'application/pdf' && size < 200 * 1024 * 1024) text = await pdfText(new Uint8Array(await ctx.blobs.read(sha)));
    else if (mime && TEXT.test(mime)) text = (await ctx.blobs.read(sha)).subarray(0, MAX_TEXT).toString('utf8');
  } catch (err) {
    ctx.log.warn({ err: (err as Error).message, itemId: job.itemId }, 'text extraction failed');
  }
  await ctx.db
    .update(driveItems)
    .set({ thumbnailSha: thumbnail ? sha : null, ...(text !== null ? { textContent: text.replace(/\0/g, '') } : {}) })
    .where(and(eq(driveItems.id, job.itemId), eq(driveItems.versionId, job.versionId)));
  return { thumbnail, text: text !== null };
}

/** Remove a preview when no version uses that content any more. */
export async function dropPreview(ctx: Pick<DriveContext, 'root'>, sha256: string) {
  await rm(previewPath(ctx, sha256), { force: true });
}
