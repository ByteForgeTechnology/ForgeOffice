import type { FastifyReply } from 'fastify';
import { Type, type Static } from 'typebox';
import { hashPassword } from '@forge/auth';
import {
  accessibleLibraries,
  ancestors,
  appendChunk,
  atLeast,
  blankDocument,
  cancelUpload,
  checkIn,
  checkOut,
  children,
  copy,
  createFolder,
  createUpload,
  deleteVersion,
  effectiveRole,
  emptyTrash,
  move,
  previewPath,
  principalFor,
  purge,
  rename,
  requireItem,
  requireLibrary,
  restore,
  restoreVersion,
  sharedWithMe,
  signToken,
  storeFile,
  trash,
  trashList,
  uploadStatus,
  versions,
  type Principal,
} from '@forge/drive';
import {
  DEFAULT_DRIVE_SETTINGS,
  driveActivity,
  driveComments,
  driveItems,
  driveLibraries,
  drivePermissions,
  driveShareLinks,
  driveVersions,
  orm,
  organizations,
  users,
  type DriveItem,
  type DriveRole,
  type DriveSettings,
} from '@forge/db';
import type { AppContext } from '../context';
import { badRequest, forbidden, notFound } from '../errors';
import { authenticate } from '../plugins/auth';
import { assertPrincipals, withPrincipalNames } from '../services/sharing';
import type { App } from '../types';

const { and, asc, desc, eq, inArray, isNull, sql } = orm;
const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });
const Role = Type.Union([Type.Literal('owner'), Type.Literal('editor'), Type.Literal('commenter'), Type.Literal('viewer')]);
const Conflict = Type.Optional(Type.Union([Type.Literal('fail'), Type.Literal('rename'), Type.Literal('replace')]));
const Grants = Type.Array(Type.Object({ principalType: Type.Union([Type.Literal('user'), Type.Literal('group')]), principalId: Type.String({ format: 'uuid' }), role: Role }), { maxItems: 200 });

/** Signed URLs let <img>, <video> and downloads load files without an Authorization header. */
const URL_TTL = 3600;

