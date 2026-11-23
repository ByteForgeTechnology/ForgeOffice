import { Type } from 'typebox';
import { verifyPassword } from '@forge/auth';
import { OFFICE_EDITABLE, ancestors, children, officeDocumentType, officeExtension, officeKey, principalFor, requireItem, signOfficeJwt, signToken, storeFile, verifyOfficeJwt, verifyToken } from '@forge/drive';
import { driveActivity, driveItems, driveLibraries, driveShareLinks, driveVersions, orm, users, type DriveItem } from '@forge/db';
import type { AppContext } from '../context';
import { HttpError, badRequest, forbidden, notFound } from '../errors';
import { authenticate } from '../plugins/auth';
import type { App } from '../types';
import { driveSettings, sendBlob } from './drive';

const { and, eq, sql } = orm;

/**
 * Routes reached without a ForgeOffice session: external sharing links (for
 * people outside the organisation), and the Office editor (Euro-Office) opening
 * and saving files: its save callback, or the WOPI host for Collabora Online. Each is authorised by a signed token.
 */
export function drivePublicRoutes(app: App, ctx: AppContext) {
  const { db } = ctx;
  const key = () => ctx.keys.shareLinkKey;

  // ---------------------------------------------------------------------------
  // External sharing links
  // ---------------------------------------------------------------------------

  const TokenParams = Type.Object({ token: Type.String({ maxLength: 2000 }) });

  /** The link behind a token, if it still works. */
  const loadLink = async (token: string) => {
    const claims = verifyToken<{ l: string }>(key(), token, 'share');
    if (!claims) throw new HttpError(404, 'This link does not exist', 'link_not_found');
    const [row] = await db
      .select({ link: driveShareLinks, item: driveItems, orgId: driveLibraries.orgId, libraryDisabled: driveLibraries.disabledAt, owner: users.displayName })
      .from(driveShareLinks)
      .innerJoin(driveItems, eq(driveItems.id, driveShareLinks.itemId))
      .innerJoin(driveLibraries, eq(driveLibraries.id, driveItems.libraryId))
      .leftJoin(users, eq(users.id, driveShareLinks.createdBy))
      .where(eq(driveShareLinks.id, claims.l))
      .limit(1);
    if (!row || row.link.revokedAt || row.item.deletedAt || row.libraryDisabled) throw new HttpError(404, 'This link no longer works', 'link_revoked');
    if (row.link.expiresAt && row.link.expiresAt < new Date()) throw new HttpError(410, 'This link has expired', 'link_expired');
    if (!(await driveSettings(ctx, row.orgId)).externalSharing) throw new HttpError(403, 'External sharing is turned off', 'sharing_disabled');
    return row;
  };

  /** Password-protected links need an access token from /unlock. */
  const checkAccess = (row: Awaited<ReturnType<typeof loadLink>>, access?: string) => {
    if (!row.link.passwordHash) return;
    const claims = access ? verifyToken<{ l: string }>(key(), access, 'share-access') : null;
    if (claims?.l !== row.link.id) throw new HttpError(401, 'Enter the password', 'password_required');
  };

  /** An item inside the shared item (a file in a shared folder). */
  const withinShare = async (row: Awaited<ReturnType<typeof loadLink>>, itemId?: string): Promise<DriveItem> => {
    if (!itemId || itemId === row.item.id) return row.item;
    const [it] = await db.select().from(driveItems).where(eq(driveItems.id, itemId)).limit(1);
    if (!it || it.deletedAt) throw notFound('File');
    if (!(await ancestors(ctx.drive, it)).some((a) => a.id === row.item.id)) throw notFound('File');
    return it;
  };

  const describe = (i: DriveItem) => ({ id: i.id, kind: i.kind, name: i.name, size: i.size, mime: i.mime, updatedAt: i.updatedAt });

  app.get('/api/v1/share/:token', { schema: { tags: ['sharing'], summary: 'What a sharing link points to', params: TokenParams } }, async (req) => {
    const row = await loadLink(req.params.token);
    if (row.link.passwordHash) return { needsPassword: true };
    return { needsPassword: false, item: describe(row.item), sharedBy: row.owner, expiresAt: row.link.expiresAt };
  });

  app.post(
    '/api/v1/share/:token/unlock',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { tags: ['sharing'], summary: 'Unlock a password-protected link', params: TokenParams, body: Type.Object({ password: Type.String({ maxLength: 200 }) }) } },
    async (req) => {
      const row = await loadLink(req.params.token);
      if (!row.link.passwordHash || !(await verifyPassword(row.link.passwordHash, req.body.password))) throw new HttpError(401, 'That password is not right', 'wrong_password');
      return { access: signToken(key(), { p: 'share-access', l: row.link.id }, 3600), item: describe(row.item), sharedBy: row.owner, expiresAt: row.link.expiresAt };
    },
  );

  app.get(
    '/api/v1/share/:token/items',
    { schema: { tags: ['sharing'], summary: 'Contents of a shared folder', params: TokenParams, querystring: Type.Object({ folderId: Type.Optional(Type.String({ format: 'uuid' })), access: Type.Optional(Type.String({ maxLength: 2000 })) }) } },
    async (req) => {
      const row = await loadLink(req.params.token);
      checkAccess(row, req.query.access);
      const folder = await withinShare(row, req.query.folderId);
      if (folder.kind !== 'folder') throw badRequest('Not a folder');
      const crumbs = (await ancestors(ctx.drive, folder)).slice((await ancestors(ctx.drive, row.item)).length - 1);
      return { breadcrumbs: crumbs.map((c) => ({ id: c.id, name: c.name })), items: (await children(ctx.drive, folder.libraryId, folder.id)).map(describe) };
    },
  );

  app.get(
    '/api/v1/share/:token/download',
    {
      schema: {
        tags: ['sharing'],
        summary: 'Download (or view) a shared file; supports Range',
        params: TokenParams,
        querystring: Type.Object({ itemId: Type.Optional(Type.String({ format: 'uuid' })), access: Type.Optional(Type.String({ maxLength: 2000 })), inline: Type.Optional(Type.Boolean()) }),
      },
    },
    async (req, reply) => {
      const row = await loadLink(req.params.token);
      checkAccess(row, req.query.access);
      const item = await withinShare(row, req.query.itemId);
      if (item.kind !== 'file') throw badRequest('Choose a file');
      if (item.scanStatus === 'infected') throw forbidden('This file contains a virus');
      if (item.scanStatus === 'pending') throw new HttpError(423, 'This file is still being checked for viruses. Try again in a moment.', 'scan_pending');
      const [v] = await db.select().from(driveVersions).where(eq(driveVersions.id, item.versionId!)).limit(1);
      if (!v) throw notFound('File');
      // Count whole downloads (not every byte range of a video).
      const range = req.headers.range;
      const counts = !range || /^bytes=0-/.test(range);
      if (counts) {
        const [updated] = await db
          .update(driveShareLinks)
          .set({ downloadCount: sql`${driveShareLinks.downloadCount} + 1` })
          .where(and(eq(driveShareLinks.id, row.link.id), sql`(${driveShareLinks.maxDownloads} is null or ${driveShareLinks.downloadCount} < ${driveShareLinks.maxDownloads})`))
          .returning();
        if (!updated) throw new HttpError(410, 'This link has reached its download limit', 'link_exhausted');
        await db.insert(driveActivity).values({ libraryId: item.libraryId, itemId: item.id, itemName: item.name, userId: null, action: 'link_downloaded', detail: { ip: req.ip } });
      }
      return sendBlob(ctx, reply, { sha: v.blobSha, size: v.size, mime: v.mime, name: item.name, download: !req.query.inline, range });
    },
  );

  // ---------------------------------------------------------------------------
  // WOPI (Euro-Office or Collabora Online): open and save Office files in the browser
  // ---------------------------------------------------------------------------

  let discovery: { at: number; actions: { ext: string; name: string; urlsrc: string }[] } | null = null;
  const loadDiscovery = async () => {
    if (discovery && Date.now() - discovery.at < 3600_000) return discovery.actions;
    // Fetched over the internal address; the editor URLs in it must use the one browsers reach.
    const { officeUrl, officeInternalUrl } = ctx.config.drive;
    const xml = await (await fetch(`${officeInternalUrl}/hosting/discovery`, { signal: AbortSignal.timeout(5000) })).text();
    const publicOrigin = new URL(officeUrl!).origin;
    const toPublic = (u: string) => {
      try {
        const url = new URL(u);
        return publicOrigin + url.pathname + url.search;
      } catch {
        return u;
      }
    };
    const actions = [...xml.matchAll(/<action\b[^>]*?\bext="([^"]*)"[^>]*?\bname="([^"]*)"[^>]*?\burlsrc="([^"]*)"|<action\b[^>]*?\bname="([^"]*)"[^>]*?\bext="([^"]*)"[^>]*?\burlsrc="([^"]*)"/g)].map((m) => ({
      ext: (m[1] ?? m[5] ?? '').toLowerCase(),
      name: m[2] ?? m[4] ?? '',
      urlsrc: toPublic((m[3] ?? m[6] ?? '').replace(/&amp;/g, '&')),
    }));
    discovery = { at: Date.now(), actions };
    return actions;
  };

  app.register(async (instance) => {
    const signedIn = instance as unknown as App;
    signedIn.addHook('preHandler', authenticate(ctx));
    signedIn.get('/api/v1/drive/items/:id/office', { schema: { tags: ['drive'], summary: 'Open an Office file in the Office editor (Docs API config or WOPI session)', params: Type.Object({ id: Type.String({ format: 'uuid' }) }) } }, async (req) => {
      const { officeUrl, officeProtocol, officeJwtSecret, wopiUrl } = ctx.config.drive;
      if (!officeUrl) throw new HttpError(404, 'Office editing is not set up', 'office_disabled');
      const user = req.principal!.user;
      const { item, role } = await requireItem(db, await principalFor(db, user.id), req.params.id, 'viewer');
      if (item.kind !== 'file') throw badRequest('Choose a file');
      if (item.scanStatus === 'infected') throw forbidden('This file contains a virus');
      const canWrite = role !== 'viewer' && role !== 'commenter' && (!item.checkedOutBy || item.checkedOutBy === user.id);

      if (officeProtocol === 'docs') {
        // Euro-Office: the browser loads api.js from the document server and
        // opens the editor with this signed config. The document server fetches
        // the file and posts saves back to drive-api directly.
        if (!officeJwtSecret) throw new HttpError(503, 'Office editing needs FORGE_OFFICE_JWT_SECRET (the document server’s JWT_SECRET)', 'office_misconfigured');
        const documentType = officeDocumentType(item.name);
        if (!documentType || !item.versionId) throw badRequest('This file type cannot be opened in the browser');
        const ext = officeExtension(item.name);
        const edit = canWrite && OFFICE_EDITABLE.has(ext);
        const [u] = await db.select({ name: users.displayName }).from(users).where(eq(users.id, user.id)).limit(1);
        const fileUrl = `${wopiUrl}/api/v1/drive/raw/${signToken(key(), { p: 'raw', i: item.id, v: item.versionId, d: 1 }, 8 * 3600)}`;
        const callbackUrl = `${wopiUrl}/api/v1/drive/office/callback/${signToken(key(), { p: 'office-cb', i: item.id })}`;
        const config = {
          documentType,
          document: {
            fileType: ext,
            key: officeKey(item.versionId),
            title: item.name,
            url: fileUrl,
            permissions: { edit, comment: edit, review: edit, fillForms: edit, download: true, print: true, copy: true },
          },
          editorConfig: {
            mode: edit ? 'edit' : 'view',
            callbackUrl,
            lang: 'en',
            user: { id: user.id, name: u?.name ?? 'User' },
            coEditing: { mode: 'fast', change: true },
            customization: { forcesave: false, compactHeader: true, uiTheme: 'theme-system' },
          },
        };
        return {
          protocol: 'docs' as const,
          apiUrl: `${officeUrl}/web-apps/apps/api/documents/api.js`,
          config: { ...config, token: signOfficeJwt(officeJwtSecret, config) },
          canWrite: edit,
          readOnlyReason: edit ? null : !canWrite ? (item.checkedOutBy && item.checkedOutBy !== user.id ? 'checked_out' : 'permission') : 'format',
        };
      }

      const ext = item.name.split('.').pop()!.toLowerCase();
      const actions = (await loadDiscovery()).filter((a) => a.ext === ext);
      const action = actions.find((a) => a.name === (canWrite ? 'edit' : 'view')) ?? actions.find((a) => a.name === 'view') ?? actions[0];
      if (!action) throw badRequest('This file type cannot be opened in the browser');
      const ttl = 10 * 3600;
      const accessToken = signToken(key(), { p: 'wopi', i: item.id, u: user.id, w: canWrite && action.name === 'edit' ? 1 : 0 }, ttl);
      const base = action.urlsrc.replace(/<[^>]*>/g, '');
      return { protocol: 'wopi' as const, actionUrl: `${base}${base.includes('?') ? '&' : '?'}WOPISrc=${encodeURIComponent(`${wopiUrl}/wopi/files/${item.id}`)}`, accessToken, accessTokenTtl: Date.now() + ttl * 1000, canWrite: canWrite && action.name === 'edit' };
    });
  });

  // ---------------------------------------------------------------------------
  // Euro-Office save callback (ONLYOFFICE Docs API)
  // ---------------------------------------------------------------------------

  /**
   * The document server reports editing status here. Status 2 (everyone has
   * closed the document) and 6 (force-save) carry a URL of the edited file,
   * which becomes a new version. Authorised twice: our signed token in the URL
   * (which file) and the document server's JWT (that it really is it).
   */
  interface OfficeCallback {
    key?: string;
    status?: number;
    url?: string;
    filetype?: string;
    users?: string[];
    actions?: { type: number; userid: string }[];
  }
  app.post(
    '/api/v1/drive/office/callback/:token',
    { bodyLimit: 1048576, schema: { tags: ['wopi'], summary: 'Euro-Office save callback (Docs API)', params: TokenParams } },
    async (req, reply) => {
      const { officeJwtSecret, officeInternalUrl } = ctx.config.drive;
      const ours = verifyToken<{ i: string }>(key(), req.params.token, 'office-cb');
      if (!ours || !officeJwtSecret) return reply.code(403).send({ error: 1 });
      // The document server sends its JWT in the body ("token") and/or the
      // Authorization header, where the callback data is under "payload".
      const raw = (req.body ?? {}) as OfficeCallback & { token?: string };
      const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
      const data = raw.token
        ? verifyOfficeJwt<OfficeCallback>(officeJwtSecret, raw.token)
        : bearer
          ? (verifyOfficeJwt<{ payload?: OfficeCallback }>(officeJwtSecret, bearer)?.payload ?? null)
          : null;
      if (!data) {
        req.log.warn({ itemId: ours.i }, 'office callback with an invalid or missing JWT');
        return reply.code(403).send({ error: 1 });
      }
      if (data.status === 3 || data.status === 7) req.log.warn({ itemId: ours.i, status: data.status }, 'the Office editor could not save a document');
      if ((data.status !== 2 && data.status !== 6) || !data.url) return { error: 0 };

      const [item] = await db.select().from(driveItems).where(eq(driveItems.id, ours.i)).limit(1);
      if (!item || item.deletedAt || item.kind !== 'file') return { error: 0 }; // gone: nothing to save into
      const [lib] = await db.select().from(driveLibraries).where(eq(driveLibraries.id, item.libraryId)).limit(1);

      // Save as the last person who edited and may still edit it.
      const candidates = [...new Set([...(data.actions ?? []).map((a) => a.userid), ...(data.users ?? [])].reverse())];
      let userId: string | null = null;
      for (const id of candidates) {
        if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
        try {
          await requireItem(db, await principalFor(db, id), item.id, 'editor');
          userId = id;
          break;
        } catch {
          /* lost access since: try the next editor */
        }
      }
      if (!userId) {
        req.log.warn({ itemId: item.id }, 'office callback: no editor of this file is still allowed to save it');
        return reply.code(403).send({ error: 1 });
      }

      // The URL names the document server as browsers reach it; fetch it over the internal address.
      const edited = new URL(data.url);
      const fetchUrl = officeInternalUrl ? `${officeInternalUrl}${edited.pathname}${edited.search}` : data.url;
      const res = await fetch(fetchUrl, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok || !res.body) {
        req.log.error({ itemId: item.id, status: res.status }, 'could not download the edited document');
        return reply.code(502).send({ error: 1 });
      }
      const body = Buffer.from(await res.arrayBuffer());
      const ext = officeExtension(item.name);
      const returned = (data.filetype ?? ext).toLowerCase();
      if (returned === ext) {
        await storeFile(ctx.drive, { lib: lib!, parentId: item.parentId, itemId: item.id, name: item.name, mime: item.mime, source: body, userId, comment: 'Edited in Euro-Office' });
      } else {
        // Saved in another format than the original: keep it beside the original rather than overwrite it.
        const name = item.name.replace(/\.[^.]+$/, '') + `.${returned}`;
        await storeFile(ctx.drive, { lib: lib!, parentId: item.parentId, name, mime: null, source: body, userId, conflict: 'rename', comment: `Edited in Euro-Office (saved as ${returned.toUpperCase()})` });
      }
      return { error: 0 };
    },
  );

  const WopiParams = Type.Object({ id: Type.String({ format: 'uuid' }) });
  const WopiQuery = Type.Object({ access_token: Type.String({ maxLength: 2000 }) });
  const wopiAuth = (id: string, token: string) => {
    const claims = verifyToken<{ i: string; u: string; w: number }>(key(), token, 'wopi');
    if (!claims || claims.i !== id) throw new HttpError(401, 'Invalid access token', 'wopi_unauthorized');
    return claims;
  };
  const loadWopi = async (id: string) => {
    const [item] = await db.select().from(driveItems).where(eq(driveItems.id, id)).limit(1);
    if (!item || item.deletedAt || item.kind !== 'file') throw notFound('File');
    return item;
  };
  const currentLock = (i: DriveItem) => (i.wopiLock && i.wopiLockExpiresAt && i.wopiLockExpiresAt > new Date() ? i.wopiLock : null);
  const LOCK_MS = 30 * 60_000;

  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  app.get('/wopi/files/:id', { schema: { tags: ['wopi'], summary: 'WOPI CheckFileInfo', params: WopiParams, querystring: WopiQuery } }, async (req) => {
    const claims = wopiAuth(req.params.id, req.query.access_token);
    const item = await loadWopi(req.params.id);
    const [u] = await db.select({ name: users.displayName }).from(users).where(eq(users.id, claims.u)).limit(1);
    return {
      BaseFileName: item.name,
      Size: item.size,
      OwnerId: item.createdBy ?? 'forge',
      UserId: claims.u,
      UserFriendlyName: u?.name ?? 'User',
      Version: item.versionId ?? '0',
      LastModifiedTime: item.updatedAt.toISOString(),
      UserCanWrite: !!claims.w,
      UserCanNotWriteRelative: true,
      SupportsLocks: true,
      SupportsUpdate: true,
      SupportsGetLock: true,
    };
  });

  app.get('/wopi/files/:id/contents', { schema: { tags: ['wopi'], summary: 'WOPI GetFile', params: WopiParams, querystring: WopiQuery } }, async (req, reply) => {
    wopiAuth(req.params.id, req.query.access_token);
    const item = await loadWopi(req.params.id);
    if (item.scanStatus === 'infected') throw forbidden('This file contains a virus');
    reply.header('X-WOPI-ItemVersion', item.versionId ?? '0').header('Content-Type', 'application/octet-stream');
    return reply.send(ctx.drive.blobs.createReadStream(item.sha256!));
  });

  app.post('/wopi/files/:id/contents', { bodyLimit: 1024 * 1048576, schema: { tags: ['wopi'], summary: 'WOPI PutFile (saves a new version)', params: WopiParams, querystring: WopiQuery } }, async (req, reply) => {
    const claims = wopiAuth(req.params.id, req.query.access_token);
    if (!claims.w) throw new HttpError(401, 'Read-only access', 'wopi_readonly');
    const item = await loadWopi(req.params.id);
    const lock = currentLock(item);
    const given = req.headers['x-wopi-lock'] as string | undefined;
    if (lock && lock !== given) return reply.code(409).header('X-WOPI-Lock', lock).send();
    // Still allowed to edit? (Permissions may have changed since the editor opened.)
    await requireItem(db, await principalFor(db, claims.u), item.id, 'editor');
    const [lib] = await db.select().from(driveLibraries).where(eq(driveLibraries.id, item.libraryId)).limit(1);
    const stored = await storeFile(ctx.drive, { lib: lib!, parentId: item.parentId, itemId: item.id, name: item.name, mime: item.mime, source: req.body as never, userId: claims.u, comment: 'Edited in the browser' });
    return reply.header('X-WOPI-ItemVersion', stored.version.id).send({ LastModifiedTime: stored.item.updatedAt.toISOString() });
  });

  app.post('/wopi/files/:id', { schema: { tags: ['wopi'], summary: 'WOPI locks (LOCK, GET_LOCK, REFRESH_LOCK, UNLOCK)', params: WopiParams, querystring: WopiQuery } }, async (req, reply) => {
    const claims = wopiAuth(req.params.id, req.query.access_token);
    const item = await loadWopi(req.params.id);
    const op = String(req.headers['x-wopi-override'] ?? '').toUpperCase();
    const given = String(req.headers['x-wopi-lock'] ?? '');
    const old = req.headers['x-wopi-oldlock'] as string | undefined;
    const lock = currentLock(item);
    const conflict = () => reply.code(409).header('X-WOPI-Lock', lock ?? '').send();
    const setLock = async (value: string | null) => {
      await db.update(driveItems).set({ wopiLock: value, wopiLockExpiresAt: value ? new Date(Date.now() + LOCK_MS) : null }).where(eq(driveItems.id, item.id));
      return reply.code(200).header('X-WOPI-ItemVersion', item.versionId ?? '0').send();
    };
    switch (op) {
      case 'GET_LOCK':
        return reply.code(200).header('X-WOPI-Lock', lock ?? '').send();
      case 'LOCK':
        if (!claims.w) return reply.code(401).send();
        if (old !== undefined) return lock === old ? setLock(given) : conflict(); // UnlockAndRelock
        if (!lock || lock === given) return setLock(given);
        return conflict();
      case 'REFRESH_LOCK':
        return lock === given ? setLock(given) : conflict();
      case 'UNLOCK':
        return lock === given ? setLock(null) : conflict();
      default:
        return reply.code(501).send();
    }
  });
}
