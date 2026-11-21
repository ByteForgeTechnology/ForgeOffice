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
  await c.post('/api/v1/admin/users', { username: 'helen', displayName: 'Helen', password: 'violet tangerine 77', mustChangePassword: false }, tokens.admin);
  tokens.helen = (await signIn(new Client(server.baseUrl), login('helen', 'violet tangerine 77'))).tokens.access_token;
}, 120_000);

afterAll(async () => {
  await server?.close();
});

const features = (f: Record<string, boolean>) => call('PATCH', '/api/v1/admin/org', 'admin', { features: f });

describe('features (Admin → Organisation → Features)', () => {
  it('are all on by default and shown to everyone', async () => {
    const me = await call('GET', '/api/v1/me', 'helen');
    expect(me.json.org.features).toEqual({ mail: true, calendar: true, contacts: true, tasks: true, drive: true });
  });

  it('switching a product off makes its API answer 403; data comes back when it is switched on', async () => {
    const list = await call('POST', '/api/v1/tasks', 'helen', { title: 'Keep me' });
    expect(list.status).toBe(201);
    expect((await features({ tasks: false, mail: false })).status).toBe(200);
    expect((await call('GET', '/api/v1/me', 'helen')).json.org.features).toMatchObject({ tasks: false, mail: false, calendar: true });

    const t = await call('GET', '/api/v1/tasks?view=all', 'helen');
    expect(t.status).toBe(403);
    expect(t.json).toMatchObject({ error: 'feature_disabled', feature: 'tasks', message: 'ForgeTasks is turned off for your organisation' });
    expect((await call('GET', '/api/v1/mail/mailboxes', 'helen')).status).toBe(403);
    expect((await call('GET', '/api/v1/admin/transport-rules', 'admin')).status).toBe(403);
    // Other products and ForgeDirectory carry on.
    expect((await call('GET', '/api/v1/calendar/calendars', 'helen')).status).toBe(200);
    expect((await call('GET', '/api/v1/admin/users', 'admin')).status).toBe(200);

    await features({ tasks: true, mail: true });
    const back = await call('GET', '/api/v1/tasks?view=all', 'helen');
    expect(back.json.items.map((x: { title: string }) => x.title)).toContain('Keep me');
  });

  it('applies to CalDAV and CardDAV', async () => {
    const pw = (await call('POST', '/api/v1/me/app-passwords', 'helen', { name: 'Phone' })).json.password;
    const basic = 'Basic ' + Buffer.from(`helen@acme.test:${pw}`).toString('base64');
    const me = (await call('GET', '/api/v1/me', 'helen')).json.user.id;
    const propfind = (path: string) =>
      fetch(`${server.baseUrl}${path}`, { method: 'PROPFIND', headers: { authorization: basic, depth: '1', 'content-type': 'application/xml' }, body: '<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>' });
    await features({ calendar: false });
    const home = await (await propfind(`/dav/calendars/${me}/`)).text();
    expect(home).toContain('Tasks');
    expect(home).not.toContain('<d:displayname>Calendar</d:displayname>');
    await features({ calendar: true, contacts: false });
    expect((await propfind(`/dav/addressbooks/${me}/`)).status).toBe(403);
    await features({ contacts: true });
    expect((await propfind(`/dav/addressbooks/${me}/`)).status).toBe(207);
  });

  it('only organisation admins can change them, and changes are audited', async () => {
    expect((await call('PATCH', '/api/v1/admin/org', 'helen', { features: { mail: false } })).status).toBe(403);
    // ForgeDirectory has no switch: asking to turn it off changes nothing.
    const dir = await call('PATCH', '/api/v1/admin/org', 'admin', { features: { directory: false } });
    expect(dir.json.org.features).toEqual({ mail: true, calendar: true, contacts: true, tasks: true, drive: true });
    expect((await call('GET', '/api/v1/admin/users', 'admin')).status).toBe(200);
    const audit = await call('GET', '/api/v1/admin/audit?action=org.feature_disabled', 'admin');
    expect(audit.json.items.map((i: { targetLabel: string }) => i.targetLabel).sort()).toEqual(['ForgeCalendar', 'ForgeContacts', 'ForgeMail', 'ForgeTasks']);
  });
});
