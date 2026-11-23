import { decodeJwt } from 'jose';
import { generateTotp } from '@forge/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, signIn, startServer } from './harness';

const ADMIN_PASSWORD = 'correct horse battery staple';

let server: Awaited<ReturnType<typeof startServer>>;
let adminToken: string;

/** Answer the password step, then any MFA/password-change steps the server asks for. */
function passwordSteps(email: string, password: string, extra: { totpSecret?: () => string | undefined; newPassword?: string; onEnroll?: (e: any) => void } = {}) {
  return async ({ uid, response, client }: { uid: string; response: any; client: Client }) => {
    const r = response.json;
    if (r?.stage === 'password') return client.post(`/interaction/${uid}/login`, { email, password });
    if (r?.next === 'mfa' || r?.stage === 'mfa') return client.post(`/interaction/${uid}/mfa`, { code: await generateTotp(extra.totpSecret!()!) });
    if (r?.next === 'mfa_enroll') {
      extra.onEnroll?.(r.enrollment);
      return client.post(`/interaction/${uid}/mfa/enroll`, { code: await generateTotp(r.enrollment.secret) });
    }
    if (r?.next === 'change_password') return client.post(`/interaction/${uid}/password`, { newPassword: extra.newPassword });
    throw new Error(`unexpected step: ${JSON.stringify(r)}`);
  };
}

beforeAll(async () => {
  server = await startServer();
}, 60_000);

afterAll(async () => {
  await server?.close();
});

describe('first-run setup', () => {
  it('reports that setup is needed', async () => {
    const c = new Client(server.baseUrl);
    const res = await c.get('/api/v1/setup/status');
    expect(res.status).toBe(200);
    expect(res.json.needsSetup).toBe(true);
  });

  const setupBody = (token: string) => ({
    setupToken: token,
    organization: { name: 'Acme Ltd', timezone: 'Europe/London', defaultQuotaBytes: 10 * 1024 ** 3, requireMfa: false, brandColor: '#0f766e' },
    domain: 'Acme.Example',
    admin: { username: 'Admin', displayName: 'Ada Admin', password: ADMIN_PASSWORD },
  });

  it('rejects a wrong setup token', async () => {
    const res = await new Client(server.baseUrl).post('/api/v1/setup', setupBody('nope'));
    expect(res.status).toBe(403);
  });

  it('creates the organisation, domain and admin', async () => {
    const res = await new Client(server.baseUrl).post('/api/v1/setup', setupBody('test-setup-token'));
    expect(res.status, res.text).toBe(200);
    expect(res.json.adminEmail).toBe('admin@acme.example');
  });

  it('cannot be run twice', async () => {
    const res = await new Client(server.baseUrl).post('/api/v1/setup', setupBody('test-setup-token'));
    expect(res.status).toBe(409);
    const branding = await new Client(server.baseUrl).get('/api/v1/branding');
    expect(branding.json).toMatchObject({ needsSetup: false, name: 'Acme Ltd', brandColor: '#0f766e' });
  });
});

describe('OIDC sign-in', () => {
  it('rejects a wrong password with a generic error', async () => {
    const c = new Client(server.baseUrl);
    await expect(signIn(c, passwordSteps('admin@acme.example', 'wrong password!!'))).rejects.toThrow(/401/);
  });

  it('signs in with a bare username and issues API-scoped JWT access + refresh tokens', async () => {
    const c = new Client(server.baseUrl);
    const { tokens } = await signIn(c, passwordSteps('admin', ADMIN_PASSWORD));
    expect(tokens.refresh_token).toBeTruthy();
    const at = decodeJwt(tokens.access_token);
    expect(at.aud).toBe(`${server.baseUrl}/api`);
    expect(at.iss).toBe(`${server.baseUrl}/oidc`);
    const id = decodeJwt(tokens.id_token);
    expect(id.email).toBe('admin@acme.example');
    expect(id.roles).toEqual(['global_admin']);
    adminToken = tokens.access_token;

    const me = await c.get('/api/v1/me', adminToken);
    expect(me.status).toBe(200);
    expect(me.json.user.email).toBe('admin@acme.example');
    expect(me.json.permissions).toContain('system:manage');

    const refreshed = await c.request('POST', '/oidc/token', {
      form: { grant_type: 'refresh_token', refresh_token: tokens.refresh_token!, client_id: 'forge-web' },
    });
    expect(refreshed.status, refreshed.text).toBe(200);
    expect(refreshed.json.access_token).toBeTruthy();
  });

  it('re-uses the provider session for a second authorization (auto-consent)', async () => {
    const c = new Client(server.baseUrl);
    await signIn(c, passwordSteps('admin@acme.example', ADMIN_PASSWORD));
    const { stepResponses } = await signIn(c, async () => {
      throw new Error('should not prompt again');
    });
    expect(stepResponses).toHaveLength(0);
  });

  it('rejects requests without a valid token', async () => {
    const c = new Client(server.baseUrl);
    expect((await c.get('/api/v1/me')).status).toBe(401);
    expect((await c.get('/api/v1/me', 'not.a.jwt')).status).toBe(401);
  });
});