export async function driveSettings(ctx: AppContext, orgId: string): Promise<DriveSettings> {
  const [o] = await ctx.db.select({ s: organizations.driveSettings }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return { ...DEFAULT_DRIVE_SETTINGS, ...o?.s };
}

/** HTTP Range + safe Content-Type/Disposition for stored file content. */
export async function sendBlob(ctx: AppContext, reply: FastifyReply, opts: { sha: string; size: number; mime: string | null; name: string; download: boolean; range?: string }) {
  const { parseRange } = await import('@forge/storage');
  const mime = opts.mime ?? 'application/octet-stream';
  // Only types browsers can't turn into active content are shown inline.
  const inlineOk = /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/|audio\/|application\/pdf$|text\/plain)/.test(mime);
  const disposition = opts.download || !inlineOk ? 'attachment' : 'inline';
  const encoded = encodeURIComponent(opts.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  reply
    .header('Content-Type', inlineOk ? mime : 'application/octet-stream')
    .header('Content-Disposition', `${disposition}; filename="${opts.name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encoded}`)
    .header('Accept-Ranges', 'bytes')
    .header('X-Content-Type-Options', 'nosniff')
    .header('Cache-Control', 'private, max-age=3600')
    .header('Content-Security-Policy', `default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'${mime === 'application/pdf' ? '' : '; sandbox'}`);
  const range = parseRange(opts.range, opts.size);
  if (range === 'unsatisfiable') return reply.code(416).header('Content-Range', `bytes */${opts.size}`).send();
  if (range) {
    reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${opts.size}`).header('Content-Length', range.end - range.start + 1);
    return reply.send(ctx.drive.blobs.createReadStream(opts.sha, range));
  }
  reply.header('Content-Length', opts.size);
  return reply.send(ctx.drive.blobs.createReadStream(opts.sha));
}

/**
 * ForgeDrive for signed-in people: libraries, folders and files, resumable
 * uploads, downloads with Range, versions, check-out, permissions, external
 * links, comments, activity, recycle bin and search.
 */
export function driveRoutes(app: App, ctx: AppContext) {
  const { db } = ctx;
  const key = () => ctx.keys.shareLinkKey;

  // Raw upload chunks (resumable uploads).
  app.addContentTypeParser('application/offset+octet-stream', (_req, payload, done) => done(null, payload));

  const auth = authenticate(ctx);
  app.addHook('preHandler', async function (req, reply) {
    // Signed content URLs are checked by their token, not a session.
    if (req.url.startsWith('/api/v1/drive/raw/') || req.url.startsWith('/api/v1/drive/thumb/')) return;
    await auth.call(this, req, reply);
  });

  const principals = new WeakMap<object, Promise<Principal>>();
  const who = (req: { principal: { user: { id: string } } | null }) => {
    let p = principals.get(req);
    if (!p) principals.set(req, (p = principalFor(db, req.principal!.user.id)));
    return p;
  };
  const me = (req: { principal: { user: { id: string; orgId: string } } | null }) => req.principal!.user;

  const thumbUrl = (i: DriveItem) => (i.thumbnailSha ? `/api/v1/drive/thumb/${signToken(key(), { p: 'thumb', s: i.thumbnailSha }, URL_TTL)}` : null);
  const names = async (ids: (string | null)[]) => {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    return new Map((list.length ? await db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, list)) : []).map((u) => [u.id, u.name]));
  };
  const serialise = (i: DriveItem, people: Map<string, string>, extra: Record<string, unknown> = {}) => ({
    id: i.id,
    libraryId: i.libraryId,
    parentId: i.parentId,
    kind: i.kind,
    name: i.name,
    size: i.size,
    mime: i.mime,
    scanStatus: i.scanStatus,
    scanDetail: i.scanDetail,
    thumbnailUrl: thumbUrl(i),
    inheritPermissions: i.inheritPermissions,
    checkedOutBy: i.checkedOutBy ? { id: i.checkedOutBy, name: people.get(i.checkedOutBy) ?? '' } : null,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    updatedBy: i.updatedBy ? (people.get(i.updatedBy) ?? null) : null,
    deletedAt: i.deletedAt,
    ...extra,
  });
  const serialiseMany = async (items: DriveItem[], extra?: (i: DriveItem) => Record<string, unknown>) => {
    const people = await names(items.flatMap((i) => [i.updatedBy, i.checkedOutBy]));
    return items.map((i) => serialise(i, people, extra?.(i)));
  };

  // ---------------------------------------------------------------------------
  // Libraries and browsing
  // ---------------------------------------------------------------------------

  app.get('/api/v1/drive/libraries', { schema: { tags: ['drive'], summary: 'Libraries you can open: My files, your groups’ and any shared with you' } }, async (req) => {
    const libs = await accessibleLibraries(db, await who(req), me(req).orgId);
    const shared = await sharedWithMe(db, await who(req));
    return {
      items: libs
        .filter((l) => l.kind !== 'site')
        .map((l) => ({ id: l.id, kind: l.kind, name: l.name, description: l.description, role: l.role, usedBytes: l.usedBytes, mine: l.ownerUserId === me(req).id }))
        .sort((a, b) => Number(b.mine) - Number(a.mine) || a.name.localeCompare(b.name)),
      sharedCount: shared.length,
      // Office editing is set up: offer new Word/Excel/PowerPoint files.
      office: !!ctx.config.drive.officeUrl,
    };
  });

  app.get('/api/v1/drive/shared', { schema: { tags: ['drive'], summary: 'Files and folders shared with you' } }, async (req) => {
    const rows = await sharedWithMe(db, await who(req));
    const owners = await names(rows.map((r) => r.lib.ownerUserId));
    return { items: (await serialiseMany(rows.map((r) => r.item))).map((s, i) => ({ ...s, role: rows[i]!.role, library: { id: rows[i]!.lib.id, name: rows[i]!.lib.kind === 'personal' ? `${owners.get(rows[i]!.lib.ownerUserId!) ?? ''}’s files` : rows[i]!.lib.name } })) };
  });

  app.get('/api/v1/drive/recent', { schema: { tags: ['drive'], summary: 'Files you worked on recently' } }, async (req) => {
    const recent = await db
      .selectDistinctOn([driveActivity.itemId], { itemId: driveActivity.itemId, at: driveActivity.createdAt })
      .from(driveActivity)
      .where(and(eq(driveActivity.userId, me(req).id), sql`${driveActivity.itemId} is not null`))
      .orderBy(driveActivity.itemId, desc(driveActivity.createdAt))
      .limit(200);
    const ids = recent.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 40).map((r) => r.itemId!);
    const items = ids.length ? await db.select().from(driveItems).where(and(inArray(driveItems.id, ids), isNull(driveItems.deletedAt), eq(driveItems.kind, 'file'))) : [];
    const p = await who(req);
    const visible: DriveItem[] = [];
    for (const id of ids) {
      const it = items.find((i) => i.id === id);
      if (it && (await requireItem(db, p, it.id, 'viewer').then(() => true).catch(() => false))) visible.push(it);
    }
    return { items: await serialiseMany(visible) };
  });

  app.get(
    '/api/v1/drive/libraries/:id/items',
    { schema: { tags: ['drive'], summary: 'A folder’s contents (the library root without parentId)', params: IdParams, querystring: Type.Object({ parentId: Type.Optional(Type.String({ format: 'uuid' })) }) } },
    async (req) => {
      const p = await who(req);
      let role: DriveRole;
      let folder: DriveItem | null = null;
      const { lib, role: libRole } = await requireLibrary(db, p, req.params.id, 'viewer').catch(async (err) => {
        // Someone with access to just one folder can still browse it.
        if (!req.query.parentId) throw err;
        const r = await requireItem(db, p, req.query.parentId, 'viewer');
        return { lib: r.lib, role: r.role };
      });
      role = libRole;
      if (req.query.parentId) {
        const r = await requireItem(db, p, req.query.parentId, 'viewer');
        if (r.item.libraryId !== lib.id || r.item.kind !== 'folder') throw notFound('Folder');
        folder = r.item;
        role = r.role;
      }
      const items = await children(ctx.drive, lib.id, folder?.id ?? null);
      // Items below a folder that stops inheritance may not be visible to everyone.
      const visible: DriveItem[] = [];
      for (const it of items) if (it.inheritPermissions || (await effectiveRole(db, p, lib, it))) visible.push(it);
      const crumbs = folder ? await ancestors(ctx.drive, folder) : [];
      return {
        library: { id: lib.id, kind: lib.kind, name: lib.name, usedBytes: lib.usedBytes },
        folder: folder ? { id: folder.id, name: folder.name, inheritPermissions: folder.inheritPermissions } : null,
        breadcrumbs: crumbs.map((c) => ({ id: c.id, name: c.name })),
        role,
        items: await serialiseMany(visible),
      };
    },
  );

  app.get('/api/v1/drive/items/:id', { schema: { tags: ['drive'], summary: 'A file or folder', params: IdParams } }, async (req) => {
    const { item, lib, role } = await requireItem(db, await who(req), req.params.id, 'viewer');
    const crumbs = await ancestors(ctx.drive, item);
    const [counts] = await db
      .select({
        versions: sql<number>`(select count(*)::int from ${driveVersions} where ${driveVersions.itemId} = ${item.id})`,
        links: sql<number>`(select count(*)::int from ${driveShareLinks} where ${driveShareLinks.itemId} = ${item.id} and ${driveShareLinks.revokedAt} is null)`,
        comments: sql<number>`(select count(*)::int from ${driveComments} where ${driveComments.itemId} = ${item.id})`,
      })
      .from(driveItems)
      .where(eq(driveItems.id, item.id));
    const [s] = await serialiseMany([item]);
    return {
      item: { ...s, role, library: { id: lib.id, name: lib.name, kind: lib.kind }, breadcrumbs: crumbs.slice(0, -1).map((c) => ({ id: c.id, name: c.name })), counts, office: !!ctx.config.drive.officeUrl && item.kind === 'file' },
    };
  });

  // ---------------------------------------------------------------------------
  // Changing the tree
  // ---------------------------------------------------------------------------

  app.post(
    '/api/v1/drive/libraries/:id/folders',
    { schema: { tags: ['drive'], summary: 'Create a folder', params: IdParams, body: Type.Object({ parentId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])), name: Type.String({ minLength: 1, maxLength: 255 }), conflict: Conflict }) } },
    async (req, reply) => {
      const p = await who(req);
      const parentId = req.body.parentId ?? null;
      const lib = parentId ? (await requireItem(db, p, parentId, 'editor')).lib : (await requireLibrary(db, p, req.params.id, 'editor')).lib;
      const folder = await createFolder(ctx.drive, lib, parentId, req.body.name, me(req).id, req.body.conflict ?? 'fail');
      reply.code(201);
      return { item: (await serialiseMany([folder]))[0] };
    },
  );

  const NEW_DOCUMENTS = { docx: 'Document', xlsx: 'Workbook', pptx: 'Presentation' } as const;
  app.post(
    '/api/v1/drive/libraries/:id/documents',
    {
      schema: {
        tags: ['drive'],
        summary: 'Create a blank Word document, Excel workbook or PowerPoint presentation',
        params: IdParams,
        body: Type.Object({
          parentId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
          kind: Type.Union([Type.Literal('docx'), Type.Literal('xlsx'), Type.Literal('pptx')]),
          name: Type.Optional(Type.String({ minLength: 1, maxLength: 250 })),
        }),
      },
    },
    async (req, reply) => {
      const p = await who(req);
      const parentId = req.body.parentId ?? null;
      const lib = parentId ? (await requireItem(db, p, parentId, 'editor')).lib : (await requireLibrary(db, p, req.params.id, 'editor')).lib;
      const { kind } = req.body;
      const base = (req.body.name?.trim() || NEW_DOCUMENTS[kind]).replace(new RegExp(`\\.${kind}$`, 'i'), '');
      const stored = await storeFile(ctx.drive, { lib, parentId, name: `${base}.${kind}`, mime: null, source: blankDocument(kind), userId: me(req).id, conflict: 'rename', comment: 'Created' });
      reply.code(201);
      return { item: (await serialiseMany([stored.item]))[0] };
    },
  );

  app.patch(
    '/api/v1/drive/items/:id',
    { schema: { tags: ['drive'], summary: 'Rename, or stop/resume permission inheritance', params: IdParams, body: Type.Object({ name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })), inheritPermissions: Type.Optional(Type.Boolean()) }) } },
    async (req) => {
      const p = await who(req);
      let { item, lib, role } = await requireItem(db, p, req.params.id, 'editor');
      if (req.body.name !== undefined && req.body.name !== item.name) item = await rename(ctx.drive, item, req.body.name, me(req).id);
      if (req.body.inheritPermissions !== undefined) {
        if (!atLeast(role, 'owner')) throw forbidden('Only owners can change permissions');
        if (!req.body.inheritPermissions) {
          // Keep the people who had access by copying the inherited grants down (as SharePoint does).
          const inherited = await db.select().from(drivePermissions).where(and(eq(drivePermissions.libraryId, lib.id), isNull(drivePermissions.itemId)));
          for (const g of inherited) await db.insert(drivePermissions).values({ libraryId: lib.id, itemId: item.id, principalType: g.principalType, principalId: g.principalId, role: g.role, createdBy: me(req).id }).onConflictDoNothing();
        }
        [item] = (await db.update(driveItems).set({ inheritPermissions: req.body.inheritPermissions }).where(eq(driveItems.id, item.id)).returning()) as [DriveItem];
      }
      return { item: (await serialiseMany([item]))[0] };
    },
  );

  const MoveBody = Type.Object({ libraryId: Type.String({ format: 'uuid' }), parentId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])), conflict: Conflict });
  const target = async (p: Principal, body: Static<typeof MoveBody>) => (body.parentId ? (await requireItem(db, p, body.parentId, 'editor')).lib : (await requireLibrary(db, p, body.libraryId, 'editor')).lib);

  app.post('/api/v1/drive/items/:id/move', { schema: { tags: ['drive'], summary: 'Move to another folder or library', params: IdParams, body: MoveBody } }, async (req) => {
    const p = await who(req);
    const { item, lib } = await requireItem(db, p, req.params.id, 'editor');
    if (item.checkedOutBy && item.checkedOutBy !== me(req).id) throw badRequest('This file is checked out by someone else');
    const to = await target(p, req.body);
    return { item: (await serialiseMany([await move(ctx.drive, item, lib, to, req.body.parentId ?? null, me(req).id, req.body.conflict ?? 'fail')]))[0] };
  });

  app.post('/api/v1/drive/items/:id/copy', { schema: { tags: ['drive'], summary: 'Copy to another folder or library', params: IdParams, body: MoveBody } }, async (req, reply) => {
    const p = await who(req);
    const { item } = await requireItem(db, p, req.params.id, 'viewer');
    if (item.scanStatus === 'infected') throw badRequest('Files with a virus cannot be copied');
    const to = await target(p, req.body);
    reply.code(201);
    return { item: (await serialiseMany([await copy(ctx.drive, item, to, req.body.parentId ?? null, me(req).id)]))[0] };
  });

  app.delete('/api/v1/drive/items/:id', { schema: { tags: ['drive'], summary: 'Move to the recycle bin', params: IdParams } }, async (req) => {
    const { item } = await requireItem(db, await who(req), req.params.id, 'editor');
    if (item.checkedOutBy && item.checkedOutBy !== me(req).id) throw badRequest('This file is checked out by someone else');
    await trash(ctx.drive, item, me(req).id);
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Recycle bin
  // ---------------------------------------------------------------------------

  app.get('/api/v1/drive/libraries/:id/trash', { schema: { tags: ['drive'], summary: 'Recycle bin', params: IdParams } }, async (req) => {
    const { lib } = await requireLibrary(db, await who(req), req.params.id, 'editor');
    const items = await trashList(ctx.drive, lib.id);
    const deleters = await names(items.map((i) => i.deletedBy));
    const settings = await driveSettings(ctx, me(req).orgId);
    return { retentionDays: settings.trashDays, items: (await serialiseMany(items)).map((s, n) => ({ ...s, deletedBy: deleters.get(items[n]!.deletedBy!) ?? null })) };
  });

  app.post('/api/v1/drive/items/:id/restore', { schema: { tags: ['drive'], summary: 'Restore from the recycle bin', params: IdParams } }, async (req) => {
    const { item } = await requireItem(db, await who(req), req.params.id, 'editor', { includeDeleted: true });
    return { item: (await serialiseMany([await restore(ctx.drive, item, me(req).id)]))[0] };
  });

  app.delete('/api/v1/drive/items/:id/purge', { schema: { tags: ['drive'], summary: 'Delete from the recycle bin for good', params: IdParams } }, async (req) => {
    const { item } = await requireItem(db, await who(req), req.params.id, 'editor', { includeDeleted: true });
    if (!item.deletedAt) throw badRequest('Move it to the recycle bin first');
    await purge(ctx.drive, item);
    return { ok: true };
  });

  app.delete('/api/v1/drive/libraries/:id/trash', { schema: { tags: ['drive'], summary: 'Empty the recycle bin', params: IdParams } }, async (req) => {
    const { lib } = await requireLibrary(db, await who(req), req.params.id, 'owner');
    return { purged: await emptyTrash(ctx.drive, lib.id) };
  });

  // ---------------------------------------------------------------------------
  // Uploads (resumable) and content
  // ---------------------------------------------------------------------------

  app.post(
    '/api/v1/drive/uploads',
    {
      schema: {
        tags: ['drive'],
        summary: 'Start a resumable upload (new file, or a new version with itemId)',
        body: Type.Object({
          libraryId: Type.String({ format: 'uuid' }),
          parentId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
          itemId: Type.Optional(Type.String({ format: 'uuid' })),
          name: Type.String({ minLength: 1, maxLength: 255 }),
          size: Type.Integer({ minimum: 0 }),
          mime: Type.Optional(Type.String({ maxLength: 200 })),
        }),
      },
    },
    async (req, reply) => {
      const p = await who(req);
      const b = req.body;
      let lib;
      if (b.itemId) {
        const r = await requireItem(db, p, b.itemId, 'editor');
        if (r.item.kind !== 'file') throw badRequest('Choose a file');
        lib = r.lib;
      } else lib = b.parentId ? (await requireItem(db, p, b.parentId, 'editor')).lib : (await requireLibrary(db, p, b.libraryId, 'editor')).lib;
      const settings = await driveSettings(ctx, me(req).orgId);
      const up = await createUpload(ctx.drive, { lib, parentId: b.parentId ?? null, itemId: b.itemId, name: b.name, mime: b.mime, size: b.size, userId: me(req).id, maxBytes: settings.maxUploadMb * 1048576 });
      reply.code(201);
      return { upload: { id: up.id, size: up.size, received: 0, chunkSize: 8 * 1048576 } };
    },
  );

  app.get('/api/v1/drive/uploads/:id', { schema: { tags: ['drive'], summary: 'How much of an upload has arrived (to resume it)', params: IdParams } }, async (req) => {
    const up = await uploadStatus(ctx.drive, req.params.id, me(req).id);
    return { upload: { id: up.id, size: up.size, received: up.received } };
  });

  app.patch(
    '/api/v1/drive/uploads/:id',
    {
      bodyLimit: 64 * 1048576,
      schema: { tags: ['drive'], summary: 'Send the next chunk (Content-Type: application/offset+octet-stream; Upload-Offset header)', params: IdParams, querystring: Type.Object({ conflict: Conflict }) },
    },
    async (req) => {
      const offset = Number(req.headers['upload-offset']);
      if (!Number.isInteger(offset) || offset < 0) throw badRequest('Upload-Offset header required');
      const up = await uploadStatus(ctx.drive, req.params.id, me(req).id);
      const [lib] = await db.select().from(driveLibraries).where(eq(driveLibraries.id, up.libraryId)).limit(1);
      if (!lib) throw notFound('Library');
      const result = await appendChunk(ctx.drive, { id: up.id, userId: me(req).id, offset, body: req.body as NodeJS.ReadableStream as never, lib, conflict: req.query.conflict });
      return { received: result.upload.received, size: result.upload.size, item: result.stored ? (await serialiseMany([result.stored.item]))[0] : null };
    },
  );

  app.delete('/api/v1/drive/uploads/:id', { schema: { tags: ['drive'], summary: 'Cancel an upload', params: IdParams } }, async (req) => {
    await cancelUpload(ctx.drive, req.params.id, me(req).id);
    return { ok: true };
  });

  app.get(
    '/api/v1/drive/items/:id/url',
    { schema: { tags: ['drive'], summary: 'A short-lived URL for the file’s content (view or download)', params: IdParams, querystring: Type.Object({ versionId: Type.Optional(Type.String({ format: 'uuid' })), download: Type.Optional(Type.Boolean()) }) } },
    async (req) => {
      const { item } = await requireItem(db, await who(req), req.params.id, 'viewer');
      if (item.kind !== 'file') throw badRequest('Folders have no content');
      if (item.scanStatus === 'infected') throw forbidden(`This file contains a virus (${item.scanDetail ?? 'detected'}) and cannot be opened`);
      const token = signToken(key(), { p: 'raw', i: item.id, v: req.query.versionId ?? item.versionId, d: req.query.download ? 1 : 0 }, URL_TTL);
      return { url: `/api/v1/drive/raw/${token}`, expiresIn: URL_TTL };
    },
  );

  app.get('/api/v1/drive/raw/:token', { schema: { tags: ['drive'], summary: 'File content from a signed URL (supports Range)', params: Type.Object({ token: Type.String({ maxLength: 2000 }) }) } }, async (req, reply) => {
    const { verifyToken } = await import('@forge/drive');
    const claims = verifyToken<{ i: string; v: string; d: number }>(key(), req.params.token, 'raw');
    if (!claims) throw forbidden('This link has expired');
    const [row] = await db.select({ item: driveItems, version: driveVersions }).from(driveVersions).innerJoin(driveItems, eq(driveItems.id, driveVersions.itemId)).where(and(eq(driveVersions.id, claims.v), eq(driveVersions.itemId, claims.i))).limit(1);
    if (!row || row.item.deletedAt) throw notFound('File');
    if (row.item.scanStatus === 'infected' && row.item.versionId === row.version.id) throw forbidden('This file contains a virus');
    return sendBlob(ctx, reply, { sha: row.version.blobSha, size: row.version.size, mime: row.version.mime, name: row.item.name, download: !!claims.d, range: req.headers.range });
  });

  app.get('/api/v1/drive/thumb/:token', { schema: { tags: ['drive'], summary: 'A thumbnail from a signed URL', params: Type.Object({ token: Type.String({ maxLength: 2000 }) }) } }, async (req, reply) => {
    const { verifyToken } = await import('@forge/drive');
    const claims = verifyToken<{ s: string }>(key(), req.params.token, 'thumb');
    if (!claims || !/^[a-f0-9]{64}$/.test(claims.s)) throw forbidden('This link has expired');
    const { createReadStream } = await import('node:fs');
    const { access } = await import('node:fs/promises');
    const path = previewPath(ctx.drive, claims.s);
    await access(path).catch(() => {
      throw notFound('Thumbnail');
    });
    return reply.header('Content-Type', 'image/webp').header('Cache-Control', 'private, max-age=86400').send(createReadStream(path));
  });

  // ---------------------------------------------------------------------------
  // Versions and check-out
  // ---------------------------------------------------------------------------

  app.get('/api/v1/drive/items/:id/versions', { schema: { tags: ['drive'], summary: 'Version history', params: IdParams } }, async (req) => {
    const { item } = await requireItem(db, await who(req), req.params.id, 'viewer');
    return { items: (await versions(ctx.drive, item.id)).map(({ version: v, by }) => ({ id: v.id, number: v.number, size: v.size, comment: v.comment, createdAt: v.createdAt, createdBy: by, current: v.id === item.versionId })) };
  });

  app.post('/api/v1/drive/items/:id/versions/:versionId/restore', { schema: { tags: ['drive'], summary: 'Make an older version current again', params: Type.Object({ id: Type.String({ format: 'uuid' }), versionId: Type.String({ format: 'uuid' }) }) } }, async (req) => {
    const { item, lib } = await requireItem(db, await who(req), req.params.id, 'editor');
    return { item: (await serialiseMany([await restoreVersion(ctx.drive, lib, item, req.params.versionId, me(req).id)]))[0] };
  });

  app.delete('/api/v1/drive/items/:id/versions/:versionId', { schema: { tags: ['drive'], summary: 'Delete an older version', params: Type.Object({ id: Type.String({ format: 'uuid' }), versionId: Type.String({ format: 'uuid' }) }) } }, async (req) => {
    const { item, lib } = await requireItem(db, await who(req), req.params.id, 'owner');
    await deleteVersion(ctx.drive, lib, item, req.params.versionId);
    return { ok: true };
  });

  app.post('/api/v1/drive/items/:id/checkout', { schema: { tags: ['drive'], summary: 'Check out (only you can save new versions)', params: IdParams } }, async (req) => {
    const { item } = await requireItem(db, await who(req), req.params.id, 'editor');
    return { item: (await serialiseMany([await checkOut(ctx.drive, item, me(req).id)]))[0] };
  });

  app.post('/api/v1/drive/items/:id/checkin', { schema: { tags: ['drive'], summary: 'Check in, or (owners) discard someone’s check-out', params: IdParams, body: Type.Object({ discard: Type.Optional(Type.Boolean()) }) } }, async (req) => {
    const { item, role } = await requireItem(db, await who(req), req.params.id, 'editor');
    const force = !!req.body.discard && item.checkedOutBy !== me(req).id;
    if (force && !atLeast(role, 'owner')) throw forbidden('Only owners can discard someone else’s check-out');
    return { item: (await serialiseMany([await checkIn(ctx.drive, item, me(req).id, { force })]))[0] };
  });

  // ---------------------------------------------------------------------------
  // Permissions (item and library) and external links
  // ---------------------------------------------------------------------------

  const listGrants = async (libraryId: string, itemId: string | null) =>
    withPrincipalNames(await db.select().from(drivePermissions).where(and(eq(drivePermissions.libraryId, libraryId), itemId ? eq(drivePermissions.itemId, itemId) : isNull(drivePermissions.itemId))).orderBy(asc(drivePermissions.createdAt)));

  const replaceGrants = async (libraryId: string, itemId: string | null, grants: Static<typeof Grants>, by: string, ownerUserId: string | null) => {
    await assertPrincipals(grants, ownerUserId ?? '00000000-0000-0000-0000-000000000000');
    await db.delete(drivePermissions).where(and(eq(drivePermissions.libraryId, libraryId), itemId ? eq(drivePermissions.itemId, itemId) : isNull(drivePermissions.itemId)));
    if (grants.length) await db.insert(drivePermissions).values(grants.map((g) => ({ libraryId, itemId, principalType: g.principalType, principalId: g.principalId, role: g.role, createdBy: by })));
  };

  app.get('/api/v1/drive/items/:id/permissions', { schema: { tags: ['drive'], summary: 'Who has access, directly and inherited', params: IdParams } }, async (req) => {
    const { item, lib } = await requireItem(db, await who(req), req.params.id, 'viewer');
    const chain = await ancestors(ctx.drive, item);
    const inherited: { from: string; grants: Awaited<ReturnType<typeof listGrants>> }[] = [];
    for (let i = chain.length - 2; i >= 0 && chain[i + 1]!.inheritPermissions; i--) inherited.push({ from: chain[i]!.name, grants: await listGrants(lib.id, chain[i]!.id) });
    const reachesLibrary = chain.every((c) => c.inheritPermissions);
    return {
      direct: await listGrants(lib.id, item.id),
      inherited: [...inherited, ...(reachesLibrary ? [{ from: lib.name, grants: await listGrants(lib.id, null) }] : [])].filter((x) => x.grants.length),
      inheritPermissions: item.inheritPermissions,
      library: { kind: lib.kind, everyoneRole: reachesLibrary ? lib.everyoneRole : null },
    };
  });

  app.put('/api/v1/drive/items/:id/permissions', { schema: { tags: ['drive'], summary: 'Set who has access to this item', params: IdParams, body: Type.Object({ grants: Grants }) } }, async (req) => {
    const { item, lib } = await requireItem(db, await who(req), req.params.id, 'owner');
    await replaceGrants(lib.id, item.id, req.body.grants, me(req).id, lib.ownerUserId);
    await db.insert(driveActivity).values({ libraryId: lib.id, itemId: item.id, itemName: item.name, userId: me(req).id, action: 'permissions_changed', detail: { grants: req.body.grants.length } });
    await ctx.audit.fromRequest(req, { action: 'drive.permissions_changed', targetType: 'drive_item', targetId: item.id, targetLabel: item.name, metadata: { grants: req.body.grants } });
    return { grants: await listGrants(lib.id, item.id) };
  });

  app.get('/api/v1/drive/libraries/:id/permissions', { schema: { tags: ['drive'], summary: 'Who has access to the whole library', params: IdParams } }, async (req) => {
    const { lib } = await requireLibrary(db, await who(req), req.params.id, 'viewer');
    return { grants: await listGrants(lib.id, null), everyoneRole: lib.everyoneRole };
  });

  app.put(
    '/api/v1/drive/libraries/:id/permissions',
    { schema: { tags: ['drive'], summary: 'Set who has access to the whole library', params: IdParams, body: Type.Object({ grants: Grants, everyoneRole: Type.Optional(Type.Union([Role, Type.Null()])) }) } },
    async (req) => {
      const { lib } = await requireLibrary(db, await who(req), req.params.id, 'owner');
      await replaceGrants(lib.id, null, req.body.grants, me(req).id, lib.ownerUserId);
      if (req.body.everyoneRole !== undefined) {
        if (req.body.everyoneRole === 'owner') throw badRequest('Everyone cannot be an owner');
        await db.update(driveLibraries).set({ everyoneRole: req.body.everyoneRole }).where(eq(driveLibraries.id, lib.id));
      }
      await ctx.audit.fromRequest(req, { action: 'drive.library_permissions_changed', targetType: 'drive_library', targetId: lib.id, targetLabel: lib.name, metadata: { grants: req.body.grants, everyoneRole: req.body.everyoneRole } });
      return { grants: await listGrants(lib.id, null) };
    },
  );

  app.get('/api/v1/drive/items/:id/links', { schema: { tags: ['drive'], summary: 'External sharing links', params: IdParams } }, async (req) => {
    const { item } = await requireItem(db, await who(req), req.params.id, 'editor');
    const rows = await db.select().from(driveShareLinks).where(and(eq(driveShareLinks.itemId, item.id), isNull(driveShareLinks.revokedAt))).orderBy(desc(driveShareLinks.createdAt));
    const people = await names(rows.map((r) => r.createdBy));
    return {
      items: rows.map((l) => ({
        id: l.id,
        url: `${ctx.config.publicUrl}/drive/s/${signToken(key(), { p: 'share', l: l.id })}`,
        hasPassword: !!l.passwordHash,
        expiresAt: l.expiresAt,
        maxDownloads: l.maxDownloads,
        downloadCount: l.downloadCount,
        createdBy: people.get(l.createdBy ?? '') ?? null,
        createdAt: l.createdAt,
        expired: (!!l.expiresAt && l.expiresAt < new Date()) || (l.maxDownloads !== null && l.downloadCount >= l.maxDownloads),
      })),
    };
  });

  app.post(
    '/api/v1/drive/items/:id/links',
    {
      schema: {
        tags: ['drive'],
        summary: 'Create a link that works for people outside the organisation',
        params: IdParams,
        body: Type.Object({ password: Type.Optional(Type.String({ minLength: 4, maxLength: 200 })), expiresAt: Type.Optional(Type.String({ format: 'date-time' })), maxDownloads: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })) }),
      },
    },
    async (req, reply) => {
      const { item, lib } = await requireItem(db, await who(req), req.params.id, 'editor');
      const settings = await driveSettings(ctx, me(req).orgId);
      if (!settings.externalSharing) throw forbidden('Your organisation does not allow links for people outside it');
      if (item.scanStatus === 'infected') throw badRequest('Files with a virus cannot be shared');
      let expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
      if (expiresAt && expiresAt < new Date()) throw badRequest('Choose a date in the future');
      if (settings.linkMaxDays) {
        const latest = new Date(Date.now() + settings.linkMaxDays * 86_400_000);
        if (!expiresAt || expiresAt > latest) expiresAt = latest;
      }
      const [link] = await db
        .insert(driveShareLinks)
        .values({ itemId: item.id, passwordHash: req.body.password ? await hashPassword(req.body.password) : null, expiresAt, maxDownloads: req.body.maxDownloads ?? null, createdBy: me(req).id })
        .returning();
      await db.insert(driveActivity).values({ libraryId: lib.id, itemId: item.id, itemName: item.name, userId: me(req).id, action: 'link_created' });
      await ctx.audit.fromRequest(req, { action: 'drive.link_created', targetType: 'drive_item', targetId: item.id, targetLabel: item.name, metadata: { linkId: link!.id, password: !!req.body.password, expiresAt, maxDownloads: req.body.maxDownloads ?? null } });
      reply.code(201);
      return { link: { id: link!.id, url: `${ctx.config.publicUrl}/drive/s/${signToken(key(), { p: 'share', l: link!.id })}`, expiresAt, hasPassword: !!req.body.password, maxDownloads: link!.maxDownloads } };
    },
  );

  app.delete('/api/v1/drive/links/:id', { schema: { tags: ['drive'], summary: 'Stop an external link working', params: IdParams } }, async (req) => {
    const [link] = await db.select().from(driveShareLinks).where(eq(driveShareLinks.id, req.params.id)).limit(1);
    if (!link) throw notFound('Link');
    const { item } = await requireItem(db, await who(req), link.itemId, 'editor');
    await db.update(driveShareLinks).set({ revokedAt: new Date() }).where(eq(driveShareLinks.id, link.id));
    await ctx.audit.fromRequest(req, { action: 'drive.link_revoked', targetType: 'drive_item', targetId: item.id, targetLabel: item.name, metadata: { linkId: link.id } });
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Comments, activity, search
  // ---------------------------------------------------------------------------

  app.get('/api/v1/drive/items/:id/comments', { schema: { tags: ['drive'], summary: 'Comments', params: IdParams } }, async (req) => {
    const { item, role } = await requireItem(db, await who(req), req.params.id, 'viewer');
    const rows = await db.select({ c: driveComments, name: users.displayName }).from(driveComments).leftJoin(users, eq(users.id, driveComments.userId)).where(eq(driveComments.itemId, item.id)).orderBy(asc(driveComments.createdAt));
    return { canComment: atLeast(role, 'commenter'), items: rows.map(({ c, name }) => ({ id: c.id, body: c.body, author: name, mine: c.userId === me(req).id, createdAt: c.createdAt, resolvedAt: c.resolvedAt })) };
  });

  app.post('/api/v1/drive/items/:id/comments', { schema: { tags: ['drive'], summary: 'Add a comment', params: IdParams, body: Type.Object({ body: Type.String({ minLength: 1, maxLength: 5000 }) }) } }, async (req, reply) => {
    const { item, lib } = await requireItem(db, await who(req), req.params.id, 'commenter');
    const [c] = await db.insert(driveComments).values({ itemId: item.id, userId: me(req).id, body: req.body.body.trim() }).returning();
    await db.insert(driveActivity).values({ libraryId: lib.id, itemId: item.id, itemName: item.name, userId: me(req).id, action: 'commented' });
    reply.code(201);
    return { comment: c };
  });

  app.patch('/api/v1/drive/comments/:id', { schema: { tags: ['drive'], summary: 'Resolve or reopen a comment', params: IdParams, body: Type.Object({ resolved: Type.Boolean() }) } }, async (req) => {
    const [c] = await db.select().from(driveComments).where(eq(driveComments.id, req.params.id)).limit(1);
    if (!c) throw notFound('Comment');
    await requireItem(db, await who(req), c.itemId, 'commenter');
    await db.update(driveComments).set({ resolvedAt: req.body.resolved ? new Date() : null }).where(eq(driveComments.id, c.id));
    return { ok: true };
  });

  app.delete('/api/v1/drive/comments/:id', { schema: { tags: ['drive'], summary: 'Delete a comment (yours, or any as an owner)', params: IdParams } }, async (req) => {
    const [c] = await db.select().from(driveComments).where(eq(driveComments.id, req.params.id)).limit(1);
    if (!c) throw notFound('Comment');
    const { role } = await requireItem(db, await who(req), c.itemId, 'commenter');
    if (c.userId !== me(req).id && !atLeast(role, 'owner')) throw forbidden('You can only delete your own comments');
    await db.delete(driveComments).where(eq(driveComments.id, c.id));
    return { ok: true };
  });

  const activityRows = async (where: ReturnType<typeof eq>) => {
    const rows = await db.select({ a: driveActivity, name: users.displayName }).from(driveActivity).leftJoin(users, eq(users.id, driveActivity.userId)).where(where).orderBy(desc(driveActivity.createdAt)).limit(100);
    return rows.map(({ a, name }) => ({ id: a.id, action: a.action, itemId: a.itemId, itemName: a.itemName, user: name, detail: a.detail, createdAt: a.createdAt }));
  };
  app.get('/api/v1/drive/libraries/:id/activity', { schema: { tags: ['drive'], summary: 'Recent activity in a library', params: IdParams } }, async (req) => {
    const { lib } = await requireLibrary(db, await who(req), req.params.id, 'viewer');
    return { items: await activityRows(eq(driveActivity.libraryId, lib.id)) };
  });
  app.get('/api/v1/drive/items/:id/activity', { schema: { tags: ['drive'], summary: 'Recent activity on an item', params: IdParams } }, async (req) => {
    const { item } = await requireItem(db, await who(req), req.params.id, 'viewer');
    return { items: await activityRows(eq(driveActivity.itemId, item.id)) };
  });

  app.get(
    '/api/v1/drive/search',
    { schema: { tags: ['drive'], summary: 'Search file names and contents you can see', querystring: Type.Object({ q: Type.String({ minLength: 1, maxLength: 200 }), libraryId: Type.Optional(Type.String({ format: 'uuid' })) }) } },
    async (req) => {
      const p = await who(req);
      const libs = (await accessibleLibraries(db, p, me(req).orgId)).filter((l) => !req.query.libraryId || l.id === req.query.libraryId);
      const sharedRoots = await sharedWithMe(db, p);
      const libIds = [...new Set([...libs.map((l) => l.id), ...sharedRoots.map((s) => s.lib.id)])];
      if (!libIds.length) return { items: [] };
      const terms = req.query.q.trim();
      const rows = await db
        .select({ item: driveItems, rank: sql<number>`ts_rank(${driveItems.searchVector}, websearch_to_tsquery('simple', ${terms}))` })
        .from(driveItems)
        .where(and(inArray(driveItems.libraryId, libIds), isNull(driveItems.deletedAt), sql`(${driveItems.searchVector} @@ websearch_to_tsquery('simple', ${terms}) or ${driveItems.name} ilike ${`%${terms.replace(/[\\%_]/g, '\\$&')}%`})`))
        .orderBy(desc(sql`ts_rank(${driveItems.searchVector}, websearch_to_tsquery('simple', ${terms}))`), desc(driveItems.updatedAt))
        .limit(100);
      // The ACL engine decides what each person may see.
      const visible: DriveItem[] = [];
      for (const r of rows) {
        if (visible.length >= 50) break;
        if (await requireItem(db, p, r.item.id, 'viewer').then(() => true).catch(() => false)) visible.push(r.item);
      }
      const libNames = new Map(libs.map((l) => [l.id, l.name]));
      return { items: await serialiseMany(visible, (i) => ({ libraryName: libNames.get(i.libraryId) ?? null })) };
    },
  );
}
