import { oidcPayloads, orm, organizations, userSessions, type Database, type UserSession } from '@forge/db';

const { and, asc, eq, inArray, isNull, ne, sql } = orm;

export interface SessionPolicy {
  /** Sign in again after this long (seconds). */
  maxSeconds: number;
  /** Sign out after this long without activity (seconds), or null. */
  idleSeconds: number | null;
}

const DEFAULT_POLICY: SessionPolicy = { maxSeconds: 14 * 24 * 3600, idleSeconds: null };
let policy: SessionPolicy = DEFAULT_POLICY;

/**
 * The organisation's session timeouts, cached in memory: oidc-provider asks
 * for token lifetimes synchronously. Refreshed every minute (other replicas)
 * and immediately when an admin saves.
 */
export const sessionPolicy = () => policy;

export function applySessionPolicy(o: { sessionMaxHours: number; sessionIdleMinutes: number | null }) {
  policy = { maxSeconds: o.sessionMaxHours * 3600, idleSeconds: o.sessionIdleMinutes ? o.sessionIdleMinutes * 60 : null };
}

export async function loadSessionPolicy(db: Database) {
  const [o] = await db.select({ sessionMaxHours: organizations.sessionMaxHours, sessionIdleMinutes: organizations.sessionIdleMinutes }).from(organizations).orderBy(asc(organizations.createdAt)).limit(1);
  if (o) applySessionPolicy(o);
  return policy;
}

export function startSessionPolicyRefresh(db: Database, log: { warn: (o: unknown, m?: string) => void }) {
  const timer = setInterval(() => void loadSessionPolicy(db).catch((err) => log.warn({ err }, 'could not refresh session policy')), 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

/** Why a session can no longer be used, or null if it is fine. */
export function sessionProblem(row: Pick<UserSession, 'loginAt' | 'lastSeenAt' | 'revokedAt'>, now = Date.now()): 'revoked' | 'expired' | 'idle' | null {
  const p = sessionPolicy();
  if (row.revokedAt) return 'revoked';
  if (now - row.loginAt.getTime() > p.maxSeconds * 1000) return 'expired';
  if (p.idleSeconds && now - row.lastSeenAt.getTime() > p.idleSeconds * 1000) return 'idle';
  return null;
}

/** Seconds left before a session started at `loginTs` (epoch seconds) must sign in again. */
export function remainingSeconds(loginTs: number | undefined, now = Math.floor(Date.now() / 1000)) {
  return Math.max(60, sessionPolicy().maxSeconds - (now - (loginTs ?? now)));
}

export async function findSession(db: Database, id: string) {
  const [row] = await db.select().from(userSessions).where(eq(userSessions.id, id)).limit(1);
  return row ?? null;
}

/** Note activity, at most once a minute per session. */
export async function touchSession(db: Database, row: UserSession) {
  if (Date.now() - row.lastSeenAt.getTime() < 60_000) return;
  await db.update(userSessions).set({ lastSeenAt: new Date() }).where(eq(userSessions.id, row.id));
}

/** Record a sign-in (or a new app used) in a browser/device session. */
export async function recordSessionUse(db: Database, s: { id: string; userId: string; loginTs: number; ip: string | null; userAgent: string | null; clientId: string }) {
  const loginAt = new Date(s.loginTs * 1000);
  const existing = await findSession(db, s.id);
  if (!existing) {
    await db
      .insert(userSessions)
      .values({ id: s.id, userId: s.userId, loginAt, lastSeenAt: new Date(), ip: s.ip, userAgent: s.userAgent, clients: [s.clientId] })
      .onConflictDoNothing();
    return;
  }
  // Signing in again in the same browser starts a fresh session.
  const freshLogin = loginAt.getTime() > existing.loginAt.getTime();
  await db
    .update(userSessions)
    .set({
      lastSeenAt: new Date(),
      ip: s.ip ?? existing.ip,
      userAgent: s.userAgent ?? existing.userAgent,
      clients: [...new Set([...existing.clients, s.clientId])],
      ...(freshLogin ? { loginAt, revokedAt: null, userId: s.userId } : {}),
    })
    .where(eq(userSessions.id, s.id));
}

/**
 * Sign sessions out: mark them revoked (so access tokens already issued stop
 * working at the API) and delete the identity-provider session and every
 * token issued in it. Returns the number of sessions signed out.
 */
export async function revokeSessions(db: Database, userId: string, opts: { ids?: string[]; except?: string | null } = {}): Promise<number> {
  const rows = await db
    .select({ id: userSessions.id })
    .from(userSessions)
    .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt), opts.ids ? inArray(userSessions.id, opts.ids.length ? opts.ids : ['-']) : undefined, opts.except ? ne(userSessions.id, opts.except) : undefined));
  const ids = rows.map((r) => r.id);
  if (!ids.length) return 0;
  await db.update(userSessions).set({ revokedAt: new Date() }).where(inArray(userSessions.id, ids));
  await db.delete(oidcPayloads).where(and(eq(oidcPayloads.type, 'Session'), inArray(oidcPayloads.uid, ids)));
  await db.delete(oidcPayloads).where(sql`${oidcPayloads.payload}->>'sessionUid' in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
  return ids.length;
}

/** "Chrome on Windows" from a User-Agent string. */
export function describeDevice(ua: string | null): { browser: string; os: string; mobile: boolean } {
  const s = ua ?? '';
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : s ? 'App' : 'Unknown browser';
  const os = /iPhone|iPad/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /Windows/.test(s) ? 'Windows' : /CrOS/.test(s) ? 'ChromeOS' : /Linux/.test(s) ? 'Linux' : 'Unknown system';
  return { browser, os, mobile: /Mobile|iPhone|Android/.test(s) };
}
