import { Type } from 'typebox';
import { oauthApps, oidcPayloads, orm } from '@forge/db';
import type { AppContext } from '../context';
import { notFound } from '../errors';
import { authenticate } from '../plugins/auth';
import { APP_SCOPES, revokeAppAccess } from '../services/oauth-apps';
import type { App } from '../types';

const { and, eq, inArray } = orm;

/** Account → Connected apps: registered apps you have allowed to sign you in. */
export function connectedAppRoutes(app: App, ctx: AppContext) {
  const { db } = ctx;
  app.addHook('preHandler', authenticate(ctx));

  app.get('/api/v1/me/apps', { schema: { tags: ['me'], summary: 'Apps you have signed in to with your ForgeOffice account' } }, async (req) => {
    const me = req.principal!.user.id;
    const grants = await db.select({ payload: oidcPayloads.payload }).from(oidcPayloads).where(and(eq(oidcPayloads.type, 'Grant'), eq(oidcPayloads.accountId, me)));
    const byClient = new Map<string, { scopes: Set<string>; since: number }>();
    for (const { payload } of grants) {
      const p = payload as { clientId?: string; iat?: number; openid?: { scope?: string } };
      if (!p.clientId) continue;
      const entry = byClient.get(p.clientId) ?? { scopes: new Set<string>(), since: p.iat ?? 0 };
      (p.openid?.scope ?? '').split(' ').filter(Boolean).forEach((s) => entry.scopes.add(s));
      entry.since = Math.min(entry.since || Infinity, p.iat ?? Infinity);
      byClient.set(p.clientId, entry);
    }
    if (!byClient.size) return { items: [] };
    // Only registered apps: ForgeOffice's own apps are not "connected apps".
    const apps = await db.select().from(oauthApps).where(inArray(oauthApps.clientId, [...byClient.keys()]));
    return {
      items: apps.map((a) => {
        const g = byClient.get(a.clientId)!;
        return {
          clientId: a.clientId,
          name: a.name,
          description: a.description,
          homepageUrl: a.homepageUrl,
          enabled: a.enabled,
          since: Number.isFinite(g.since) ? new Date(g.since * 1000).toISOString() : null,
          permissions: APP_SCOPES.filter((s) => g.scopes.has(s.scope)).map(({ scope, label }) => ({ scope, label })),
        };
      }),
    };
  });

  app.delete(
    '/api/v1/me/apps/:clientId',
    { schema: { tags: ['me'], summary: 'Remove an app’s access to your account', params: Type.Object({ clientId: Type.String({ maxLength: 100 }) }) } },
    async (req) => {
      const me = req.principal!.user;
      const [a] = await db.select({ name: oauthApps.name }).from(oauthApps).where(eq(oauthApps.clientId, req.params.clientId)).limit(1);
      if (!a) throw notFound('App');
      const removed = await revokeAppAccess(db, req.params.clientId, me.id);
      await ctx.audit.fromRequest(req, { action: 'oauth.app_access_removed', targetType: 'oauth_app', targetLabel: a.name, metadata: { clientId: req.params.clientId, grants: removed } });
      return { ok: true };
    },
  );
}
