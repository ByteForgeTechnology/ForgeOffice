import type { FastifyReply, FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import type Provider from 'oidc-provider';
import type { InteractionResults } from 'oidc-provider';
import {
  burnPasswordCheck,
  checkPasswordPolicy,
  consumeRecoveryCode,
  createTotpSecret,
  decryptString,
  encryptString,
  generateRecoveryCodes,
  hashPassword,
  passwordNeedsRehash,
  totpQrDataUrl,
  totpUri,
  verifyPassword,
  verifyTotp,
} from '@forge/auth';
import { domains, orm, users, type User } from '@forge/db';
import type { AppContext } from '../context';
import { HttpError, badRequest } from '../errors';
import { getPrimaryOrg } from '../services/directory';
import type { App } from '../types';
import { API_SCOPE, type ForgeProvider } from './provider';

const { and, eq } = orm;

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

type Stage = 'mfa' | 'mfa_enroll' | 'change_password';

/** Partial sign-in state persisted on the oidc-provider Interaction between steps. */
interface PendingLogin {
  accountId: string;
  stage: Stage;
  amr: string[];
  enrollSecretEnc?: string;
  mfaVerified?: boolean;
}

type Interaction = Awaited<ReturnType<Provider['interactionDetails']>>;

const Params = Type.Object({ uid: Type.String({ minLength: 1, maxLength: 128 }) });

function pending(interaction: Interaction): PendingLogin | undefined {
  return (interaction.result as { forge?: PendingLogin } | undefined)?.forge;
}

async function savePending(interaction: Interaction, state: PendingLogin | undefined): Promise<void> {
  interaction.result = state ? { forge: state } : {};
  const ttl = Math.max(1, interaction.exp - Math.floor(Date.now() / 1000));
  await interaction.save(ttl);
}

function stageError(message = 'This sign-in step is not available. Please start again.') {
  return new HttpError(409, message, 'invalid_stage');
}

export function interactionRoutes(app: App, ctx: AppContext, forge: ForgeProvider, serveSpa: (reply: FastifyReply) => unknown) {
  const { provider, firstPartyClients } = forge;
  const { db, config } = ctx;

  const loadInteraction = async (req: FastifyRequest, reply: FastifyReply, uid: string) => {
    let details: Interaction;
    try {
      details = await provider.interactionDetails(req.raw, reply.raw);
    } catch {
      throw new HttpError(410, 'This sign-in request has expired. Please start again.', 'interaction_expired');
    }
    if (details.uid !== uid) throw new HttpError(410, 'This sign-in request has expired. Please start again.', 'interaction_expired');
    return details;
  };

  const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers['user-agent'] ?? null });

  /** Build a grant for a trusted first-party client covering everything it asked for. */
  const grantConsent = async (details: Interaction, accountId: string): Promise<string> => {
    const clientId = String(details.params.client_id);
    const grant = details.grantId
      ? ((await provider.Grant.find(details.grantId)) ?? new provider.Grant({ accountId, clientId }))
      : new provider.Grant({ accountId, clientId });
    const requested = String(details.params.scope ?? 'openid')
      .split(' ')
      .filter(Boolean);
    grant.addOIDCScope(requested.filter((s) => s !== API_SCOPE).join(' '));
    grant.addResourceScope(config.apiAudience, API_SCOPE);
    const promptDetails = details.prompt.details as { missingOIDCClaims?: string[] };
    if (promptDetails.missingOIDCClaims?.length) grant.addOIDCClaims(promptDetails.missingOIDCClaims);
    return grant.save();
  };

  const complete = async (req: FastifyRequest, reply: FastifyReply, details: Interaction, user: User, amr: string[]) => {
    await db.update(users).set({ lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, user.id));
    await ctx.audit.record({
      action: 'auth.login',
      orgId: user.orgId,
      actorId: user.id,
      actorLabel: user.email,
      metadata: { amr, client: details.params.client_id },
      ...meta(req),
    });
    const result: InteractionResults = {
      login: { accountId: user.id, amr, acr: amr.includes('mfa') ? 'urn:forge:mfa' : 'urn:forge:pwd', remember: true },
    };
    if (firstPartyClients.has(String(details.params.client_id))) {
      result.consent = { grantId: await grantConsent(details, user.id) };
    }
    const redirectTo = await provider.interactionResult(req.raw, reply.raw, result, { mergeWithLastSubmission: false });
    return { done: true as const, redirectTo };
  };

  /** Decide the next step after a factor succeeds, or finish. */
  const advance = async (req: FastifyRequest, reply: FastifyReply, details: Interaction, user: User, state: PendingLogin) => {
    const org = await getPrimaryOrg(db);
    if (!user.totpEnabledAt && (user.mfaRequired || org?.requireMfa)) {
      const secret = createTotpSecret();
      await savePending(details, { ...state, stage: 'mfa_enroll', enrollSecretEnc: encryptString(ctx.keys.totpKey, secret) });
      const uri = totpUri({ secret, issuer: org?.name ?? 'ForgeOffice', label: user.email });
      return { done: false as const, next: 'mfa_enroll' as const, enrollment: { secret, uri, qr: await totpQrDataUrl(uri) } };
    }
    if (user.mustChangePassword) {
      await savePending(details, { ...state, stage: 'change_password' });
      return { done: false as const, next: 'change_password' as const };
    }
    return complete(req, reply, details, user, state.amr);
  };

  const loadPendingUser = async (details: Interaction, stage: Stage) => {
    const state = pending(details);
    if (!state || state.stage !== stage) throw stageError();
    const [user] = await db.select().from(users).where(eq(users.id, state.accountId)).limit(1);
    if (!user || user.status !== 'active') throw stageError('This account is not active.');
    return { state, user };
  };

  // -------------------------------------------------------------------------
  // Browser navigation target. Trusted clients asking only for consent are
  // granted immediately; everything else renders the SPA sign-in screen.
  // -------------------------------------------------------------------------
  app.get('/interaction/:uid', { schema: { params: Params, hide: true } }, async (req, reply) => {
    let details: Interaction;
    try {
      details = await provider.interactionDetails(req.raw, reply.raw);
    } catch {
      return serveSpa(reply);
    }
    const accountId = details.session?.accountId;
    if (details.prompt.name === 'consent' && accountId && firstPartyClients.has(String(details.params.client_id))) {
      const grantId = await grantConsent(details, accountId);
      const redirectTo = await provider.interactionResult(req.raw, reply.raw, { consent: { grantId } }, { mergeWithLastSubmission: true });
      return reply.redirect(redirectTo, 303);
    }
    return serveSpa(reply);
  });

  app.get('/interaction/:uid/details', { schema: { params: Params, hide: true } }, async (req, reply) => {
    const details = await loadInteraction(req, reply, req.params.uid);
    const client = await provider.Client.find(String(details.params.client_id));
    const state = pending(details);
    let email: string | undefined;
    if (state) {
      const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, state.accountId)).limit(1);
      email = u?.email;
    }
    return {
      uid: details.uid,
      prompt: details.prompt.name,
      stage: state?.stage ?? (details.prompt.name === 'consent' ? 'consent' : 'password'),
      email,
      loginHint: typeof details.params.login_hint === 'string' ? details.params.login_hint : undefined,
      client: { id: client?.clientId, name: client?.clientName ?? client?.clientId, firstParty: firstPartyClients.has(String(details.params.client_id)) },
      scopes: String(details.params.scope ?? '').split(' ').filter(Boolean),
    };
  });

  const rateLimit = { max: 20, timeWindow: '1 minute' };

  app.post(
    '/interaction/:uid/login',
    {
      config: { rateLimit },
      schema: {
        hide: true,
        params: Params,
        body: Type.Object({ email: Type.String({ minLength: 1, maxLength: 320 }), password: Type.String({ minLength: 1, maxLength: 1024 }) }),
      },
    },
    async (req, reply) => {
      const details = await loadInteraction(req, reply, req.params.uid);
      if (details.prompt.name !== 'login') throw stageError();
      const org = await getPrimaryOrg(db);
      let login = req.body.email.trim().toLowerCase();
      if (!login.includes('@') && org) {
        // Allow bare usernames on the primary domain.
        const [primary] = await db
          .select({ name: domains.name })
          .from(domains)
          .where(and(eq(domains.orgId, org.id), eq(domains.isPrimary, true)))
          .limit(1);
        if (primary) login = `${login}@${primary.name}`;
      }
      const genericFailure = new HttpError(401, 'Incorrect email address or password.', 'invalid_credentials');

      const [user] = await db.select().from(users).where(eq(users.email, login)).limit(1);
      // Shared mailboxes cannot sign in; treat them like unknown accounts.
      if (!user || user.status === 'deleted' || user.kind === 'shared') {
        await burnPasswordCheck(req.body.password);
        await ctx.audit.record({ action: 'auth.login', outcome: 'failure', orgId: org?.id, actorLabel: login, metadata: { reason: 'unknown_user' }, ...meta(req) });
        throw genericFailure;
      }
      const base = { orgId: user.orgId, actorId: user.id, actorLabel: user.email, ...meta(req) };

      if (user.lockedUntil && user.lockedUntil > new Date()) {
        await burnPasswordCheck(req.body.password);
        await ctx.audit.record({ ...base, action: 'auth.login', outcome: 'failure', metadata: { reason: 'locked' } });
        throw new HttpError(423, 'Too many failed attempts. Try again in a few minutes.', 'locked');
      }

      if (!(await verifyPassword(user.passwordHash, req.body.password))) {
        const failures = user.failedLoginCount + 1;
        const lock = failures >= MAX_FAILED_LOGINS;
        await db
          .update(users)
          .set({ failedLoginCount: lock ? 0 : failures, lockedUntil: lock ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : user.lockedUntil })
          .where(eq(users.id, user.id));
        await ctx.audit.record({ ...base, action: lock ? 'auth.lockout' : 'auth.login', outcome: 'failure', metadata: { reason: 'bad_password', failures } });
        throw genericFailure;
      }

      if (user.status !== 'active') {
        await ctx.audit.record({ ...base, action: 'auth.login', outcome: 'failure', metadata: { reason: user.status } });
        throw new HttpError(403, 'This account has been suspended. Contact your administrator.', 'suspended');
      }

      if (passwordNeedsRehash(user.passwordHash)) {
        await db.update(users).set({ passwordHash: await hashPassword(req.body.password) }).where(eq(users.id, user.id));
      }
      await db.update(users).set({ failedLoginCount: 0 }).where(eq(users.id, user.id));

      const state: PendingLogin = { accountId: user.id, stage: 'mfa', amr: ['pwd'] };
      if (user.totpEnabledAt) {
        await savePending(details, state);
        return { done: false, next: 'mfa' };
      }
      return advance(req, reply, details, user, state);
    },
  );

  app.post(
    '/interaction/:uid/mfa',
    {
      config: { rateLimit },
      schema: { hide: true, params: Params, body: Type.Object({ code: Type.String({ minLength: 6, maxLength: 32 }) }) },
    },
    async (req, reply) => {
      const details = await loadInteraction(req, reply, req.params.uid);
      const { state, user } = await loadPendingUser(details, 'mfa');
      const base = { orgId: user.orgId, actorId: user.id, actorLabel: user.email, ...meta(req) };
      const code = req.body.code.trim();
      let method: 'otp' | 'recovery' | null = null;

      if (/^\d{6}$/.test(code.replace(/\s/g, '')) && user.totpSecretEnc) {
        const secret = decryptString(ctx.keys.totpKey, user.totpSecretEnc);
        const check = await verifyTotp(secret, code, user.totpLastStep);
        if (check.valid) {
          method = 'otp';
          await db.update(users).set({ totpLastStep: check.timeStep ?? null }).where(eq(users.id, user.id));
        }
      } else {
        const remaining = consumeRecoveryCode(user.recoveryCodes, code);
        if (remaining) {
          method = 'recovery';
          await db.update(users).set({ recoveryCodes: remaining }).where(eq(users.id, user.id));
          await ctx.audit.record({ ...base, action: 'auth.recovery_code_used', metadata: { remaining: remaining.length } });
        }
      }

      if (!method) {
        await ctx.audit.record({ ...base, action: 'auth.mfa', outcome: 'failure' });
        throw new HttpError(401, 'That code is not valid. Try again.', 'invalid_code');
      }
      const next: PendingLogin = { ...state, mfaVerified: true, amr: ['pwd', method === 'otp' ? 'otp' : 'kba', 'mfa'] };
      return advance(req, reply, details, { ...user }, next);
    },
  );

  app.post(
    '/interaction/:uid/mfa/enroll',
    {
      config: { rateLimit },
      schema: { hide: true, params: Params, body: Type.Object({ code: Type.String({ minLength: 6, maxLength: 12 }) }) },
    },
    async (req, reply) => {
      const details = await loadInteraction(req, reply, req.params.uid);
      const { state, user } = await loadPendingUser(details, 'mfa_enroll');
      if (!state.enrollSecretEnc) throw stageError();
      const secret = decryptString(ctx.keys.totpKey, state.enrollSecretEnc);
      const check = await verifyTotp(secret, req.body.code);
      if (!check.valid) throw new HttpError(401, 'That code is not valid. Check the time on your device and try again.', 'invalid_code');
      const { codes, hashes } = generateRecoveryCodes();
      await db
        .update(users)
        .set({ totpSecretEnc: state.enrollSecretEnc, totpEnabledAt: new Date(), totpLastStep: check.timeStep ?? null, recoveryCodes: hashes })
        .where(eq(users.id, user.id));
      await ctx.audit.record({ orgId: user.orgId, actorId: user.id, actorLabel: user.email, action: 'mfa.enrolled', ...meta(req) });
      const enrolledUser = { ...user, totpEnabledAt: new Date() };
      const result = await advance(req, reply, details, enrolledUser, { ...state, enrollSecretEnc: undefined, amr: ['pwd', 'otp', 'mfa'] });
      return { ...result, recoveryCodes: codes };
    },
  );

  app.post(
    '/interaction/:uid/password',
    {
      config: { rateLimit },
      schema: { hide: true, params: Params, body: Type.Object({ newPassword: Type.String({ minLength: 1, maxLength: 256 }) }) },
    },
    async (req, reply) => {
      const details = await loadInteraction(req, reply, req.params.uid);
      const { state, user } = await loadPendingUser(details, 'change_password');
      const problems = checkPasswordPolicy(req.body.newPassword, undefined, [user.username, user.givenName ?? '', user.familyName ?? '']);
      if (problems.length) throw badRequest('Password does not meet the policy', { password: problems });
      if (await verifyPassword(user.passwordHash, req.body.newPassword)) throw badRequest('Choose a password different from your current one');
      await db
        .update(users)
        .set({ passwordHash: await hashPassword(req.body.newPassword), mustChangePassword: false, passwordChangedAt: new Date() })
        .where(eq(users.id, user.id));
      await ctx.audit.record({ orgId: user.orgId, actorId: user.id, actorLabel: user.email, action: 'auth.password_changed', ...meta(req) });
      return complete(req, reply, details, { ...user, mustChangePassword: false }, state.amr);
    },
  );

  /** Explicit consent for non-first-party clients. */
  app.post(
    '/interaction/:uid/consent',
    { schema: { hide: true, params: Params, body: Type.Object({ approve: Type.Boolean() }) } },
    async (req, reply) => {
      const details = await loadInteraction(req, reply, req.params.uid);
      const accountId = details.session?.accountId;
      if (details.prompt.name !== 'consent' || !accountId) throw stageError();
      if (!req.body.approve) {
        const redirectTo = await provider.interactionResult(req.raw, reply.raw, { error: 'access_denied', error_description: 'The user declined access' });
        return { done: true, redirectTo };
      }
      const grantId = await grantConsent(details, accountId);
      const redirectTo = await provider.interactionResult(req.raw, reply.raw, { consent: { grantId } }, { mergeWithLastSubmission: true });
      return { done: true, redirectTo };
    },
  );

  app.post('/interaction/:uid/abort', { schema: { hide: true, params: Params } }, async (req, reply) => {
    await loadInteraction(req, reply, req.params.uid);
    const redirectTo = await provider.interactionResult(
      req.raw,
      reply.raw,
      { error: 'access_denied', error_description: 'Sign-in was cancelled' },
      { mergeWithLastSubmission: false },
    );
    return { done: true, redirectTo };
  });
}
