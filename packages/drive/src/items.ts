import { Readable } from 'node:stream';
import { driveActivity, driveItems, driveLibraries, drivePermissions, driveVersions, orm, organizations, users, type DriveItem, type DriveLibrary } from '@forge/db';
import { release, retain, withLock, type DriveContext } from './context';

const { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql } = orm;

export class DriveError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 423 | 507,
    message: string,
    readonly code = 'drive_error',
  ) {
    super(message);
    this.name = 'DriveError';
  }
}

const ROOT = '00000000-0000-0000-0000-000000000000';

// ---------------------------------------------------------------------------
// Names and types
// ---------------------------------------------------------------------------

/** Names that work on Windows, macOS and Linux alike. */
export function checkName(raw: string): string {
  const name = raw.normalize('NFC').trim();
  if (!name || name === '.' || name === '..') throw new DriveError(400, 'Enter a name');
  if (name.length > 255) throw new DriveError(400, 'Names can be at most 255 characters');
  if (/[\\/:*?"<>|\x00-\x1f]/.test(name)) throw new DriveError(400, 'Names cannot contain \\ / : * ? " < > |');
  if (/[. ]$/.test(name)) throw new DriveError(400, 'Names cannot end with a dot or a space');
  return name;
}

const TYPES: Record<string, string> = {
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html', xml: 'application/xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', heic: 'image/heic', tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
  zip: 'application/zip', gz: 'application/gzip', '7z': 'application/x-7z-compressed',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
};
export const extensionOf = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');
export const mimeFor = (name: string, given?: string | null) => TYPES[extensionOf(name)] ?? (given && given !== 'application/octet-stream' ? given : 'application/octet-stream');

// ---------------------------------------------------------------------------
// Reading the tree
// ---------------------------------------------------------------------------

export async function children(ctx: Pick<DriveContext, 'db'>, libraryId: string, parentId: string | null) {
  return ctx.db
    .select()
    .from(driveItems)
    .where(and(eq(driveItems.libraryId, libraryId), parentId ? eq(driveItems.parentId, parentId) : isNull(driveItems.parentId), isNull(driveItems.deletedAt)))
    .orderBy(desc(sql`${driveItems.kind} = 'folder'`), asc(sql`lower(${driveItems.name})`));
}

/** Folders from the library root down to (and including) the item. */
export async function ancestors(ctx: Pick<DriveContext, 'db'>, item: DriveItem): Promise<DriveItem[]> {
  const chain: DriveItem[] = [item];
  const seen = new Set([item.id]);
  let cur = item;
  while (cur.parentId && !seen.has(cur.parentId)) {
    const [p] = await ctx.db.select().from(driveItems).where(eq(driveItems.id, cur.parentId)).limit(1);
    if (!p) break;
    chain.unshift(p);
    seen.add(p.id);
    cur = p;
  }
  return chain;
}

/** Every item in a subtree (the item first). */
export async function subtree(ctx: Pick<DriveContext, 'db'>, rootId: string, opts: { deleted?: 'live' | 'any' } = {}): Promise<DriveItem[]> {
  const [root] = await ctx.db.select().from(driveItems).where(eq(driveItems.id, rootId)).limit(1);
  if (!root) return [];
  const all: DriveItem[] = [root];
  let frontier = [root.id];
  while (frontier.length) {
    const next = await ctx.db
      .select()
      .from(driveItems)
      .where(and(inArray(driveItems.parentId, frontier), opts.deleted === 'any' ? undefined : isNull(driveItems.deletedAt)));
    all.push(...next);
    frontier = next.filter((n) => n.kind === 'folder').map((n) => n.id);
  }
  return all;
}

async function nameTaken(ctx: Pick<DriveContext, 'db'>, libraryId: string, parentId: string | null, name: string, except?: string) {
  const [row] = await ctx.db
    .select({ id: driveItems.id, kind: driveItems.kind })
    .from(driveItems)
    .where(and(eq(driveItems.libraryId, libraryId), sql`coalesce(${driveItems.parentId}, ${ROOT}::uuid) = coalesce(${parentId}::uuid, ${ROOT}::uuid)`, sql`lower(${driveItems.name}) = lower(${name})`, isNull(driveItems.deletedAt)))
    .limit(2);
  return row && row.id !== except ? row : null;
}

/** "Report.pdf" → "Report (2).pdf" until the name is free. */
export async function freeName(ctx: Pick<DriveContext, 'db'>, libraryId: string, parentId: string | null, name: string): Promise<string> {
  if (!(await nameTaken(ctx, libraryId, parentId, name))) return name;
  const dot = name.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!(await nameTaken(ctx, libraryId, parentId, candidate))) return candidate;
  }
  throw new DriveError(409, 'Too many items with this name');
}

