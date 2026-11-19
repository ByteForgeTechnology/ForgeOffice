import { Type, type Static } from 'typebox';
import { groups, oauthApps, orm, type OAuthApp } from '@forge/db';
import type { AppContext } from '../../context';
import { badRequest, notFound } from '../../errors';
import { authenticate, requirePermission } from '../../plugins/auth';
import { APP_SCOPES, APP_SCOPE_NAMES, checkRedirectUri, encryptSecret, newClientId, newClientSecret, revokeAppAccess } from '../../services/oauth-apps';
import type { App } from '../../types';

const { and, asc, eq, inArray } = orm;
const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

const AppBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.String({ maxLength: 1000, default: '' }),
  homepageUrl: Type.Union([Type.String({ maxLength: 500 }), Type.Null()], { default: null }),
  redirectUris: Type.Array(Type.String({ maxLength: 1000 }), { minItems: 1, maxItems: 20 }),
  postLogoutRedirectUris: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 20, default: [] }),
  scopes: Type.Array(Type.String(), { maxItems: 10, default: ['openid', 'profile', 'email'] }),
  access: Type.Union([Type.Literal('all'), Type.Literal('groups')], { default: 'all' }),
  groupIds: Type.Array(Type.String({ format: 'uuid' }), { maxItems: 100, default: [] }),
  consent: Type.Union([Type.Literal('user'), Type.Literal('admin')], { default: 'user' }),
  authMethod: Type.Union([Type.Literal('client_secret_basic'), Type.Literal('client_secret_post')], { default: 'client_secret_basic' }),
  enabled: Type.Boolean({ default: true }),
});
type AppInput = Static<typeof AppBody>;

/**
 * ForgeDirectory → App registrations: applications that sign people in with
 * their ForgeOffice account over OAuth 2.0 / OpenID Connect.
 */
