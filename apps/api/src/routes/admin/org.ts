import { Type } from 'typebox';
import { organizations, orm } from '@forge/db';
import type { AppContext } from '../../context';
import { badRequest, notFound } from '../../errors';
import { authenticate, requirePermission } from '../../plugins/auth';
import { decodeImageDataUrl, releaseBlob, retainBlob } from '../../services/assets';
import { getPrimaryOrg, serializeOrg } from '../../services/directory';
import type { App } from '../../types';
import { HEX_COLOR, TIMEZONES } from '../public';

const { eq } = orm;

export function adminOrgRoutes(app: App, ctx: AppContext) {
  const { db } = ctx;
  app.addHook('preHandler', authenticate(ctx));

  const org = async () => {
    const o = await getPrimaryOrg(db);
    if (!o) throw notFound('Organisation');
    return o;
  };

  app.get('/api/v1/admin/org', { preHandler: requirePermission(ctx, 'org:read'), schema: { tags: ['admin: organisation'], summary: 'Organisation settings' } }, async () => ({
    org: serializeOrg(await org()),
  }));

  app.patch(
    '/api/v1/admin/org',
    {
      preHandler: requirePermission(ctx, 'org:manage'),
      schema: {
        tags: ['admin: organisation'],
        summary: 'Update organisation settings',
        body: Type.Object({
          name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
          timezone: Type.Optional(Type.String()),
          locale: Type.Optional(Type.String({ minLength: 2, maxLength: 35 })),
          brandColor: Type.Optional(Type.String({ pattern: HEX_COLOR })),
          defaultQuotaBytes: Type.Optional(Type.Integer({ minimum: 0 })),
          requireMfa: Type.Optional(Type.Boolean()),
          undoSendSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 60 })),
          mailMaxMessageBytes: Type.Optional(Type.Integer({ minimum: 1024 * 1024, maximum: 150 * 1024 * 1024 })),
        }),
      },
    },
    async (req) => {
      const current = await org();
      if (req.body.timezone && !TIMEZONES.has(req.body.timezone)) throw badRequest('Unknown timezone');
      const [updated] = await db.update(organizations).set(req.body).where(eq(organizations.id, current.id)).returning();
      const changes = Object.fromEntries(
        Object.keys(req.body).map((k) => [k, { from: current[k as keyof typeof current], to: updated![k as keyof typeof updated] }]),
      );
      await ctx.audit.fromRequest(req, { action: 'org.updated', targetType: 'organization', targetId: current.id, targetLabel: updated!.name, metadata: { changes } });
      void ctx.bus?.publish('org.updated', { orgId: current.id }).catch(() => {});
      return { org: serializeOrg(updated!) };
    },
  );

  app.put(
    '/api/v1/admin/org/logo',
    {
      preHandler: requirePermission(ctx, 'org:manage'),
      bodyLimit: 1024 * 1024,
      schema: { tags: ['admin: organisation'], summary: 'Upload a logo (PNG, JPEG or WebP data URL, max 512 KB)', body: Type.Object({ dataUrl: Type.String({ maxLength: 1_000_000 }) }) },
    },
    async (req) => {
      const current = await org();
      const { mime, data } = decodeImageDataUrl(req.body.dataUrl);
      const sha = await retainBlob(db, ctx.assets, 'drive', data, mime);
      await db.update(organizations).set({ logoBlob: sha, logoMime: mime }).where(eq(organizations.id, current.id));
      if (current.logoBlob && current.logoBlob !== sha) await releaseBlob(db, ctx.assets, current.logoBlob);
      else if (current.logoBlob === sha) await releaseBlob(db, ctx.assets, sha); // same image re-uploaded: keep one reference
      await ctx.audit.fromRequest(req, { action: 'org.logo_updated', targetType: 'organization', targetId: current.id, metadata: { sha256: sha, bytes: data.length } });
      return { ok: true };
    },
  );

  app.delete('/api/v1/admin/org/logo', { preHandler: requirePermission(ctx, 'org:manage'), schema: { tags: ['admin: organisation'], summary: 'Remove the logo' } }, async (req) => {
    const current = await org();
    if (current.logoBlob) {
      await db.update(organizations).set({ logoBlob: null, logoMime: null }).where(eq(organizations.id, current.id));
      await releaseBlob(db, ctx.assets, current.logoBlob);
      await ctx.audit.fromRequest(req, { action: 'org.logo_removed', targetType: 'organization', targetId: current.id });
    }
    return { ok: true };
  });
}