async function checkParent(ctx: Pick<DriveContext, 'db'>, libraryId: string, parentId: string | null) {
  if (!parentId) return;
  const [p] = await ctx.db.select().from(driveItems).where(eq(driveItems.id, parentId)).limit(1);
  if (!p || p.libraryId !== libraryId || p.kind !== 'folder' || p.deletedAt) throw new DriveError(404, 'Folder not found');
}

export async function logActivity(ctx: Pick<DriveContext, 'db'>, a: { libraryId: string; item?: Pick<DriveItem, 'id' | 'name'> | null; userId: string | null; action: string; detail?: Record<string, unknown> }) {
  await ctx.db.insert(driveActivity).values({ libraryId: a.libraryId, itemId: a.item?.id ?? null, itemName: a.item?.name ?? '', userId: a.userId, action: a.action, detail: a.detail ?? null });
}

// ---------------------------------------------------------------------------
// Storage usage and quotas
// ---------------------------------------------------------------------------

/** Count bytes against the library and, for "My files", against the owner's quota (shared with their mailbox). */
async function addUsage(ctx: Pick<DriveContext, 'db'>, lib: DriveLibrary, bytes: number) {
  if (!bytes) return;
  await ctx.db.update(driveLibraries).set({ usedBytes: sql`greatest(${driveLibraries.usedBytes} + ${bytes}, 0)` }).where(eq(driveLibraries.id, lib.id));
  if (lib.kind === 'personal' && lib.ownerUserId) await ctx.db.update(users).set({ usedBytes: sql`greatest(${users.usedBytes} + ${bytes}, 0)` }).where(eq(users.id, lib.ownerUserId));
}

async function checkQuota(ctx: Pick<DriveContext, 'db'>, lib: DriveLibrary, bytes: number) {
  if (lib.kind !== 'personal' || !lib.ownerUserId) return;
  const [row] = await ctx.db
    .select({ used: users.usedBytes, own: users.quotaBytes, def: organizations.defaultQuotaBytes })
    .from(users)
    .innerJoin(organizations, eq(organizations.id, users.orgId))
    .where(eq(users.id, lib.ownerUserId))
    .limit(1);
  const quota = row?.own ?? row?.def ?? 0;
  if (quota > 0 && (row?.used ?? 0) + bytes > quota) throw new DriveError(507, 'Not enough storage space left. Delete some files or empty the recycle bin.', 'quota_exceeded');
}

// ---------------------------------------------------------------------------
// Creating and saving
// ---------------------------------------------------------------------------

export type Conflict = 'fail' | 'rename' | 'replace';

export async function createFolder(ctx: Pick<DriveContext, 'db'>, lib: DriveLibrary, parentId: string | null, rawName: string, userId: string, conflict: Conflict = 'fail') {
  await checkParent(ctx, lib.id, parentId);
  let name = checkName(rawName);
  if (await nameTaken(ctx, lib.id, parentId, name)) {
    if (conflict === 'fail') throw new DriveError(409, `"${name}" already exists here`, 'name_conflict');
    name = await freeName(ctx, lib.id, parentId, name);
  }
  const [folder] = await ctx.db.insert(driveItems).values({ libraryId: lib.id, parentId, kind: 'folder', name, createdBy: userId, updatedBy: userId }).returning();
  await logActivity(ctx, { libraryId: lib.id, item: folder!, userId, action: 'folder_created' });
  return folder!;
}

export interface StoreFileInput {
  lib: DriveLibrary;
  parentId: string | null;
  name: string;
  mime?: string | null;
  source: Readable | Buffer;
  userId: string;
  /** Save as a new version of this file. */
  itemId?: string;
  /** When a file of that name exists: fail, save alongside under a free name, or add a new version. */
  conflict?: Conflict;
  comment?: string;
  maxBytes?: number;
}

