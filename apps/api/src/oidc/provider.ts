import Provider, { interactionPolicy, type Configuration, type KoaContextWithOIDC } from 'oidc-provider';
import { groupMembers, groups, oauthApps, orm, users } from '@forge/db';
import type { AppContext } from '../context';
import type { OidcClientConfig } from '../config';
import { getPrimaryOrg, userRoleKeys } from '../services/directory';
import { createOidcAdapter } from './adapter';
import { canUseApp, clientMetadata } from '../services/oauth-apps';
import { findSession, recordSessionUse, remainingSeconds, sessionPolicy, sessionProblem, touchSession } from '../services/sessions';
import { escapeHtml, newNonce, renderPage } from './pages';

const { eq } = orm;

export const WEB_CLIENT_ID = 'forge-web';
export const API_SCOPE = 'api';

export interface ForgeProvider {
  provider: Provider;
  /** Client IDs that are trusted ForgeOffice apps and skip consent. */
  firstPartyClients: Set<string>;
}

function webClient(publicUrl: string): OidcClientConfig {
  return {
    client_id: WEB_CLIENT_ID,
    client_name: 'ForgeOffice',
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    redirect_uris: [`${publicUrl}/auth/callback`],
    post_logout_redirect_uris: [`${publicUrl}/`, `${publicUrl}/signed-out`],
    'forge:first_party': true,
  };
}

