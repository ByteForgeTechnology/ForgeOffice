import { Type } from 'typebox';
import { clamdPing } from '@forge/drive';
import { DEFAULT_DRIVE_SETTINGS, driveItems, driveLibraries, groups, orm, organizations, sites, users } from '@forge/db';
import type { AppContext } from '../../context';
import { badRequest, notFound } from '../../errors';
import { authenticate, requirePermission } from '../../plugins/auth';
import type { App } from '../../types';
import { driveSettings } from '../drive';
import { deleteSite } from '../sites';

const { and, asc, eq, sql } = orm;

/** Admin → ForgeDrive: policies, virus scanning / Office editing status, and storage by library. */
export function adminDriveRoutes(app: App, ctx: AppContext) {
  const { db } = ctx;
  app.addHook('preHandler', authenticate(ctx));

  const status = async () => {
    const { clamav, officeUrl, officeInternalUrl, officeProtocol, officeJwtSecret } = ctx.config.drive;
    let antivirus: { configured: boolean; ok: boolean; detail: string } = { configured: false, ok: false, detail: 'Not set up (FORGE_CLAMAV)' };
    if (clamav) antivirus = await clamdPing(clamav.host, clamav.port).then((v) => ({ configured: true, ok: true, detail: v }), (e: Error) => ({ configured: true, ok: false, detail: e.message }));
    let office: { configured: boolean; ok: boolean; detail: string } = { configured: false, ok: false, detail: 'Not set up (FORGE_OFFICE_URL)' };
    if (officeUrl && officeProtocol === 'docs' && !officeJwtSecret) office = { configured: true, ok: false, detail: 'Set FORGE_OFFICE_JWT_SECRET to the document server’s JWT_SECRET' };
    else if (officeUrl && officeProtocol === 'docs')
      office = await fetch(`${officeInternalUrl}/healthcheck`, { signal: AbortSignal.timeout(3000) }).then(
        async (r) => {
          const ok = r.ok && (await r.text()).trim() === 'true';
          return { configured: true, ok, detail: ok ? `Euro-Office at ${officeUrl}` : `Health check failed (HTTP ${r.status})` };
        },
        (e: Error) => ({ configured: true, ok: false, detail: e.message }),
      );
    else if (officeUrl)
      office = await fetch(`${officeInternalUrl}/hosting/discovery`, { signal: AbortSignal.timeout(3000) }).then(
        (r) => ({ configured: true, ok: r.ok, detail: r.ok ? `WOPI editor at ${officeUrl}` : `HTTP ${r.status}` }),
        (e: Error) => ({ configured: true, ok: false, detail: e.message }),
      );
    return { antivirus, office };
  };

  app.get('/api/v1/admin/drive/settings', { preHandler: requirePermission(ctx, 'org:read'), schema: { tags: ['admin: drive'], summary: 'ForgeDrive policies and service status' } }, async (req) => {
    const [totals] = await db
      .select({ libraries: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(${driveLibraries.usedBytes}), 0)::bigint` })
      .from(driveLibraries)
      .where(eq(driveLibraries.orgId, req.principal!.orgId));
    return { settings: await driveSettings(ctx, req.principal!.orgId), status: await status(), totals: { libraries: totals?.libraries ?? 0, bytes: Number(totals?.bytes ?? 0) } };
  });

  app.put(
    '/api/v1/admin/drive/settings',
    {
      preHandler: requirePermission(ctx, 'org:manage'),
      schema: {
        tags: ['admin: drive'],
        summary: 'Set ForgeDrive policies',
        body: Type.Object({
          trashDays: Type.Integer({ minimum: 1, maximum: 3650 }),
          maxUploadMb: Type.Integer({ minimum: 1, maximum: 102400 }),
          externalSharing: Type.Boolean(),
          linkMaxDays: Type.Union([Type.Integer({ minimum: 1, maximum: 3650 }), Type.Null()]),
        }),
      },
    },
    async (req) => {
      const before = await driveSettings(ctx, req.principal!.orgId);
      if (req.body.maxUploadMb > 102400) throw badRequest('Uploads can be at most 100 GB');
      const settings = { ...DEFAULT_DRIVE_SETTINGS, ...req.body };
      await db.update(organizations).set({ driveSettings: settings }).where(eq(organizations.id, req.principal!.orgId));
      await ctx.audit.fromRequest(req, { action: 'drive.settings_updated', targetType: 'organization', targetId: req.principal!.orgId, metadata: { before, after: settings } });
      return { settings };
    },
  );

  app.get('/api/v1/admin/drive/libraries', { preHandler: requirePermission(ctx, 'org:read'), schema: { tags: ['admin: drive'], summary: 'Every library with its storage use (not its contents)' } }, async (req) => {
    const rows = await db
      .select({
        id: driveLibraries.id,
        kind: driveLibraries.kind,
        name: driveLibraries.name,
        usedBytes: driveLibraries.usedBytes,
        owner: users.displayName,
        group: groups.name,
        site: sites.name,
        siteId: sites.id,
        siteSlug: sites.slug,
        disabledAt: driveLibraries.disabledAt,
        // Columns spelled out with their tables: Drizzle leaves them unqualified inside a sub-query here.
        items: sql<number>`(select count(*)::int from drive_items di where di.library_id = "drive_libraries"."id" and di.deleted_at is null)`,
        createdAt: driveLibraries.createdAt,
      })
      .from(driveLibraries)
      .leftJoin(users, eq(users.id, driveLibraries.ownerUserId))
      .leftJoin(groups, eq(groups.id, driveLibraries.groupId))
      .leftJoin(sites, eq(sites.libraryId, driveLibraries.id))
      .where(eq(driveLibraries.orgId, req.principal!.orgId))
      .orderBy(asc(driveLibraries.kind), asc(driveLibraries.name));
    return { items: rows };
  });

  // ---------------------------------------------------------------------------
  // Sites: an administrator can turn a site off (nobody, its owners included,
  // can open it or its documents until it is turned back on) or delete it.
  // ---------------------------------------------------------------------------

  const SiteParams = Type.Object({ id: Type.String({ format: 'uuid' }) });
  const siteInOrg = async (orgId: string, id: string) => {
    const [row] = await db.select({ site: sites, lib: driveLibraries }).from(sites).innerJoin(driveLibraries, eq(driveLibraries.id, sites.libraryId)).where(and(eq(sites.id, id), eq(sites.orgId, orgId))).limit(1);
    if (!row) throw notFound('Site');
    return row;
  };

  app.patch(
    '/api/v1/admin/drive/sites/:id',
    { preHandler: requirePermission(ctx, 'org:manage'), schema: { tags: ['admin: drive'], summary: 'Disable or re-enable a site (and its documents)', params: SiteParams, body: Type.Object({ disabled: Type.Boolean() }) } },
    async (req) => {
      const { site, lib } = await siteInOrg(req.principal!.orgId, req.params.id);
      const disabled = req.body.disabled;
      await db
        .update(driveLibraries)
        .set(disabled ? { disabledAt: lib.disabledAt ?? new Date(), disabledBy: lib.disabledBy ?? req.principal!.user!.id } : { disabledAt: null, disabledBy: null })
        .where(eq(driveLibraries.id, lib.id));
      await ctx.audit.fromRequest(req, { action: disabled ? 'sites.site_disabled' : 'sites.site_enabled', targetType: 'site', targetId: site.id, targetLabel: site.name });
      return { id: site.id, disabled };
    },
  );

  app.delete(
    '/api/v1/admin/drive/sites/:id',
    { preHandler: requirePermission(ctx, 'org:manage'), schema: { tags: ['admin: drive'], summary: 'Delete a site, its pages, lists and documents', params: SiteParams } },
    async (req) => {
      const { site, lib } = await siteInOrg(req.principal!.orgId, req.params.id);
      await deleteSite(ctx, site);
      await ctx.audit.fromRequest(req, { action: 'sites.site_deleted', targetType: 'site', targetId: site.id, targetLabel: site.name, metadata: { byAdmin: true, bytes: lib.usedBytes } });
      return { ok: true };
    },
  );
}
