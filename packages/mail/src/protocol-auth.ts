import { burnPasswordCheck, verifyPassword } from '@forge/auth';
import { appPasswords, auditLog, domains, orm, organizations, users, type User } from '@forge/db';
import type { MailContext } from './context';

const { and, eq } = orm;

export type Protocol = 'imap' | 'smtp' | 'caldav' | 'carddav';

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;

/**
 * Authenticate a mail/DAV client. App passwords always work; the account
 * password is accepted only when the user has no MFA requirement, because
 * these protocols cannot prompt for a second factor.
 */
export async function authenticateProtocol(
  ctx: Pick<MailContext, 'db'>,
  login: string,
  password: string,
  meta: { protocol: Protocol; ip?: string | null },
): Promise<User | null> {
  let email = login.trim().toLowerCase();
  if (!email.includes('@')) {
    const [primary] = await ctx.db.select({ name: domains.name }).from(domains).where(eq(domains.isPrimary, true)).limit(1);
    if (primary) email = `${email}@${primary.name}`;
  }
  const audit = (user: User | null, outcome: 'success' | 'failure', reason?: string) =>
    ctx.db.insert(auditLog).values({
      action: 'auth.protocol_login',
      outcome,
      orgId: user?.orgId ?? null,
      actorId: user?.id ?? null,
      actorLabel: user?.email ?? email,
      ip: meta.ip ?? null,
      userAgent: meta.protocol.toUpperCase(),
      metadata: { protocol: meta.protocol, ...(reason ? { reason } : {}) },
    });

  const [user] = await ctx.db.select().from(users).where(eq(users.email, email)).limit(1);
  // Shared mailboxes have no credentials of their own; members use their own login.
  if (!user || user.status !== 'active' || user.kind === 'shared') {
    await burnPasswordCheck(password);
    await audit(user ?? null, 'failure', user ? user.status : 'unknown_user');
    return null;
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await audit(user, 'failure', 'locked');
    return null;
  }

  const candidates = await ctx.db.select().from(appPasswords).where(eq(appPasswords.userId, user.id));
  const compact = password.replace(/[\s-]/g, '');
  for (const ap of candidates) {
    if (await verifyPassword(ap.passwordHash, compact)) {
      await ctx.db.update(appPasswords).set({ lastUsedAt: new Date(), lastUsedIp: meta.ip ?? null }).where(eq(appPasswords.id, ap.id));
      await ctx.db.update(users).set({ failedLoginCount: 0 }).where(eq(users.id, user.id));
      await audit(user, 'success');
      return user;
    }
  }

  const [org] = await ctx.db.select({ requireMfa: organizations.requireMfa }).from(organizations).where(eq(organizations.id, user.orgId)).limit(1);
  const mfaInPlay = !!user.totpEnabledAt || user.mfaRequired || !!org?.requireMfa;
  if (!mfaInPlay && (await verifyPassword(user.passwordHash, password))) {
    await ctx.db.update(users).set({ failedLoginCount: 0 }).where(eq(users.id, user.id));
    await audit(user, 'success');
    return user;
  }

  const failures = user.failedLoginCount + 1;
  const lock = failures >= MAX_FAILURES;
  await ctx.db
    .update(users)
    .set({ failedLoginCount: lock ? 0 : failures, lockedUntil: lock ? new Date(Date.now() + LOCK_MS) : user.lockedUntil })
    .where(and(eq(users.id, user.id)));
  await audit(user, 'failure', mfaInPlay ? 'app_password_required' : 'bad_password');
  return null;
}
