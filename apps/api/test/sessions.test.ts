import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orm, userSessions } from '@forge/db';
import { Client, signIn, startServer } from './harness';

const { eq } = orm;
let server: Awaited<ReturnType<typeof startServer>>;
let admin: string;

const login = (email: string, password: string) => async ({ uid, client }: { uid: string; client: Client }) => client.post(`/interaction/${uid}/login`, { email, password });
const PW = 'violet tangerine 77';

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(server.baseUrl + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
}
const refresh = (refreshToken: string) =>
  fetch(`${server.baseUrl}/oidc/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: 'forge-web' }),
  });

/** A "device": its own browser cookies and tokens. */
async function device(email = 'helen') {
  const browser = new Client(server.baseUrl);
  const { tokens } = await signIn(browser, login(email, PW));
  return { browser, tokens };
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
  admin = (await signIn(c, login('admin', 'correct horse battery staple'))).tokens.access_token;
  await c.post('/api/v1/admin/users', { username: 'helen', displayName: 'Helen', password: PW, mustChangePassword: false }, admin);
}, 120_000);

afterAll(async () => {
  await server?.close();
});

describe('signed-in devices', () => {
  it('lists each browser/device and marks this one', async () => {
    const laptop = await device();
    const phone = await device();
    const list = await call('GET', '/api/v1/me/sessions', laptop.tokens.access_token);
    expect(list.json.items).toHaveLength(2);
    expect(list.json.items.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(list.json.items[0]).toMatchObject({ apps: ['ForgeOffice'], browser: expect.any(String), os: expect.any(String) });

    // Sign the phone out from the laptop: its access token stops working at once, and it can't refresh.
    const phoneId = list.json.items.find((s: { current: boolean }) => !s.current).id;
    expect((await call('GET', '/api/v1/me', phone.tokens.access_token)).status).toBe(200);
    expect((await call('DELETE', `/api/v1/me/sessions/${phoneId}`, laptop.tokens.access_token)).status).toBe(200);
    const blocked = await call('GET', '/api/v1/me', phone.tokens.access_token);
    expect(blocked.status).toBe(401);
    expect(blocked.json.message).toMatch(/signed out/);
    expect((await refresh(phone.tokens.refresh_token!)).status).toBe(400);
    expect((await call('GET', '/api/v1/me', laptop.tokens.access_token)).status).toBe(200);

    // The phone has to enter the password again (its browser session is gone).
    let asked = false;
    await signIn(phone.browser, async (s) => {
      asked = true;
      return login('helen', PW)(s);
    });
    expect(asked).toBe(true);
  });

  it('signs out of all other devices, or everywhere', async () => {
    const a = await device();
    const b = await device();
    const c = await device();
    const others = await call('POST', '/api/v1/me/sessions/revoke', a.tokens.access_token, { includeThisDevice: false });
    expect(others.json.signedOut).toBeGreaterThanOrEqual(2);
    expect((await call('GET', '/api/v1/me', b.tokens.access_token)).status).toBe(401);
    expect((await call('GET', '/api/v1/me', c.tokens.access_token)).status).toBe(401);
    expect((await call('GET', '/api/v1/me/sessions', a.tokens.access_token)).json.items).toHaveLength(1);
    await call('POST', '/api/v1/me/sessions/revoke', a.tokens.access_token, { includeThisDevice: true });
    expect((await call('GET', '/api/v1/me', a.tokens.access_token)).status).toBe(401);
  });

  it('admins can see and end a user’s sessions', async () => {
    const d = await device();
    const helenId = (await call('GET', '/api/v1/me', d.tokens.access_token)).json.user.id;
    expect((await call('GET', `/api/v1/admin/users/${helenId}/sessions`, admin)).json.items).toHaveLength(1);
    expect((await call('POST', `/api/v1/admin/users/${helenId}/sessions/revoke`, admin)).json.signedOut).toBe(1);
    expect((await call('GET', '/api/v1/me', d.tokens.access_token)).status).toBe(401);
    expect((await call('POST', `/api/v1/admin/users/${helenId}/sessions/revoke`, d.tokens.access_token)).status).toBe(401);
  });
});

describe('session timeouts', () => {
  it('are validated and returned with the organisation', async () => {
    expect((await call('PATCH', '/api/v1/admin/org', admin, { sessionMaxHours: 0 })).status).toBe(400);
    expect((await call('PATCH', '/api/v1/admin/org', admin, { sessionMaxHours: 8, sessionIdleMinutes: 24 * 60 })).status).toBe(400);
    const ok = await call('PATCH', '/api/v1/admin/org', admin, { sessionMaxHours: 24, sessionIdleMinutes: 60 });
    expect(ok.json.org).toMatchObject({ sessionMaxHours: 24, sessionIdleMinutes: 60 });
  });

  it('idle sessions must sign in again, and refresh tokens follow the timeouts', async () => {
    const d = await device();
    const sessions = (await call('GET', '/api/v1/me/sessions', d.tokens.access_token)).json;
    expect(sessions.policy).toEqual({ maxSeconds: 24 * 3600, idleSeconds: 3600 });
    const id = sessions.items[0].id;
    // The new refresh token lives no longer than the inactivity timeout.
    const r = await refresh(d.tokens.refresh_token!);
    expect(r.status).toBe(200);
    const rotated = (await r.json()) as { refresh_token: string; access_token: string };

    // Two hours without activity.
    await server.ctx.db.update(userSessions).set({ lastSeenAt: new Date(Date.now() - 2 * 3600_000) }).where(eq(userSessions.id, id));
    const idle = await call('GET', '/api/v1/me', rotated.access_token);
    expect(idle.status).toBe(401);
    expect(idle.json.message).toMatch(/inactivity/);
    expect((await refresh(rotated.refresh_token)).status).toBe(400);
    let asked = false;
    await signIn(d.browser, async (s) => {
      asked = true;
      return login('helen', PW)(s);
    });
    expect(asked).toBe(true);
  });

  it('sessions older than the maximum must sign in again', async () => {
    const d = await device();
    const id = (await call('GET', '/api/v1/me/sessions', d.tokens.access_token)).json.items.find((s: { current: boolean }) => s.current).id;
    await server.ctx.db.update(userSessions).set({ loginAt: new Date(Date.now() - 25 * 3600_000) }).where(eq(userSessions.id, id));
    expect((await call('GET', '/api/v1/me', d.tokens.access_token)).json.message).toMatch(/session has ended/);
    expect((await refresh(d.tokens.refresh_token!)).status).toBe(400);
    await call('PATCH', '/api/v1/admin/org', admin, { sessionMaxHours: 336, sessionIdleMinutes: null });
  });
});