/**
 * Store a file (new, or a new version): stream it into the blob store while
 * hashing, then record the version. Identical content is stored once.
 */
export async function storeFile(ctx: DriveContext, input: StoreFileInput) {
  const { lib, userId } = input;
  await checkParent(ctx, lib.id, input.parentId);
  const name = checkName(input.name);
  const put = await ctx.blobs.put(input.source, { maxBytes: input.maxBytes }).catch((err: Error) => {
    if (err.name === 'BlobTooLargeError') throw new DriveError(413, err.message, 'too_large');
    throw err;
  });
  const mime = mimeFor(name, input.mime);
  try {
    await checkQuota(ctx, lib, put.size);
  } catch (err) {
    if (put.created) await ctx.blobs.delete(put.sha256).catch(() => {});
    throw err;
  }
  await retain(ctx, put.sha256, put.size, mime);

  // Serialise saves of the same name/file so concurrent uploads become separate versions.
  const key = input.itemId ?? `${lib.id}:${input.parentId ?? 'root'}:${name.toLowerCase()}`;
  const result = await withLock(ctx, key, async () => {
    let target: DriveItem | undefined;
    if (input.itemId) {
      [target] = await ctx.db.select().from(driveItems).where(eq(driveItems.id, input.itemId)).limit(1);
      if (!target || target.kind !== 'file' || target.deletedAt) throw new DriveError(404, 'File not found');
    } else {
      const existing = await nameTaken(ctx, lib.id, input.parentId, name);
      if (existing) {
        if (existing.kind === 'folder' || (input.conflict ?? 'fail') === 'fail') throw new DriveError(409, `"${name}" already exists here`, 'name_conflict');
        if (input.conflict === 'replace') [target] = await ctx.db.select().from(driveItems).where(eq(driveItems.id, existing.id)).limit(1);
      }
    }
    if (target?.checkedOutBy && target.checkedOutBy !== userId) throw new DriveError(423, 'This file is checked out by someone else', 'checked_out');

    let item: DriveItem;
    if (!target) {
      const finalName = input.conflict === 'rename' ? await freeName(ctx, lib.id, input.parentId, name) : name;
      [item] = (await ctx.db.insert(driveItems).values({ libraryId: lib.id, parentId: input.parentId, kind: 'file', name: finalName, size: put.size, mime, sha256: put.sha256, createdBy: userId, updatedBy: userId }).returning()) as [DriveItem];
    } else item = target;
    const [{ n }] = (await ctx.db.select({ n: sql<number>`coalesce(max(${driveVersions.number}), 0)::int` }).from(driveVersions).where(eq(driveVersions.itemId, item.id))) as [{ n: number }];
    const [version] = await ctx.db.insert(driveVersions).values({ itemId: item.id, number: n + 1, blobSha: put.sha256, size: put.size, mime, comment: input.comment ?? '', createdBy: userId }).returning();
    [item] = (await ctx.db
      .update(driveItems)
      .set({ versionId: version!.id, size: put.size, mime, sha256: put.sha256, updatedBy: userId, scanStatus: ctx.clamav ? 'pending' : 'skipped', scanDetail: null })
      .where(eq(driveItems.id, item.id))
      .returning()) as [DriveItem];
    return { item, version: version!, isNew: !target };
  });
  await addUsage(ctx, lib, put.size);
  await logActivity(ctx, { libraryId: lib.id, item: result.item, userId, action: result.isNew ? 'file_uploaded' : 'version_added', detail: { version: result.version.number, size: put.size } });
  await Promise.resolve(ctx.onVersionStored?.({ itemId: result.item.id, versionId: result.version.id })).catch((err) => ctx.log.warn({ err }, 'could not queue file processing'));
  return result;
}

// ---------------------------------------------------------------------------
// Rename, move, copy
// ---------------------------------------------------------------------------

export async function rename(ctx: Pick<DriveContext, 'db'>, item: DriveItem, rawName: string, userId: string) {
  const name = checkName(rawName);
  if (await nameTaken(ctx, item.libraryId, item.parentId, name, item.id)) throw new DriveError(409, `"${name}" already exists here`, 'name_conflict');
  const [updated] = await ctx.db.update(driveItems).set({ name, updatedBy: userId }).where(eq(driveItems.id, item.id)).returning();
  await logActivity(ctx, { libraryId: item.libraryId, item: updated!, userId, action: 'renamed', detail: { from: item.name } });
  return updated!;
}