describe('user lifecycle, MFA enforcement and RBAC', () => {
  let bobId: string;
  let bobTemp: string;
  let bobSecret: string | undefined;
  let bobToken: string;

  it('creates a user with a temporary password and enforced MFA', async () => {
    const c = new Client(server.baseUrl);
    const res = await c.post('/api/v1/admin/users', { username: 'bob', displayName: 'Bob Builder', mfaRequired: true, roles: ['helpdesk'] }, adminToken);
    expect(res.status, res.text).toBe(201);
    expect(res.json.user.email).toBe('bob@acme.example');
    expect(res.json.user.mustChangePassword).toBe(true);
    expect(res.json.temporaryPassword).toMatch(/^\w{4}-\w{4}-\w{4}-\w{4}$/);
    bobId = res.json.user.id;
    bobTemp = res.json.temporaryPassword;
  });

  it('rejects duplicate addresses', async () => {
    const res = await new Client(server.baseUrl).post('/api/v1/admin/users', { username: 'BOB', displayName: 'Bob 2' }, adminToken);
    expect(res.status).toBe(409);
  });

  it('forces TOTP enrolment then a password change at first sign-in', async () => {
    const c = new Client(server.baseUrl);
    const { tokens, stepResponses } = await signIn(
      c,
      passwordSteps('bob@acme.example', bobTemp, { newPassword: 'a brand new passphrase', onEnroll: (e) => (bobSecret = e.secret) }),
    );
    expect(stepResponses[0]).toMatchObject({ done: false, next: 'mfa_enroll' });
    expect(stepResponses[1].recoveryCodes).toHaveLength(10);
    expect(stepResponses[1].next).toBe('change_password');
    expect(decodeJwt(tokens.id_token).amr).toEqual(['pwd', 'otp', 'mfa']);
    bobToken = tokens.access_token;
    const me = await c.get('/api/v1/me', bobToken);
    expect(me.json.user).toMatchObject({ mfaEnabled: true, mustChangePassword: false });
  });

  it('asks for a TOTP code on later sign-ins and blocks replayed codes', async () => {
    // Wait for the next 30 s window so the enrolment code is not replayed.
    await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 200));
    const c = new Client(server.baseUrl);
    const { stepResponses } = await signIn(c, passwordSteps('bob@acme.example', 'a brand new passphrase', { totpSecret: () => bobSecret }));
    expect(stepResponses[0]).toMatchObject({ next: 'mfa' });
    expect(stepResponses[1].done).toBe(true);

    const c2 = new Client(server.baseUrl);
    await expect(
      signIn(c2, passwordSteps('bob@acme.example', 'a brand new passphrase', { totpSecret: () => bobSecret })),
    ).rejects.toThrow(/401.*not valid/);
  }, 45_000);

  it('denies helpdesk users admin-only actions and audits the denial', async () => {
    const c = new Client(server.baseUrl);
    const users = await c.get('/api/v1/admin/users', bobToken);
    expect(users.status).toBe(200);
    const admin = users.json.items.find((u: any) => u.email === 'admin@acme.example');
    const reset = await c.post(`/api/v1/admin/users/${admin.id}/reset-password`, {}, bobToken);
    expect(reset.status).toBe(403);
    expect((await c.post('/api/v1/admin/groups', { name: 'x', type: 'security' }, bobToken)).status).toBe(403);
    const audit = await c.get('/api/v1/admin/audit?action=access.denied', adminToken);
    expect(audit.json.items.length).toBeGreaterThan(0);
  });

  it('protects the last global administrator', async () => {
    const c = new Client(server.baseUrl);
    const me = await c.get('/api/v1/me', adminToken);
    const res = await c.request('PUT', `/api/v1/admin/users/${me.json.user.id}/roles`, { body: { roles: [] }, token: adminToken });
    expect(res.status).toBe(409);
  });

  it('manages groups and distribution lists', async () => {
    const c = new Client(server.baseUrl);
    const dl = await c.post('/api/v1/admin/groups', { name: 'All staff', type: 'distribution', email: 'all@acme.example', memberIds: [bobId] }, adminToken);
    expect(dl.status, dl.text).toBe(201);
    expect((await c.post('/api/v1/admin/groups', { name: 'Bad', type: 'distribution', email: 'x@other.example' }, adminToken)).status).toBe(400);
    expect((await c.post('/api/v1/admin/groups', { name: 'Clash', type: 'distribution', email: 'bob@acme.example' }, adminToken)).status).toBe(409);
    const detail = await c.get(`/api/v1/admin/groups/${dl.json.group.id}`, adminToken);
    expect(detail.json.members.map((m: any) => m.email)).toEqual(['bob@acme.example']);
    const search = await c.get('/api/v1/directory/search?q=all', bobToken);
    expect(search.json.groups[0].email).toBe('all@acme.example');
  });

  it('suspension revokes access immediately', async () => {
    const c = new Client(server.baseUrl);
    const res = await c.post(`/api/v1/admin/users/${bobId}/suspend`, {}, adminToken);
    expect(res.status, res.text).toBe(200);
    expect((await c.get('/api/v1/me', bobToken)).status).toBe(401);
    const c2 = new Client(server.baseUrl);
    await expect(signIn(c2, passwordSteps('bob@acme.example', 'a brand new passphrase', { totpSecret: () => bobSecret }))).rejects.toThrow(/403/);
    expect((await c.post(`/api/v1/admin/users/${bobId}/unsuspend`, {}, adminToken)).status).toBe(200);
  });

  it('soft-deletes and restores users', async () => {
    const c = new Client(server.baseUrl);
    expect((await c.request('DELETE', `/api/v1/admin/users/${bobId}`, { token: adminToken })).status).toBe(200);
    const list = await c.get('/api/v1/admin/users?status=deleted', adminToken);
    expect(list.json.items.map((u: any) => u.id)).toContain(bobId);
    expect((await c.post(`/api/v1/admin/users/${bobId}/restore`, {}, adminToken)).status).toBe(200);
  });

  it('locks an account after repeated failures', async () => {
    const c = new Client(server.baseUrl);
    const created = await c.post('/api/v1/admin/users', { username: 'carol', displayName: 'Carol', password: 'purple elephant dancing', mustChangePassword: false }, adminToken);
    expect(created.status).toBe(201);
    for (let i = 0; i < 5; i++) {
      await expect(signIn(new Client(server.baseUrl), passwordSteps('carol@acme.example', 'wrong wrong wrong'))).rejects.toThrow(/401/);
    }
    await expect(signIn(new Client(server.baseUrl), passwordSteps('carol@acme.example', 'purple elephant dancing'))).rejects.toThrow(/423/);
    expect((await c.post(`/api/v1/admin/users/${created.json.user.id}/unlock`, {}, adminToken)).status).toBe(200);
    await signIn(new Client(server.baseUrl), passwordSteps('carol@acme.example', 'purple elephant dancing'));
  });
});

