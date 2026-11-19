import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, signIn, startServer } from './harness';

let server: Awaited<ReturnType<typeof startServer>>;
const tokens: Record<string, string> = {};

const login = (email: string, password: string) => async ({ uid, client }: { uid: string; client: Client }) => client.post(`/interaction/${uid}/login`, { email, password });
async function call(method: string, path: string, who: string, body?: unknown) {
  const res = await fetch(server.baseUrl + path, {
    method,
    headers: { authorization: `Bearer ${tokens[who]}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
}

const REDIRECT = 'https://wiki.example.com/oauth/callback';

/**
 * Play a registered app: start an authorization request in a browser
 * (cookie jar), answer the sign-in/consent steps, and return where the
 * browser ends up at the app's redirect URI.
 */
async function authorize(browser: Client, clientId: string, opts: { scope?: string; pkce?: boolean; prompt?: string; steps: (uid: string, details: any) => Promise<any> }) {
  const verifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT,
    scope: opts.scope ?? 'openid profile email',
    state: 'xyz',
    nonce: 'n1',
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
    ...(opts.pkce ? { code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' } : {}),
  });
  let res = await browser.get(`/oidc/auth?${params}`);
  for (let hops = 0; hops < 15; hops++) {
    if (res.status === 200 && res.json?.redirectTo) {
      res = await browser.get(res.json.redirectTo);
      continue;
    }
    if (res.status === 403 && res.json?.error) return { error: res.json, verifier };
    if (res.status < 300 || res.status >= 400) throw new Error(`unexpected ${res.status}: ${res.text.slice(0, 300)}`);
    const location = new URL(res.headers.get('location')!, server.baseUrl).toString();
    if (location.startsWith(REDIRECT)) return { callback: new URL(location), verifier };
    const m = /\/interaction\/([^/?]+)$/.exec(new URL(location).pathname);
    if (m) {
      const page = await browser.get(location);
      if (page.status >= 300 && page.status < 400) {
        res = page;
        continue;
      }
      const details = (await browser.get(`/interaction/${m[1]}/details`)).json;
      res = await opts.steps(m[1]!, details);
      continue;
    }
    res = await browser.get(location);
  }
  throw new Error('too many redirects');
}

async function exchange(clientId: string, secret: string | null, code: string, verifier?: string) {
  const res = await fetch(`${server.baseUrl}/oidc/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(secret ? { authorization: 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64') } : {}) },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, ...(secret ? {} : { client_id: clientId }), ...(verifier ? { code_verifier: verifier } : {}) }),
  });
  return { status: res.status, json: (await res.json()) as any };
}

beforeAll(async () => {
  server = await startServer({ FORGE_MAIL_DISABLE_AUTH_CHECKS: 'true' });
  const c = new Client(server.baseUrl);
  await c.post('/api/v1/setup', {
    setupToken: 'test-setup-token',
    organization: { name: 'Acme', timezone: 'UTC', defaultQuotaBytes: 1024 ** 3, requireMfa: false },
    domain: 'acme.test',
    admin: { username: 'admin', displayName: 'Ada Admin', password: 'correct horse battery staple' },
  });
  tokens.admin = (await signIn(c, login('admin', 'correct horse battery staple'))).tokens.access_token;
  for (const [username, displayName, password] of [
    ['dev', 'Dev Person', 'violet tangerine 77'],
    ['eve', 'Eve Outsider', 'orange marmalade 88'],
  ]) await c.post('/api/v1/admin/users', { username, displayName, password, mustChangePassword: false }, tokens.admin);
  await call('PATCH', `/api/v1/admin/users/${(await call('GET', '/api/v1/admin/users?q=dev', 'admin')).json.items[0].id}`, 'admin', { workPhone: '+44 20 7946 0000' });
}, 120_000);

afterAll(async () => {
  await server?.close();
});

describe('registered OAuth apps', () => {
  let appId: string;
  let clientId: string;
  let secret: string;
  let groupId: string;

  it('admins register apps; URIs and scopes are validated', async () => {
    const bad = (body: object) => call('POST', '/api/v1/admin/apps', 'admin', { name: 'x', type: 'confidential', redirectUris: [REDIRECT], ...body });
    expect((await bad({ redirectUris: ['http://wiki.example.com/cb'] })).status).toBe(400);
    expect((await bad({ redirectUris: ['https://*.example.com/cb'] })).status).toBe(400);
    expect((await bad({ redirectUris: ['javascript:alert(1)'] })).status).toBe(400);
    expect((await bad({ scopes: ['openid', 'api'] })).status).toBe(400);
    expect((await bad({ redirectUris: ['http://localhost:3000/cb', 'com.example.wiki:/cb'] })).status).toBe(201);

    const r = await call('POST', '/api/v1/admin/apps', 'admin', { name: 'Team Wiki', description: 'Our knowledge base', homepageUrl: 'https://wiki.example.com', type: 'confidential', redirectUris: [REDIRECT], scopes: ['openid', 'profile', 'email', 'phone', 'groups', 'offline_access'] });
    expect(r.status, r.text).toBe(201);
    expect(r.json.clientSecret).toMatch(/^[\w-]{40,}$/);
    expect(r.json.app).not.toHaveProperty('secretEnc');
    ({ id: appId, clientId } = r.json.app);
    secret = r.json.clientSecret;
    expect((await call('GET', `/api/v1/admin/apps/${appId}`, 'admin')).json.app).toMatchObject({ clientId, hasSecret: true, secretHint: secret.slice(-4) });

    const disco = (await (await fetch(`${server.baseUrl}/oidc/.well-known/openid-configuration`)).json()) as any;
    expect(disco.scopes_supported).toEqual(expect.arrayContaining(['openid', 'profile', 'email', 'phone', 'groups', 'offline_access']));
    expect((await call('GET', '/api/v1/admin/apps/endpoints', 'admin')).json.token).toBe(disco.token_endpoint);
  });

  it('people consent, then the app gets an ID token, userinfo and refresh tokens, but no access to ForgeOffice', async () => {
    const browser = new Client(server.baseUrl);
    let consentScreen: any;
    const out = await authorize(browser, clientId, {
      scope: 'openid profile email phone groups offline_access',
      // Refresh tokens (offline_access) need prompt=consent, as OpenID Connect specifies.
      prompt: 'consent',
      steps: async (uid, details) => {
        if (details.prompt === 'login') return browser.post(`/interaction/${uid}/login`, { email: 'dev', password: 'violet tangerine 77' });
        consentScreen = details;
        return browser.post(`/interaction/${uid}/consent`, { approve: true });
      },
    });
    expect(consentScreen.client).toMatchObject({ name: 'Team Wiki', firstParty: false, homepage: 'https://wiki.example.com/' });
    expect(consentScreen.permissions.map((p: { scope: string }) => p.scope)).toEqual(['openid', 'profile', 'email', 'phone', 'groups', 'offline_access']);
    expect(out.callback!.searchParams.get('state')).toBe('xyz');

    // Wrong secret, then the right one.
    expect((await exchange(clientId, 'wrong', out.callback!.searchParams.get('code')!)).status).toBe(401);
    const t = await exchange(clientId, secret, out.callback!.searchParams.get('code')!);
    expect(t.status, JSON.stringify(t.json)).toBe(200);
    expect(t.json.refresh_token).toBeTruthy();
    const idClaims = JSON.parse(Buffer.from(t.json.id_token.split('.')[1], 'base64url').toString());
    expect(idClaims).toMatchObject({ aud: clientId, nonce: 'n1', email: 'dev@acme.test' });
    expect(idClaims).not.toHaveProperty('roles');

    const info = (await (await fetch(`${server.baseUrl}/oidc/me`, { headers: { authorization: `Bearer ${t.json.access_token}` } })).json()) as any;
    expect(info).toMatchObject({ email: 'dev@acme.test', name: 'Dev Person', phone_number: '+44 20 7946 0000', groups: [] });

    // Its access token is not accepted by the ForgeOffice API.
    expect((await fetch(`${server.baseUrl}/api/v1/me`, { headers: { authorization: `Bearer ${t.json.access_token}` } })).status).toBe(401);

    const refreshed = await fetch(`${server.baseUrl}/oidc/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64') },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.json.refresh_token }),
    });
    expect(refreshed.status).toBe(200);

    // The second sign-in skips consent (already given) and the password (signed in).
    const again = await authorize(browser, clientId, { steps: async () => { throw new Error('should not ask again'); } });
    expect(again.callback!.searchParams.get('code')).toBeTruthy();

    // It shows under Account → Connected apps, where it can be removed.
    tokens.dev = (await signIn(new Client(server.baseUrl), login('dev', 'violet tangerine 77'))).tokens.access_token;
    const connected = (await call('GET', '/api/v1/me/apps', 'dev')).json.items;
    expect(connected).toEqual([expect.objectContaining({ clientId, name: 'Team Wiki', permissions: expect.arrayContaining([expect.objectContaining({ scope: 'email' })]) })]);
    await call('DELETE', `/api/v1/me/apps/${clientId}`, 'dev');
    expect((await call('GET', '/api/v1/me/apps', 'dev')).json.items).toEqual([]);
    const afterRevoke = await fetch(`${server.baseUrl}/oidc/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64') },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: ((await refreshed.json()) as any).refresh_token }),
    });
    expect(afterRevoke.status).toBe(400);
  });

  it('can be limited to groups and pre-approved by an admin', async () => {
    const g = await call('POST', '/api/v1/admin/groups', 'admin', { name: 'Wiki editors', type: 'security' });
    groupId = g.json.group.id;
    const devId = (await call('GET', '/api/v1/admin/users?q=dev', 'admin')).json.items[0].id;
    await call('POST', `/api/v1/admin/groups/${groupId}/members`, 'admin', { userIds: [devId] });
    const put = await call('PUT', `/api/v1/admin/apps/${appId}`, 'admin', { name: 'Team Wiki', redirectUris: [REDIRECT], scopes: ['openid', 'profile', 'email', 'groups'], access: 'groups', groupIds: [groupId], consent: 'admin' });
    expect(put.status, put.text).toBe(200);

    // Eve is not in the group: refused with a clear message.
    const eve = new Client(server.baseUrl);
    const refused = await authorize(eve, clientId, { steps: async (uid) => eve.post(`/interaction/${uid}/login`, { email: 'eve', password: 'orange marmalade 88' }) });
    expect(refused.error).toMatchObject({ error: 'app_not_assigned' });
    expect(refused.error.message).toMatch(/don't have access to Team Wiki/);

    // Dev is: no consent screen (approved by the admin), and groups are included.
    const dev = new Client(server.baseUrl);
    const ok = await authorize(dev, clientId, { scope: 'openid email groups', steps: async (uid, d) => {
      if (d.prompt !== 'login') throw new Error('consent should be skipped');
      return dev.post(`/interaction/${uid}/login`, { email: 'dev', password: 'violet tangerine 77' });
    } });
    const t = await exchange(clientId, secret, ok.callback!.searchParams.get('code')!);
    const info = (await (await fetch(`${server.baseUrl}/oidc/me`, { headers: { authorization: `Bearer ${t.json.access_token}` } })).json()) as any;
    expect(info.groups).toEqual(['Wiki editors']);

    // Taken out of the group: the token stops working at once.
    await call('DELETE', `/api/v1/admin/groups/${groupId}/members/${devId}`, 'admin');
    expect((await fetch(`${server.baseUrl}/oidc/me`, { headers: { authorization: `Bearer ${t.json.access_token}` } })).status).toBe(401);

    const audit = await call('GET', '/api/v1/admin/audit?action=auth.app_sign_in', 'admin');
    expect(audit.json.items.some((i: { outcome: string }) => i.outcome === 'failure')).toBe(true);
    expect(audit.json.items.some((i: { outcome: string }) => i.outcome === 'success')).toBe(true);
  });

  it('public apps use PKCE without a secret; secrets rotate; disabled apps are unknown', async () => {
    const pub = await call('POST', '/api/v1/admin/apps', 'admin', { name: 'Wiki mobile', type: 'public', redirectUris: [REDIRECT] });
    expect(pub.json.clientSecret).toBeNull();
    const browser = new Client(server.baseUrl);
    const noPkce = await authorize(browser, pub.json.app.clientId, { steps: async () => { throw new Error('unreachable'); } });
    expect(noPkce.callback!.searchParams.get('error')).toBe('invalid_request');
    const out = await authorize(browser, pub.json.app.clientId, {
      pkce: true,
      steps: async (uid, d) => (d.prompt === 'login' ? browser.post(`/interaction/${uid}/login`, { email: 'eve', password: 'orange marmalade 88' }) : browser.post(`/interaction/${uid}/consent`, { approve: true })),
    });
    expect((await exchange(pub.json.app.clientId, null, out.callback!.searchParams.get('code')!, out.verifier)).status).toBe(200);

    const rotated = await call('POST', `/api/v1/admin/apps/${appId}/secret`, 'admin');
    expect(rotated.json.clientSecret).not.toBe(secret);
    expect((await call('POST', `/api/v1/admin/apps/${pub.json.app.id}/secret`, 'admin')).status).toBe(400);

    await call('PUT', `/api/v1/admin/apps/${pub.json.app.id}`, 'admin', { name: 'Wiki mobile', redirectUris: [REDIRECT], enabled: false });
    const off = await new Client(server.baseUrl).get(`/oidc/auth?client_id=${pub.json.app.clientId}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=openid`);
    expect(off.status).toBe(400);
    expect(off.text).toContain('invalid_client');

    // Only organisation admins manage apps.
    const me = await call('GET', '/api/v1/me', 'dev');
    expect(me.status, me.text).toBe(200);
    expect((await call('POST', '/api/v1/admin/apps', 'dev', { name: 'x', type: 'public', redirectUris: [REDIRECT] })).status).toBe(403);
    const logged = await call('GET', '/api/v1/admin/audit?action=oauth.app_secret_rotated', 'admin');
    expect(logged.json.items).toHaveLength(1);
  });
});