/** Bytes stored for a subtree (every version, so usage moves with it). */
async function subtreeBytes(ctx: Pick<DriveContext, 'db'>, ids: string[]) {
  if (!ids.length) return 0;
  const [{ total }] = (await ctx.db.select({ total: sql<number>`coalesce(sum(${driveVersions.size}), 0)::bigint` }).from(driveVersions).where(inArray(driveVersions.itemId, ids))) as [{ total: number }];
  return Number(total);
}

export async function move(ctx: Pick<DriveContext, 'db'>, item: DriveItem, from: DriveLibrary, to: DriveLibrary, parentId: string | null, userId: string, conflict: Conflict = 'fail') {
  await checkParent(ctx, to.id, parentId);
  const tree = await subtree(ctx, item.id);
  if (parentId && tree.some((t) => t.id === parentId)) throw new DriveError(400, 'A folder cannot be moved into itself');
  let name = item.name;
  if (await nameTaken(ctx, to.id, parentId, name, item.id)) {
    if (conflict !== 'rename') throw new DriveError(409, `"${name}" already exists there`, 'name_conflict');
    name = await freeName(ctx, to.id, parentId, name);
  }
  if (from.id !== to.id) {
    const bytes = await subtreeBytes(ctx, tree.map((t) => t.id));
    await checkQuota(ctx, to, bytes);
    const ids = tree.map((t) => t.id);
    await ctx.db.update(driveItems).set({ libraryId: to.id }).where(inArray(driveItems.id, ids));
    // Grants on items travel with them.
    await ctx.db.update(drivePermissions).set({ libraryId: to.id }).where(inArray(drivePermissions.itemId, ids));
    await addUsage(ctx, from, -bytes);
    await addUsage(ctx, to, bytes);
  }
  const [updated] = await ctx.db.update(driveItems).set({ parentId, name, updatedBy: userId }).where(eq(driveItems.id, item.id)).returning();
  await logActivity(ctx, { libraryId: to.id, item: updated!, userId, action: 'moved', detail: { fromLibrary: from.id !== to.id ? from.name : undefined } });
  return updated!;
}

/** Copy a file (its current version) or a folder tree. Content is shared, not duplicated on disk. */
export async function copy(ctx: DriveContext, item: DriveItem, to: DriveLibrary, parentId: string | null, userId: string) {
  await checkParent(ctx, to.id, parentId);
  const tree = await subtree(ctx, item.id);
  if (parentId && tree.some((t) => t.id === parentId)) throw new DriveError(400, 'A folder cannot be copied into itself');
  const bytes = tree.filter((t) => t.kind === 'file').reduce((n, t) => n + t.size, 0);
  await checkQuota(ctx, to, bytes);
  const map = new Map<string, string>();
  for (const src of tree) {
    const newParent = src.id === item.id ? parentId : map.get(src.parentId!)!;
    const name = src.id === item.id ? await freeName(ctx, to.id, parentId, src.name) : src.name;
    const [copyRow] = await ctx.db
      .insert(driveItems)
      .values({ libraryId: to.id, parentId: newParent, kind: src.kind, name, size: src.size, mime: src.mime, sha256: src.sha256, thumbnailSha: src.thumbnailSha, textContent: src.textContent, scanStatus: src.scanStatus, scanDetail: src.scanDetail, createdBy: userId, updatedBy: userId })
      .returning();
    map.set(src.id, copyRow!.id);
    if (src.kind === 'file' && src.sha256) {
      await retain(ctx, src.sha256, src.size, src.mime);
      const [v] = await ctx.db.insert(driveVersions).values({ itemId: copyRow!.id, number: 1, blobSha: src.sha256, size: src.size, mime: src.mime, comment: `Copied from ${src.name}`, createdBy: userId }).returning();
      await ctx.db.update(driveItems).set({ versionId: v!.id }).where(eq(driveItems.id, copyRow!.id));
    }
  }
  await addUsage(ctx, to, bytes);
  const [root] = await ctx.db.select().from(driveItems).where(eq(driveItems.id, map.get(item.id)!)).limit(1);
  await logActivity(ctx, { libraryId: to.id, item: root!, userId, action: 'copied', detail: { from: item.name } });
  return root!;
}

