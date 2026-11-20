import { Type } from 'typebox';
import { oauthApps, orm, userSessions, type UserSession } from '@forge/db';
import type { AppContext } from '../context';
import { notFound } from '../errors';
import { authenticate } from '../plugins/auth';
import { describeDevice, revokeSessions, sessionPolicy, sessionProblem } from '../services/sessions';
import type { App } from '../types';
import { WEB_CLIENT_ID } from '../oidc/provider';

const { and, desc, eq, inArray, isNull } = orm;

/** Active sessions of a person, newest activity first, ready for display. */
export async function listSessions(db: AppContext['db'], userId: string, currentId?: string) {
  const rows = await db.select().from(userSessions).where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt))).orderBy(desc(userSessions.lastSeenAt));
  const live = rows.filter((r) => !sessionProblem(r));
  const clientIds = [...new Set(live.flatMap((r) => r.clients))];
  const apps = clientIds.length ? await db.select({ clientId: oauthApps.clientId, name: oauthApps.name }).from(oauthApps).where(inArray(oauthApps.clientId, clientIds)) : [];
  const appName = (c: string) => (c === WEB_CLIENT_ID ? 'ForgeOffice' : (apps.find((a) => a.clientId === c)?.name ?? c));
  const p = sessionPolicy();
  return live.map((r: UserSession) => ({
    id: r.id,
    current: r.id === currentId,
    ...describeDevice(r.userAgent),
    ip: r.ip,
    signedInAt: r.loginAt.toISOString(),
    lastActiveAt: r.lastSeenAt.toISOString(),
    /** When this session must sign in again (the earlier of the two timeouts). */
    expiresAt: new Date(Math.min(r.loginAt.getTime() + p.maxSeconds * 1000, p.idleSeconds ? r.lastSeenAt.getTime() + p.idleSeconds * 1000 : Infinity)).toISOString(),
    apps: r.clients.map(appName),
  }));
}

/** Account → Security: where you're signed in, and signing devices out. */
export function sessionRoutes(app: App, ctx: AppContext) {
  const { db } = ctx;
  app.addHook('preHandler', authenticate(ctx));

  app.get('/api/v1/me/sessions', { schema: { tags: ['me'], summary: 'Browsers and devices you are signed in on' } }, async (req) => ({
    items: await listSessions(db, req.principal!.user.id, req.principal!.sessionId),
    policy: sessionPolicy(),
  }));

  app.delete('/api/v1/me/sessions/:id', { schema: { tags: ['me'], summary: 'Sign out a browser or device', params: Type.Object({ id: Type.String({ maxLength: 200 }) }) } }, async (req) => {
    const me = req.principal!.user;
    const n = await revokeSessions(db, me.id, { ids: [req.params.id] });
    if (!n) throw notFound('Session');
    await ctx.audit.fromRequest(req, { action: 'auth.session_revoked', targetType: 'user', targetId: me.id, targetLabel: me.email, metadata: { sessions: 1, current: req.params.id === req.principal!.sessionId } });
    return { ok: true, current: req.params.id === req.principal!.sessionId };
  });

  app.post(
    '/api/v1/me/sessions/revoke',
    { schema: { tags: ['me'], summary: 'Sign out of all other devices, or everywhere', body: Type.Object({ includeThisDevice: Type.Boolean({ default: false }) }) } },
    async (req) => {
      const me = req.principal!.user;
      const n = await revokeSessions(db, me.id, { except: req.body.includeThisDevice ? null : (req.principal!.sessionId ?? null) });
      await ctx.audit.fromRequest(req, { action: 'auth.sessions_revoked', targetType: 'user', targetId: me.id, targetLabel: me.email, metadata: { sessions: n, includeThisDevice: req.body.includeThisDevice } });
      return { signedOut: n };
    },
  );
}