describe('organisation administration', () => {
  it('adds a domain with verification instructions', async () => {
    const c = new Client(server.baseUrl);
    const res = await c.post('/api/v1/admin/domains', { name: 'acme-mail.example' }, adminToken);
    expect(res.status).toBe(201);
    expect(res.json.domain.verificationRecord.value).toMatch(/^forge-verification=/);
    expect((await c.post('/api/v1/admin/domains', { name: 'not a domain' }, adminToken)).status).toBe(400);
  });

  it('enforces privilege-escalation rules on custom roles', async () => {
    const c = new Client(server.baseUrl);
    const res = await c.post('/api/v1/admin/roles', { key: 'mail_ops', name: 'Mail ops', permissions: ['system:read', 'audit:read'] }, adminToken);
    expect(res.status, res.text).toBe(201);
    expect((await c.post('/api/v1/admin/roles', { key: 'bad', name: 'Bad', permissions: ['nope:x'] }, adminToken)).status).toBe(400);
  });

  it('updates branding and uploads a logo into the blob store', async () => {
    const c = new Client(server.baseUrl);
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    expect((await c.request('PUT', '/api/v1/admin/org/logo', { body: { dataUrl: png }, token: adminToken })).status).toBe(200);
    const logo = await fetch(`${server.baseUrl}/api/v1/branding/logo`);
    expect(logo.headers.get('content-type')).toBe('image/png');
    expect((await c.request('PUT', '/api/v1/admin/org/logo', { body: { dataUrl: 'data:image/png;base64,AAAA' }, token: adminToken })).status).toBe(400);
    const patch = await c.request('PATCH', '/api/v1/admin/org', { body: { requireMfa: true, timezone: 'Europe/Paris' }, token: adminToken });
    expect(patch.json.org).toMatchObject({ requireMfa: true, timezone: 'Europe/Paris', hasLogo: true });
  });

  it('reports system health without Redis', async () => {
    const res = await new Client(server.baseUrl).get('/api/v1/admin/system/overview', adminToken);
    expect(res.status).toBe(200);
    expect(res.json.services.find((s: any) => s.key === 'database').state).toBe('up');
    expect(res.json.services.find((s: any) => s.key === 'redis').state).toBe('disabled');
    expect(res.json.volumes.volumes.find((v: any) => v.key === 'drive').mounted).toBe(true);
    const backup = await new Client(server.baseUrl).post('/api/v1/admin/system/backups', {}, adminToken);
    expect(backup.status).toBe(503);
  });

  it('records a searchable, exportable audit trail', async () => {
    const c = new Client(server.baseUrl);
    const res = await c.get('/api/v1/admin/audit?action=user.&limit=100', adminToken);
    const actions = res.json.items.map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['user.created', 'user.suspended', 'user.deleted', 'user.restored']));
    const csv = await c.get('/api/v1/admin/audit/export.csv', adminToken);
    expect(csv.headers.get('content-type')).toMatch(/text\/csv/);
    expect(csv.text.split('\r\n')[0]).toMatch(/^id,createdAt,action/);
  });

  it('serves the OpenAPI document', async () => {
    const res = await new Client(server.baseUrl).get('/api/docs/json');
    expect(res.status).toBe(200);
    expect(Object.keys(res.json.paths)).toContain('/api/v1/admin/users');
  });
});