// ---------------------------------------------------------------------------
// Recycle bin
// ---------------------------------------------------------------------------

/** Move an item (and everything in it) to the recycle bin. */
export async function trash(ctx: Pick<DriveContext, 'db'>, item: DriveItem, userId: string) {
  const ids = (await subtree(ctx, item.id)).map((t) => t.id);
  await ctx.db.update(driveItems).set({ deletedAt: new Date(), deletedBy: userId, trashRootId: item.id, checkedOutBy: null, checkedOutAt: null }).where(and(inArray(driveItems.id, ids), isNull(driveItems.deletedAt)));
  await logActivity(ctx, { libraryId: item.libraryId, item, userId, action: 'deleted' });
}

/** Items deleted directly (not as part of a deleted folder). */
export async function trashList(ctx: Pick<DriveContext, 'db'>, libraryId: string) {
  return ctx.db
    .select()
    .from(driveItems)
    .where(and(eq(driveItems.libraryId, libraryId), isNotNull(driveItems.deletedAt), sql`${driveItems.trashRootId} = ${driveItems.id}`))
    .orderBy(desc(driveItems.deletedAt));
}

/** Put an item back: in its folder if that still exists, else in the library root; renamed if the name is taken. */
export async function restore(ctx: Pick<DriveContext, 'db'>, item: DriveItem, userId: string) {
  if (!item.deletedAt || item.trashRootId !== item.id) throw new DriveError(400, 'Only items in the recycle bin can be restored');
  let parentId = item.parentId;
  if (parentId) {
    const [p] = await ctx.db.select().from(driveItems).where(eq(driveItems.id, parentId)).limit(1);
    if (!p || p.deletedAt) parentId = null;
  }
  // Pick a free name first: restoring under a taken name would clash.
  const name = await freeName(ctx, item.libraryId, parentId, item.name);
  const [restored] = await ctx.db.update(driveItems).set({ parentId, name, deletedAt: null, deletedBy: null, trashRootId: null }).where(eq(driveItems.id, item.id)).returning();
  const ids = (await subtree(ctx, item.id, { deleted: 'any' })).filter((t) => t.trashRootId === item.id).map((t) => t.id);
  if (ids.length) await ctx.db.update(driveItems).set({ deletedAt: null, deletedBy: null, trashRootId: null }).where(inArray(driveItems.id, ids));
  await logActivity(ctx, { libraryId: item.libraryId, item: restored!, userId, action: 'restored' });
  return restored!;
}

/** Delete for good: release every version's content and the storage it used. */
export async function purge(ctx: DriveContext, item: DriveItem) {
  const tree = await subtree(ctx, item.id, { deleted: 'any' });
  const ids = tree.map((t) => t.id);
  const versions = ids.length ? await ctx.db.select({ sha: driveVersions.blobSha, size: driveVersions.size }).from(driveVersions).where(inArray(driveVersions.itemId, ids)) : [];
  const [lib] = await ctx.db.select().from(driveLibraries).where(eq(driveLibraries.id, item.libraryId)).limit(1);
  await ctx.db.delete(driveItems).where(eq(driveItems.id, item.id)); // cascades to children, versions, grants, links, comments
  for (const v of versions) await release(ctx, v.sha);
  if (lib) await addUsage(ctx, lib, -versions.reduce((n, v) => n + v.size, 0));
}

export async function emptyTrash(ctx: DriveContext, libraryId: string) {
  const items = await trashList(ctx, libraryId);
  for (const i of items) await purge(ctx, i);
  return items.length;
}

/** Scheduled clean-up: recycle-bin items older than `days`. */
export async function purgeExpired(ctx: DriveContext, days: number, orgId?: string) {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const old = await ctx.db
    .select({ item: driveItems })
    .from(driveItems)
    .innerJoin(driveLibraries, eq(driveLibraries.id, driveItems.libraryId))
    .where(and(lt(driveItems.deletedAt, cutoff), sql`${driveItems.trashRootId} = ${driveItems.id}`, orgId ? eq(driveLibraries.orgId, orgId) : undefined));
  for (const { item } of old) await purge(ctx, item);
  return old.length;
}

