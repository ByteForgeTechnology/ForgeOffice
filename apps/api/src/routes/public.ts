import { Type } from 'typebox';
import { BUILTIN_ROLES, GLOBAL_ADMIN, safeEqual } from '@forge/auth';
import { domains, organizations, orm } from '@forge/db';
import type { AppContext } from '../context';
import { HttpError, badRequest, notFound } from '../errors';
import { discardSetupToken } from '../secrets';
import { decodeImageDataUrl, retainBlob } from '../services/assets';
import { createUser, getPrimaryOrg, newVerificationToken, normaliseDomain, seedBuiltinRoles, slugify } from '../services/directory';
import type { App } from '../types';

const { sql } = orm;

export const TIMEZONES = new Set(Intl.supportedValuesOf('timeZone').concat('UTC'));
export const HEX_COLOR = '^#[0-9a-fA-F]{6}$';

export function publicRoutes(app: App, ctx: AppContext) {
  app.get('/api/v1/branding', { schema: { tags: ['public'], summary: 'Organisation branding for sign-in and shell screens' } }, async () => {
    const org = await getPrimaryOrg(ctx.db);
    return {
      needsSetup: !org?.setupCompletedAt,
      name: org?.name ?? 'ForgeOffice',
      brandColor: org?.brandColor ?? '#4f46e5',
      logoUrl: org?.logoBlob ? `/api/v1/branding/logo?v=${org.logoBlob.slice(0, 12)}` : null,
      timezone: org?.timezone ?? 'UTC',
    };
  });

  app.get('/api/v1/branding/logo', { schema: { tags: ['public'], summary: 'Organisation logo image' } }, async (_req, reply) => {
    const org = await getPrimaryOrg(ctx.db);
    if (!org?.logoBlob) throw notFound('Logo');
    reply
      .header('Content-Type', org.logoMime ?? 'application/octet-stream')
      .header('Cache-Control', 'public, max-age=3600')
      .header('X-Content-Type-Options', 'nosniff');
    return reply.send(ctx.assets.createReadStream(org.logoBlob));
  });

  app.get('/api/v1/setup/status', { schema: { tags: ['setup'], summary: 'Whether first-run setup is still required' } }, async () => {
    const org = await getPrimaryOrg(ctx.db);
    return {
      needsSetup: !org?.setupCompletedAt,
      timezones: [...TIMEZONES].sort(),
      passwordMinLength: 12,
    };
  });

  app.post(
    '/api/v1/setup',
    {
      bodyLimit: 2 * 1024 * 1024,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['setup'],
        summary: 'Create the organisation, primary domain and first global administrator',
        body: Type.Object({
          setupToken: Type.String({ minLength: 1, maxLength: 256 }),
          organization: Type.Object({
            name: Type.String({ minLength: 1, maxLength: 120 }),
            timezone: Type.String(),
            locale: Type.Optional(Type.String({ maxLength: 35 })),
            brandColor: Type.Optional(Type.String({ pattern: HEX_COLOR })),
            defaultQuotaBytes: Type.Integer({ minimum: 0 }),
            requireMfa: Type.Boolean(),
            logoDataUrl: Type.Optional(Type.String({ maxLength: 1_000_000 })),
          }),
          domain: Type.String({ minLength: 3, maxLength: 253 }),
          admin: Type.Object({
            username: Type.String({ minLength: 1, maxLength: 64 }),
            displayName: Type.String({ minLength: 1, maxLength: 200 }),
            givenName: Type.Optional(Type.String({ maxLength: 100 })),
            familyName: Type.Optional(Type.String({ maxLength: 100 })),
            password: Type.String({ minLength: 1, maxLength: 256 }),
          }),
        }),
      },
    },
    async (req) => {
      const { body } = req;
      if (!ctx.setupToken) throw new HttpError(409, 'Setup has already been completed', 'setup_complete');
      if (!safeEqual(body.setupToken.trim(), ctx.setupToken)) {
        await ctx.audit.record({ action: 'setup.token_rejected', outcome: 'failure', ip: req.ip, userAgent: req.headers['user-agent'] });
        throw new HttpError(403, 'The setup token is not correct. It is printed in the API logs on startup.', 'invalid_setup_token');
      }
      if (!TIMEZONES.has(body.organization.timezone)) throw badRequest('Unknown timezone');
      const domainName = normaliseDomain(body.domain);
      const logo = body.organization.logoDataUrl ? decodeImageDataUrl(body.organization.logoDataUrl) : null;

      const result = await ctx.db.transaction(async (tx) => {
        // Serialise concurrent setup attempts.
        await tx.execute(sql`select pg_advisory_xact_lock(7311)`);
        const existing = await getPrimaryOrg(tx);
        if (existing?.setupCompletedAt) throw new HttpError(409, 'Setup has already been completed', 'setup_complete');

        const [org] = await tx
          .insert(organizations)
          .values({
            name: body.organization.name.trim(),
            slug: slugify(body.organization.name),
            timezone: body.organization.timezone,
            locale: body.organization.locale ?? 'en-GB',
            brandColor: body.organization.brandColor ?? '#4f46e5',
            defaultQuotaBytes: body.organization.defaultQuotaBytes,
            requireMfa: body.organization.requireMfa,
          })
          .returning();
        if (!org) throw new Error('organisation insert failed');
        await tx.insert(domains).values({ orgId: org.id, name: domainName, isPrimary: true, verificationToken: newVerificationToken() });
        await seedBuiltinRoles(tx, org.id);
        const admin = await createUser(tx, {
          orgId: org.id,
          username: body.admin.username,
          displayName: body.admin.displayName,
          givenName: body.admin.givenName,
          familyName: body.admin.familyName,
          password: body.admin.password,
          roleKeys: [GLOBAL_ADMIN],
        });
        if (logo) {
          const sha = await retainBlob(tx, ctx.assets, 'drive', logo.data, logo.mime);
          await tx.update(organizations).set({ logoBlob: sha, logoMime: logo.mime }).where(orm.eq(organizations.id, org.id));
        }
        await tx.update(organizations).set({ setupCompletedAt: new Date() }).where(orm.eq(organizations.id, org.id));
        return { org, admin };
      });

      ctx.setupToken = null;
      await discardSetupToken(ctx.config.volumes.certs.path);
      await ctx.audit.record({
        action: 'setup.completed',
        orgId: result.org.id,
        actorId: result.admin.id,
        actorLabel: result.admin.email,
        targetType: 'organization',
        targetId: result.org.id,
        targetLabel: result.org.name,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        metadata: { domain: domainName, roles: BUILTIN_ROLES.map((r) => r.key) },
      });
      return { ok: true, adminEmail: result.admin.email };
    },
  );
}