export function createProvider(ctx: AppContext, log: { error: (o: unknown, m?: string) => void }): ForgeProvider {
  const { config, db } = ctx;
  const allClients = [webClient(config.publicUrl), ...config.extraClients];
  const firstPartyClients = new Set(allClients.filter((c) => c['forge:first_party']).map((c) => c.client_id));
  const clients = allClients.map(({ 'forge:first_party': _fp, ...c }) => ({
    response_types: ['code'],
    grant_types: ['authorization_code', 'refresh_token'],
    ...c,
  }));

  const brandColor = async () => (await getPrimaryOrg(db))?.brandColor;

  const configuration: Configuration = {
    adapter: createOidcAdapter(db, {
      // Applications registered in the admin center (disabled ones are unknown clients).
      findClient: async (clientId) => {
        const [app] = await db.select().from(oauthApps).where(eq(oauthApps.clientId, clientId)).limit(1);
        return app?.enabled ? clientMetadata(app, ctx.keys.oauthSecretKey) : undefined;
      },
    }) as unknown as Configuration['adapter'],
    clients: clients as Configuration['clients'],
    jwks: ctx.signing.privateJwks as Configuration['jwks'],
    cookies: { keys: ctx.keys.cookieKeys },
    claims: {
      // Standard claims oidc-provider includes by default (must be kept when overriding).
      acr: null,
      amr: null,
      auth_time: null,
      iss: null,
      sid: null,
      openid: ['sub', 'acr', 'amr', 'auth_time', 'sid'],
      email: ['email', 'email_verified'],
      profile: ['name', 'given_name', 'family_name', 'preferred_username', 'zoneinfo', 'locale', 'updated_at'],
      phone: ['phone_number', 'phone_number_verified'],
      groups: ['groups'],
      forge: ['org_id', 'roles'],
    },
    scopes: ['openid', 'offline_access', 'email', 'profile', 'phone', 'groups', 'forge'],
    // Put profile claims in the ID token: access tokens are audience-bound to
    // the API, so SPAs cannot use them at the userinfo endpoint.
    conformIdTokenClaims: false,
    // PKCE is required for apps without a secret (SPAs, mobile); optional for server-side apps.
    pkce: { required: (_ctx, client) => client.tokenEndpointAuthMethod === 'none' },
    clientBasedCORS: (_ctx, origin, client) => client.redirectUris?.some((u) => new URL(u).origin === origin) ?? false,
    async findAccount(kctx, sub, token) {
      const [user] = await db.select().from(users).where(eq(users.id, sub)).limit(1);
      if (!user || user.status !== 'active' || user.kind === 'shared') return undefined;
      // Tokens from a session that was signed out, timed out or idle are refused (token refresh, userinfo).
      const sessionUid = (token as { sessionUid?: string } | undefined)?.sessionUid;
      if (sessionUid) {
        const row = await findSession(db, sessionUid);
        if (row && row.userId === user.id) {
          if (sessionProblem(row)) return undefined;
          await touchSession(db, row);
        }
      }
      // Registered apps: checked on every sign-in, token refresh and userinfo call, so taking
      // someone's access away (or switching the app off) takes effect straight away.
      const clientId = kctx?.oidc?.client?.clientId;
      if (clientId && !firstPartyClients.has(clientId)) {
        const [app] = await db.select().from(oauthApps).where(eq(oauthApps.clientId, clientId)).limit(1);
        if (!app || !(await canUseApp(db, app, user.id))) return undefined;
      }
      return {
        accountId: user.id,
        async claims() {
          const org = await getPrimaryOrg(db);
          return {
            sub: user.id,
            email: user.email,
            email_verified: true,
            name: user.displayName,
            given_name: user.givenName ?? undefined,
            family_name: user.familyName ?? undefined,
            preferred_username: user.email,
            zoneinfo: user.timezone ?? org?.timezone,
            locale: org?.locale,
            updated_at: Math.floor(user.updatedAt.getTime() / 1000),
            phone_number: user.workPhone ?? user.mobilePhone ?? undefined,
            phone_number_verified: user.workPhone || user.mobilePhone ? false : undefined,
            groups: (await db.select({ name: groups.name }).from(groupMembers).innerJoin(groups, eq(groups.id, groupMembers.groupId)).where(eq(groupMembers.userId, user.id))).map((g) => g.name).sort(),
            org_id: user.orgId,
            roles: await userRoleKeys(db, user.id),
          };
        },
      };
    },
    features: {
      devInteractions: { enabled: false },
      revocation: { enabled: true },
      introspection: { enabled: true },
      resourceIndicators: {
        enabled: true,
        // Only ForgeOffice's own apps get tokens for its API. Registered apps get
        // tokens for sign-in and the userinfo endpoint only.
        defaultResource: (_ctx, client) => (client && firstPartyClients.has(client.clientId) ? config.apiAudience : undefined),
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, resource, client) => {
          if (resource !== config.apiAudience || !firstPartyClients.has(client.clientId)) throw new Error('unknown resource');
          return {
            scope: API_SCOPE,
            audience: config.apiAudience,
            accessTokenTTL: 15 * 60,
            accessTokenFormat: 'jwt',
            jwt: { sign: { alg: 'ES256' } },
          };
        },
      },
      rpInitiatedLogout: {
        enabled: true,
        async logoutSource(kctx: KoaContextWithOIDC, form: string) {
          // Sign-out is always user-initiated from a ForgeOffice app, so the
          // confirmation form submits itself (CSRF-protected by the provider's xsrf field).
          const nonce = newNonce();
          const { html, csp } = renderPage({
            title: 'Signing out',
            brandColor: await brandColor(),
            nonce,
            body: `<h1>Signing you out…</h1><p>One moment.</p>${form}
              <input type="hidden" form="op.logoutForm" name="logout" value="yes">
              <noscript><button type="submit" form="op.logoutForm">Continue</button></noscript>
              <script nonce="${nonce}">document.getElementById('op.logoutForm').submit()</script>`,
          });
          kctx.set('Content-Security-Policy', csp);
          kctx.type = 'html';
          kctx.body = html;
        },
        async postLogoutSuccessSource(kctx: KoaContextWithOIDC) {
          const { html, csp } = renderPage({
            title: 'Signed out',
            brandColor: await brandColor(),
            body: `<h1>You have signed out</h1><p>You can close this window or sign in again.</p><a class="btn" href="/">Sign in</a>`,
          });
          kctx.set('Content-Security-Policy', csp);
          kctx.type = 'html';
          kctx.body = html;
        },
      },
    },
    async renderError(kctx, out, error) {
      log.error({ err: error, out }, 'oidc error page rendered');
      const { html, csp } = renderPage({
        title: 'Sign-in problem',
        brandColor: await brandColor(),
        body: `<h1>Something went wrong</h1><p>${escapeHtml(out.error_description ?? 'The sign-in request could not be completed.')}</p>
          <pre>${escapeHtml(out.error)}</pre><a class="btn" href="/">Back to ForgeOffice</a>`,
      });
      kctx.set('Content-Security-Policy', csp);
      kctx.type = 'html';
      kctx.body = html;
    },
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}`, policy: signInPolicy(db) },
    // The web app's access tokens name their session, so signing a device out stops them at the API at once.
    extraTokenClaims: (_ctx, token) => {
      const sid = (token as { sessionUid?: string }).sessionUid;
      return sid ? { sid } : undefined;
    },
    ttl: {
      AccessToken: 15 * 60,
      AuthorizationCode: 60,
      IdToken: 60 * 60,
      Interaction: 60 * 60,
      // Session timeouts (Admin → ForgeDirectory → Sign-in & security).
      Session: (_ctx, session) => remainingSeconds(session.loginTs),
      Grant: () => sessionPolicy().maxSeconds,
      RefreshToken: (_ctx, token) => {
        const p = sessionPolicy();
        const left = remainingSeconds((token as { iiat?: number }).iiat);
        return p.idleSeconds ? Math.max(60, Math.min(left, p.idleSeconds)) : left;
      },
    },
    rotateRefreshToken: true,
  };

  const provider = new Provider(config.issuer, configuration);
  provider.proxy = config.trustProxy;
  provider.on('server_error', (_ctx: unknown, err: unknown) => log.error({ err }, 'oidc server_error'));

  // Sign-ins to registered apps: audit them and record when each app was last used.
  provider.on('authorization.success', (kctx: KoaContextWithOIDC) => {
    const clientId = kctx.oidc.client?.clientId;
    const session = kctx.oidc.session;
    const accountId = session?.accountId;
    // Every browser/device session, for "where you're signed in" and session timeouts.
    if (clientId && accountId && session?.uid)
      void recordSessionUse(db, { id: session.uid, userId: accountId, loginTs: session.loginTs ?? Math.floor(Date.now() / 1000), ip: kctx.ip ?? null, userAgent: kctx.get('user-agent') || null, clientId }).catch((err) => log.error({ err }, 'could not record session'));
    if (!clientId || firstPartyClients.has(clientId) || !accountId) return;
    void (async () => {
      const [app] = await db.update(oauthApps).set({ lastUsedAt: new Date() }).where(eq(oauthApps.clientId, clientId)).returning({ name: oauthApps.name });
      const [u] = await db.select({ email: users.email, orgId: users.orgId }).from(users).where(eq(users.id, accountId));
      await ctx.audit.record({ action: 'auth.app_sign_in', orgId: u?.orgId, actorId: accountId, actorLabel: u?.email, metadata: { client: clientId, app: app?.name }, ip: kctx.ip, userAgent: kctx.get('user-agent') });
    })().catch((err) => log.error({ err }, 'could not record app sign-in'));
  });

  provider.on('end_session.success', (kctx: KoaContextWithOIDC) => {
    const accountId = kctx.oidc.session?.accountId;
    if (!accountId) return;
    void db
      .select({ email: users.email, orgId: users.orgId })
      .from(users)
      .where(eq(users.id, accountId))
      .then(([u]) =>
        ctx.audit.record({
          action: 'auth.logout',
          orgId: u?.orgId,
          actorId: accountId,
          actorLabel: u?.email,
          ip: kctx.ip,
          userAgent: kctx.get('user-agent'),
        }),
      );
  });

  return { provider, firstPartyClients };
}

/**
 * Sign-in policy: the standard checks, plus ForgeOffice's session rules. A
 * browser session that was signed out, has passed the maximum session length,
 * or has been idle too long must sign in again (password and second factor).
 */
function signInPolicy(db: AppContext['db']) {
  const policy = interactionPolicy.base();
  policy.get('login')!.checks.add(
    new interactionPolicy.Check('forge_session', 'Session timed out or was signed out', async (kctx) => {
      const session = kctx.oidc.session;
      if (!session?.accountId || !session.uid) return interactionPolicy.Check.NO_NEED_TO_PROMPT;
      const row = await findSession(db, session.uid);
      // Having just signed in (this interaction), or a sign-in newer than the
      // record, starts afresh. loginTs has one-second resolution, so the
      // interaction result is what tells a quick re-sign-in apart.
      const freshLogin = !!kctx.oidc.result?.login || (!!session.loginTs && !!row && session.loginTs * 1000 > row.loginAt.getTime());
      if (row && !freshLogin && row.userId === session.accountId && sessionProblem(row)) return interactionPolicy.Check.REQUEST_PROMPT;
      if (session.loginTs && Date.now() / 1000 - session.loginTs > sessionPolicy().maxSeconds) return interactionPolicy.Check.REQUEST_PROMPT;
      return interactionPolicy.Check.NO_NEED_TO_PROMPT;
    }),
  );
  return policy;
}