export function adminAppRoutes(app: App, ctx: AppContext) {
  const { db, config } = ctx;
  app.addHook('preHandler', authenticate(ctx));

  const serialise = (a: OAuthApp) => {
    const { secretEnc: _s, ...rest } = a;
    return { ...rest, hasSecret: !!a.secretEnc };
  };

  const validate = async (orgId: string, b: AppInput) => {
    const redirectUris = [...new Set(b.redirectUris.map(checkRedirectUri))];
    const postLogoutRedirectUris = [...new Set(b.postLogoutRedirectUris.filter((u) => u.trim()).map(checkRedirectUri))];
    let homepageUrl = b.homepageUrl?.trim() || null;
    if (homepageUrl) {
      try {
        const u = new URL(homepageUrl);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
        homepageUrl = u.toString();
      } catch {
        throw badRequest('Enter a homepage such as https://app.example.com');
      }
    }
    const unknown = b.scopes.filter((s) => !APP_SCOPE_NAMES.includes(s));
    if (unknown.length) throw badRequest(`Unknown scope: ${unknown.join(', ')}`);
    const scopes = [...new Set(['openid', ...b.scopes])];
    if (b.access === 'groups') {
      if (!b.groupIds.length) throw badRequest('Choose at least one group');
      const found = await db.select({ id: groups.id }).from(groups).where(and(eq(groups.orgId, orgId), inArray(groups.id, b.groupIds)));
      if (found.length !== new Set(b.groupIds).size) throw badRequest('One or more groups do not exist');
    }
    return { ...b, name: b.name.trim(), homepageUrl, redirectUris, postLogoutRedirectUris, scopes, groupIds: b.access === 'groups' ? b.groupIds : [] };
  };

  const load = async (orgId: string, id: string) => {
    const [row] = await db.select().from(oauthApps).where(and(eq(oauthApps.id, id), eq(oauthApps.orgId, orgId))).limit(1);
    if (!row) throw notFound('Application');
    return row;
  };

  /** Everything an app developer needs to connect. */
  app.get('/api/v1/admin/apps/endpoints', { preHandler: requirePermission(ctx, 'org:read'), schema: { tags: ['admin: apps'], summary: 'OAuth / OpenID Connect endpoints and scopes' } }, async () => ({
    issuer: config.issuer,
    discovery: `${config.issuer}/.well-known/openid-configuration`,
    authorization: `${config.issuer}/auth`,
    token: `${config.issuer}/token`,
    userinfo: `${config.issuer}/me`,
    jwks: `${config.issuer}/jwks`,
    endSession: `${config.issuer}/session/end`,
    revocation: `${config.issuer}/token/revocation`,
    scopes: APP_SCOPES,
  }));

  app.get('/api/v1/admin/apps', { preHandler: requirePermission(ctx, 'org:read'), schema: { tags: ['admin: apps'], summary: 'Registered applications' } }, async (req) => ({
    items: (await db.select().from(oauthApps).where(eq(oauthApps.orgId, req.principal!.orgId)).orderBy(asc(oauthApps.name))).map(serialise),
  }));

  app.get('/api/v1/admin/apps/:id', { preHandler: requirePermission(ctx, 'org:read'), schema: { tags: ['admin: apps'], summary: 'An application', params: IdParams } }, async (req) => ({
    app: serialise(await load(req.principal!.orgId, req.params.id)),
  }));

  app.post(
    '/api/v1/admin/apps',
    {
      preHandler: requirePermission(ctx, 'org:manage'),
      schema: {
        tags: ['admin: apps'],
        summary: 'Register an application (the client secret is returned once)',
        body: Type.Intersect([AppBody, Type.Object({ type: Type.Union([Type.Literal('confidential'), Type.Literal('public')]) })]),
      },
    },
    async (req, reply) => {
      const orgId = req.principal!.orgId;
      const { type, ...rest } = req.body as AppInput & { type: 'confidential' | 'public' };
      const body = await validate(orgId, rest);
      const secret = type === 'confidential' ? newClientSecret() : null;
      const [row] = await db
        .insert(oauthApps)
        .values({ ...body, orgId, type, clientId: newClientId(), createdBy: req.principal!.user.id, ...(secret ? encryptSecret(ctx.keys.oauthSecretKey, secret) : {}) })
        .returning();
      await ctx.audit.fromRequest(req, { action: 'oauth.app_created', targetType: 'oauth_app', targetId: row!.id, targetLabel: row!.name, metadata: { clientId: row!.clientId, type, scopes: body.scopes, redirectUris: body.redirectUris } });
      reply.code(201);
      return { app: serialise(row!), clientSecret: secret };
    },
  );

  app.put(
    '/api/v1/admin/apps/:id',
    { preHandler: requirePermission(ctx, 'org:manage'), schema: { tags: ['admin: apps'], summary: 'Update an application', params: IdParams, body: AppBody } },
    async (req) => {
      const before = await load(req.principal!.orgId, req.params.id);
      const body = await validate(req.principal!.orgId, req.body);
      const [row] = await db.update(oauthApps).set(body).where(eq(oauthApps.id, before.id)).returning();
      // Switching an app off, or narrowing what it may see, ends existing access.
      const narrowed = before.scopes.some((s) => !body.scopes.includes(s));
      if ((before.enabled && !body.enabled) || narrowed) await revokeAppAccess(db, before.clientId);
      const changes = Object.fromEntries(
        (Object.keys(body) as (keyof typeof body)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(body[k])).map((k) => [k, { from: before[k], to: body[k] }]),
      );
      await ctx.audit.fromRequest(req, { action: 'oauth.app_updated', targetType: 'oauth_app', targetId: row!.id, targetLabel: row!.name, metadata: { changes } });
      return { app: serialise(row!) };
    },
  );

  app.post(
    '/api/v1/admin/apps/:id/secret',
    { preHandler: requirePermission(ctx, 'org:manage'), schema: { tags: ['admin: apps'], summary: 'Generate a new client secret (the old one stops working)', params: IdParams } },
    async (req) => {
      const a = await load(req.principal!.orgId, req.params.id);
      if (a.type !== 'confidential') throw badRequest('Public apps (SPAs and mobile apps) do not use a secret');
      const secret = newClientSecret();
      const [row] = await db.update(oauthApps).set(encryptSecret(ctx.keys.oauthSecretKey, secret)).where(eq(oauthApps.id, a.id)).returning();
      await ctx.audit.fromRequest(req, { action: 'oauth.app_secret_rotated', targetType: 'oauth_app', targetId: a.id, targetLabel: a.name });
      return { app: serialise(row!), clientSecret: secret };
    },
  );

  app.post(
    '/api/v1/admin/apps/:id/revoke',
    { preHandler: requirePermission(ctx, 'org:manage'), schema: { tags: ['admin: apps'], summary: 'Sign everyone out of the app (ends all its tokens and consents)', params: IdParams } },
    async (req) => {
      const a = await load(req.principal!.orgId, req.params.id);
      const grants = await revokeAppAccess(db, a.clientId);
      await ctx.audit.fromRequest(req, { action: 'oauth.app_access_revoked', targetType: 'oauth_app', targetId: a.id, targetLabel: a.name, metadata: { grants } });
      return { revoked: grants };
    },
  );

  app.delete('/api/v1/admin/apps/:id', { preHandler: requirePermission(ctx, 'org:manage'), schema: { tags: ['admin: apps'], summary: 'Delete an application', params: IdParams } }, async (req) => {
    const a = await load(req.principal!.orgId, req.params.id);
    await revokeAppAccess(db, a.clientId);
    await db.delete(oauthApps).where(eq(oauthApps.id, a.id));
    await ctx.audit.fromRequest(req, { action: 'oauth.app_deleted', targetType: 'oauth_app', targetId: a.id, targetLabel: a.name, metadata: { clientId: a.clientId } });
    return { ok: true };
  });
}
