import { Type } from 'typebox';
import {
  checkPasswordPolicy,
  createTotpSecret,
  decryptString,
  encryptString,
  generateRecoveryCodes,
  hashPassword,
  totpQrDataUrl,
  totpUri,
  verifyPassword,
  verifyTotp,
} from '@forge/auth';
import { groupMembers, groups, orm, users } from '@forge/db';
import type { AppContext } from '../context';
import { HttpError, badRequest, conflict } from '../errors';
import { authenticate } from '../plugins/auth';
import { effectiveQuota, getPrimaryOrg, serializeOrg, serializeUser } from '../services/directory';
import type { App } from '../types';
import { TIMEZONES } from './public';

const { eq } = orm;

const SETUP_TTL_MS = 10 * 60_000;

export function meRoutes(app: App, ctx: AppContext) {
  const { db } = ctx;
  app.addHook('preHandler', authenticate(ctx));

  const requirePassword = async (userId: string, hash: string, password: string) => {
    if (!(await verifyPassword(hash, password))) throw new HttpError(403, 'Your current password is incorrect', 'invalid_password');
    void userId;
  };

  app.get('/api/v1/me', { schema: { tags: ['me'], summary: 'The signed-in user, their organisation and permissions' } }, async (req) => {
    const p = req.principal!;
    const org = await getPrimaryOrg(db);
    const memberOf = await db
      .select({ id: groups.id, name: groups.name, type: groups.type })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .where(eq(groupMembers.userId, p.user.id));
    return {
      user: serializeUser(p.user, { roles: p.roleKeys }),
      org: org ? serializeOrg(org) : null,
      permissions: [...p.permissions].sort(),
      groups: memberOf,
      storage: { usedBytes: p.user.usedBytes, quotaBytes: org ? effectiveQuota(p.user, org) : null },
      mfaRequired: p.user.mfaRequired || !!org?.requireMfa,
    };
  });

  app.patch(
    '/api/v1/me',
    {
      schema: {
        tags: ['me'],
        summary: 'Update your own profile',
        body: Type.Object({
          displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
          timezone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
      },
    },
    async (req) => {
      const p = req.principal!;
      const { displayName, timezone } = req.body;
      if (timezone && !TIMEZONES.has(timezone)) throw badRequest('Unknown timezone');
      const [user] = await db
        .update(users)
        .set({ ...(displayName ? { displayName: displayName.trim() } : {}), ...(timezone !== undefined ? { timezone } : {}) })
        .where(eq(users.id, p.user.id))
        .returning();
      await ctx.audit.fromRequest(req, { action: 'user.profile_updated', targetType: 'user', targetId: p.user.id, targetLabel: p.user.email, metadata: { fields: Object.keys(req.body) } });
      return { user: serializeUser(user!, { roles: p.roleKeys }) };
    },
  );

  app.post(
    '/api/v1/me/password',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['me'],
        summary: 'Change your password',
        body: Type.Object({ currentPassword: Type.String({ minLength: 1, maxLength: 1024 }), newPassword: Type.String({ minLength: 1, maxLength: 256 }) }),
      },
    },
    async (req) => {
      const u = req.principal!.user;
      await requirePassword(u.id, u.passwordHash, req.body.currentPassword);
      const problems = checkPasswordPolicy(req.body.newPassword, undefined, [u.username, u.givenName ?? '', u.familyName ?? '']);
      if (problems.length) throw badRequest('Password does not meet the policy', { password: problems });
      if (req.body.newPassword === req.body.currentPassword) throw badRequest('Choose a password different from your current one');
      await db
        .update(users)
        .set({ passwordHash: await hashPassword(req.body.newPassword), mustChangePassword: false, passwordChangedAt: new Date() })
        .where(eq(users.id, u.id));
      await ctx.audit.fromRequest(req, { action: 'auth.password_changed', targetType: 'user', targetId: u.id, targetLabel: u.email });
      return { ok: true };
    },
  );

  app.get('/api/v1/me/mfa', { schema: { tags: ['me'], summary: 'Your MFA status' } }, async (req) => {
    const u = req.principal!.user;
    const org = await getPrimaryOrg(db);
    return {
      totpEnabled: !!u.totpEnabledAt,
      totpEnabledAt: u.totpEnabledAt?.toISOString() ?? null,
      required: u.mfaRequired || !!org?.requireMfa,
      recoveryCodesRemaining: u.recoveryCodes.length,
    };
  });

  app.post('/api/v1/me/mfa/totp/setup', { schema: { tags: ['me'], summary: 'Start TOTP enrolment' } }, async (req) => {
    const u = req.principal!.user;
    if (u.totpEnabledAt) throw conflict('An authenticator app is already registered. Remove it first.');
    const org = await getPrimaryOrg(db);
    const secret = createTotpSecret();
    const uri = totpUri({ secret, issuer: org?.name ?? 'ForgeOffice', label: u.email });
    // Stateless enrolment: the pending secret travels back to the client encrypted and bound to this user.
    const enrollmentToken = encryptString(ctx.keys.totpKey, JSON.stringify({ uid: u.id, secret, exp: Date.now() + SETUP_TTL_MS }));
    return { secret, uri, qr: await totpQrDataUrl(uri), enrollmentToken };
  });

  app.post(
    '/api/v1/me/mfa/totp/enable',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['me'],
        summary: 'Confirm TOTP enrolment with a code from the authenticator app',
        body: Type.Object({ enrollmentToken: Type.String({ minLength: 1, maxLength: 1024 }), code: Type.String({ minLength: 6, maxLength: 12 }) }),
      },
    },
    async (req) => {
      const u = req.principal!.user;
      let pending: { uid: string; secret: string; exp: number };
      try {
        pending = JSON.parse(decryptString(ctx.keys.totpKey, req.body.enrollmentToken));
      } catch {
        throw badRequest('Enrolment has expired. Start again.');
      }
      if (pending.uid !== u.id || pending.exp < Date.now()) throw badRequest('Enrolment has expired. Start again.');
      const check = await verifyTotp(pending.secret, req.body.code);
      if (!check.valid) throw new HttpError(400, 'That code is not valid. Check the time on your device and try again.', 'invalid_code');
      const { codes, hashes } = generateRecoveryCodes();
      await db
        .update(users)
        .set({ totpSecretEnc: encryptString(ctx.keys.totpKey, pending.secret), totpEnabledAt: new Date(), totpLastStep: check.timeStep ?? null, recoveryCodes: hashes })
        .where(eq(users.id, u.id));
      await ctx.audit.fromRequest(req, { action: 'mfa.enrolled', targetType: 'user', targetId: u.id, targetLabel: u.email });
      return { recoveryCodes: codes };
    },
  );

  app.post(
    '/api/v1/me/mfa/totp/disable',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { tags: ['me'], summary: 'Remove your authenticator app', body: Type.Object({ password: Type.String({ minLength: 1, maxLength: 1024 }) }) },
    },
    async (req) => {
      const u = req.principal!.user;
      await requirePassword(u.id, u.passwordHash, req.body.password);
      const org = await getPrimaryOrg(db);
      if (u.mfaRequired || org?.requireMfa) throw conflict('Your organisation requires multi-factor authentication.');
      await db.update(users).set({ totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null, recoveryCodes: [] }).where(eq(users.id, u.id));
      await ctx.audit.fromRequest(req, { action: 'mfa.disabled', targetType: 'user', targetId: u.id, targetLabel: u.email });
      return { ok: true };
    },
  );

  app.post(
    '/api/v1/me/mfa/recovery-codes',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { tags: ['me'], summary: 'Regenerate recovery codes', body: Type.Object({ password: Type.String({ minLength: 1, maxLength: 1024 }) }) },
    },
    async (req) => {
      const u = req.principal!.user;
      await requirePassword(u.id, u.passwordHash, req.body.password);
      if (!u.totpEnabledAt) throw conflict('Set up an authenticator app first.');
      const { codes, hashes } = generateRecoveryCodes();
      await db.update(users).set({ recoveryCodes: hashes }).where(eq(users.id, u.id));
      await ctx.audit.fromRequest(req, { action: 'mfa.recovery_codes_regenerated', targetType: 'user', targetId: u.id, targetLabel: u.email });
      return { recoveryCodes: codes };
    },
  );
}
