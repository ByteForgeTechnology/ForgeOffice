import Provider, { type Configuration, type KoaContextWithOIDC } from 'oidc-provider';
import { orm, users } from '@forge/db';
import type { AppContext } from '../context';
import type { OidcClientConfig } from '../config';
import { getPrimaryOrg, userRoleKeys } from '../services/directory';
import { createOidcAdapter } from './adapter';
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
    adapter: createOidcAdapter(db) as unknown as Configuration['adapter'],
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
      forge: ['org_id', 'roles'],
    },
    scopes: ['openid', 'offline_access', 'email', 'profile', 'forge'],
    // Put profile claims in the ID token: access tokens are audience-bound to
    // the API, so SPAs cannot use them at the userinfo endpoint.
    conformIdTokenClaims: false,
    pkce: { required: () => true },
    clientBasedCORS: (_ctx, origin, client) => client.redirectUris?.some((u) => new URL(u).origin === origin) ?? false,
    async findAccount(_ctx, sub) {
      const [user] = await db.select().from(users).where(eq(users.id, sub)).limit(1);
      if (!user || user.status !== 'active' || user.kind === 'shared') return undefined;
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
        defaultResource: () => config.apiAudience,
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, resource) => {
          if (resource !== config.apiAudience) throw new Error('unknown resource');
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
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    ttl: {
      AccessToken: 15 * 60,
      AuthorizationCode: 60,
      IdToken: 60 * 60,
      Interaction: 60 * 60,
      Session: 14 * 24 * 3600,
      Grant: 14 * 24 * 3600,
      RefreshToken: 14 * 24 * 3600,
    },
    rotateRefreshToken: true,
  };

  const provider = new Provider(config.issuer, configuration);
  provider.proxy = config.trustProxy;
  provider.on('server_error', (_ctx: unknown, err: unknown) => log.error({ err }, 'oidc server_error'));

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