// ---------------------------------------------------------------------------
// Versions and check-out
// ---------------------------------------------------------------------------

export async function versions(ctx: Pick<DriveContext, 'db'>, itemId: string) {
  return ctx.db.select({ version: driveVersions, by: users.displayName }).from(driveVersions).leftJoin(users, eq(users.id, driveVersions.createdBy)).where(eq(driveVersions.itemId, itemId)).orderBy(desc(driveVersions.number));
}

/** Roll back: the chosen version's content becomes a new, current version. */
export async function restoreVersion(ctx: DriveContext, lib: DriveLibrary, item: DriveItem, versionId: string, userId: string) {
  const [v] = await ctx.db.select().from(driveVersions).where(and(eq(driveVersions.id, versionId), eq(driveVersions.itemId, item.id))).limit(1);
  if (!v) throw new DriveError(404, 'Version not found');
  if (item.checkedOutBy && item.checkedOutBy !== userId) throw new DriveError(423, 'This file is checked out by someone else', 'checked_out');
  await retain(ctx, v.blobSha, v.size, v.mime);
  const [{ n }] = (await ctx.db.select({ n: sql<number>`max(${driveVersions.number})::int` }).from(driveVersions).where(eq(driveVersions.itemId, item.id))) as [{ n: number }];
  const [nv] = await ctx.db.insert(driveVersions).values({ itemId: item.id, number: n + 1, blobSha: v.blobSha, size: v.size, mime: v.mime, comment: `Restored version ${v.number}`, createdBy: userId }).returning();
  const [updated] = await ctx.db.update(driveItems).set({ versionId: nv!.id, size: v.size, mime: v.mime, sha256: v.blobSha, updatedBy: userId }).where(eq(driveItems.id, item.id)).returning();
  await addUsage(ctx, lib, v.size);
  await logActivity(ctx, { libraryId: lib.id, item: updated!, userId, action: 'version_restored', detail: { version: v.number } });
  return updated!;
}

/** Remove an older version (not the current one) to free space. */
export async function deleteVersion(ctx: DriveContext, lib: DriveLibrary, item: DriveItem, versionId: string) {
  if (item.versionId === versionId) throw new DriveError(400, 'The current version cannot be deleted');
  const [v] = await ctx.db.delete(driveVersions).where(and(eq(driveVersions.id, versionId), eq(driveVersions.itemId, item.id))).returning();
  if (!v) throw new DriveError(404, 'Version not found');
  await release(ctx, v.blobSha);
  await addUsage(ctx, lib, -v.size);
}

/** Check out: only you can save new versions until you check it in (or an owner discards the check-out). */
export async function checkOut(ctx: Pick<DriveContext, 'db' | 'redis'>, item: DriveItem, userId: string) {
  if (item.kind !== 'file') throw new DriveError(400, 'Only files can be checked out');
  return withLock(ctx, item.id, async () => {
    const [updated] = await ctx.db.update(driveItems).set({ checkedOutBy: userId, checkedOutAt: new Date() }).where(and(eq(driveItems.id, item.id), isNull(driveItems.checkedOutBy))).returning();
    if (!updated) {
      const [cur] = await ctx.db.select({ by: driveItems.checkedOutBy }).from(driveItems).where(eq(driveItems.id, item.id)).limit(1);
      if (cur?.by === userId) return item;
      throw new DriveError(423, 'This file is already checked out by someone else', 'checked_out');
    }
    await logActivity(ctx, { libraryId: item.libraryId, item, userId, action: 'checked_out' });
    return updated;
  });
}

export async function checkIn(ctx: Pick<DriveContext, 'db'>, item: DriveItem, userId: string, opts: { force?: boolean } = {}) {
  if (item.checkedOutBy && item.checkedOutBy !== userId && !opts.force) throw new DriveError(423, 'This file is checked out by someone else', 'checked_out');
  const [updated] = await ctx.db.update(driveItems).set({ checkedOutBy: null, checkedOutAt: null }).where(eq(driveItems.id, item.id)).returning();
  await logActivity(ctx, { libraryId: item.libraryId, item, userId, action: opts.force && item.checkedOutBy !== userId ? 'check_out_discarded' : 'checked_in' });
  return updated!;
}
