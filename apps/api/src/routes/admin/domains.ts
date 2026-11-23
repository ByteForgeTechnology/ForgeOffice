import { resolveTxt } from 'node:dns/promises';
import { Type } from 'typebox';
import { domains, groups, orm, users } from '@forge/db';
import type { AppContext } from '../../context';
import { conflict, isUniqueViolation, notFound } from '../../errors';
import { authenticate, requirePermission } from '../../plugins/auth';
import { newVerificationToken, normaliseDomain } from '../../services/directory';
import { ensureDkimKey } from '@forge/mail';
import type { App } from '../../types';

const { and, asc, count, eq, like } = orm;
const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

export const TXT_PREFIX = 'forge-verification=';

export function adminDomainRoutes(app: App, ctx: AppContext) {
  const { db } = ctx;
  app.addHook('preHandler', authenticate(ctx));

  const load = async (orgId: string, id: string) => {
    const [d] = await db.select().from(domains).where(and(eq(domains.id, id), eq(domains.orgId, orgId))).limit(1);
    if (!d) throw notFound('Domain');
    return d;
  };

  const serialize = (d: typeof domains.$inferSelect, userCount?: number) => ({
    id: d.id,
    name: d.name,
    isPrimary: d.isPrimary,
    verified: d.verified,
    verifiedAt: d.verifiedAt?.toISOString() ?? null,
    verificationRecord: { type: 'TXT', host: d.name, value: `${TXT_PREFIX}${d.verificationToken}` },
    createdAt: d.createdAt.toISOString(),
    ...(userCount !== undefined ? { userCount } : {}),
  });

  app.get(
    '/api/v1/admin/domains',
    { preHandler: requirePermission(ctx, 'org:read'), schema: { tags: ['admin: domains'], summary: 'List domains' } },
    async (req) => {
      const rows = await db
        .select({ domain: domains, userCount: count(users.id) })
        .from(domains)
        .leftJoin(users, eq(users.domainId, domains.id))
        .where(eq(domains.orgId, req.principal!.orgId))
        .groupBy(domains.id)
        .orderBy(asc(domains.name));
      return { items: rows.map((r) => serialize(r.domain, r.userCount)) };
    },
  );

  app.post(
    '/api/v1/admin/domains',
    {
      preHandler: requirePermission(ctx, 'domains:manage'),
      schema: { tags: ['admin: domains'], summary: 'Register a domain', body: Type.Object({ name: Type.String({ minLength: 3, maxLength: 253 }) }) },
    },
    async (req, reply) => {
      const name = normaliseDomain(req.body.name);
      try {
        const [d] = await db.insert(domains).values({ orgId: req.principal!.orgId, name, verificationToken: newVerificationToken() }).returning();
        await ensureDkimKey(ctx.mail, d!).catch((err) => req.log.warn({ err }, 'could not create DKIM key'));
        await ctx.audit.fromRequest(req, { action: 'domain.added', targetType: 'domain', targetId: d!.id, targetLabel: name });
        reply.code(201);
        return { domain: serialize(d!, 0) };
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict(`${name} is already registered`);
        throw err;
      }
    },
  );

  app.post(
    '/api/v1/admin/domains/:id/verify',
    {
      preHandler: requirePermission(ctx, 'domains:manage'),
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: { tags: ['admin: domains'], summary: 'Check the DNS TXT verification record', params: IdParams },
    },
    async (req) => {
      const d = await load(req.principal!.orgId, req.params.id);
      const expected = `${TXT_PREFIX}${d.verificationToken}`;
      let records: string[] = [];
      let lookupError: string | null = null;
      try {
        records = (await resolveTxt(d.name)).map((chunks) => chunks.join(''));
      } catch (err) {
        lookupError = (err as NodeJS.ErrnoException).code ?? 'lookup failed';
      }
      const verified = records.includes(expected);
      if (verified && !d.verified) {
        await db.update(domains).set({ verified: true, verifiedAt: new Date() }).where(eq(domains.id, d.id));
        await ctx.audit.fromRequest(req, { action: 'domain.verified', targetType: 'domain', targetId: d.id, targetLabel: d.name });
      }
      return { verified: verified || d.verified, found: records.filter((r) => r.startsWith(TXT_PREFIX)), expected, lookupError };
    },
  );

  app.post(
    '/api/v1/admin/domains/:id/primary',
    { preHandler: requirePermission(ctx, 'domains:manage'), schema: { tags: ['admin: domains'], summary: 'Make this the primary domain', params: IdParams } },
    async (req) => {
      const orgId = req.principal!.orgId;
      const d = await load(orgId, req.params.id);
      await db.transaction(async (tx) => {
        await tx.update(domains).set({ isPrimary: false }).where(eq(domains.orgId, orgId));
        await tx.update(domains).set({ isPrimary: true }).where(eq(domains.id, d.id));
      });
      await ctx.audit.fromRequest(req, { action: 'domain.primary_changed', targetType: 'domain', targetId: d.id, targetLabel: d.name });
      return { ok: true };
    },
  );

  app.delete(
    '/api/v1/admin/domains/:id',
    { preHandler: requirePermission(ctx, 'domains:manage'), schema: { tags: ['admin: domains'], summary: 'Remove an unused domain', params: IdParams } },
    async (req) => {
      const d = await load(req.principal!.orgId, req.params.id);
      if (d.isPrimary) throw conflict('The primary domain cannot be removed');
      const [u] = await db.select({ n: count() }).from(users).where(eq(users.domainId, d.id));
      const [g] = await db.select({ n: count() }).from(groups).where(like(groups.email, `%@${d.name}`));
      if ((u?.n ?? 0) > 0 || (g?.n ?? 0) > 0) throw conflict('Users or groups still use this domain');
      await db.delete(domains).where(eq(domains.id, d.id));
      await ctx.audit.fromRequest(req, { action: 'domain.removed', targetType: 'domain', targetId: d.id, targetLabel: d.name });
      return { ok: true };
    },
  );
}
