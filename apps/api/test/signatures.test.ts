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
  await c.post('/api/v1/admin/users', { username: 'helen', displayName: 'Helen', password: 'violet tangerine 77', mustChangePassword: false, roles: ['user_admin'] }, tokens.admin);
  tokens.helen = (await signIn(new Client(server.baseUrl), login('helen', 'violet tangerine 77'))).tokens.access_token;
}, 120_000);

afterAll(async () => {
  await server?.close();
});

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let helenId: string;

describe('contact details', () => {
  it('are stored, validated and shown in the directory', async () => {
    const list = await call('GET', '/api/v1/admin/users?q=helen', 'admin');
    helenId = list.json.items[0].id;
    const r = await call('PATCH', `/api/v1/admin/users/${helenId}`, 'admin', {
      jobTitle: 'Head of People',
      workPhone: '+44 20 7946 0000',
      mobilePhone: ' ',
      website: 'www.acme.test',
      officeLocation: 'London',
      streetAddress: '1 High Street',
      city: 'London',
      postalCode: 'EC1A 1AA',
      country: 'United Kingdom',
      pronouns: 'she/her',
    });
    expect(r.status, r.text).toBe(200);
    expect(r.json.user).toMatchObject({ workPhone: '+44 20 7946 0000', mobilePhone: null, website: 'www.acme.test', pronouns: 'she/her' });
    expect((await call('PATCH', `/api/v1/admin/users/${helenId}`, 'admin', { workPhone: 'call me' })).status).toBe(400);
    expect((await call('PATCH', `/api/v1/admin/users/${helenId}`, 'admin', { website: 'not a site' })).status).toBe(400);
    const card = await call('GET', `/api/v1/directory/users/${helenId}`, 'admin');
    expect(card.json.person).toMatchObject({ officeLocation: 'London', workPhone: '+44 20 7946 0000' });
  });
});

describe('email signatures', () => {
  const template = '<p><strong>{{displayName}}</strong> ({{pronouns}})<br>{{jobTitle}} · {{company}}</p><p>T: <a href="tel:{{workPhone}}">{{workPhone}}</a><br>M: {{mobilePhone}}</p><p><a href="{{website}}">{{website}}</a></p><script>alert(1)</script>';
  let sigId: string;

  it('are validated and sanitised', async () => {
    expect((await call('POST', '/api/v1/admin/signatures', 'admin', { name: 'x', html: '<p>{{shoeSize}}</p>' })).json.message).toMatch(/Unknown variable/);
    expect((await call('POST', '/api/v1/admin/signatures', 'admin', { name: 'x', html: '<p> </p>' })).status).toBe(400);
    expect((await call('POST', '/api/v1/admin/signatures', 'admin', { name: 'x', html: '<p>x</p>', audience: 'groups', groupIds: [] })).status).toBe(400);
    expect((await call('POST', '/api/v1/admin/signatures', 'helen', { name: 'x', html: '<p>x</p>' })).status).toBe(403);
    const r = await call('POST', '/api/v1/admin/signatures', 'admin', { name: 'Standard', html: template });
    expect(r.status, r.text).toBe(201);
    sigId = r.json.signature.id;
    expect(r.json.signature.html).not.toContain('script');
    expect(r.json.signature.html).toContain('href="tel:{{workPhone}}"');
    expect(r.json.signature.html).toContain('href="{{website}}"');
  });

  it('preview with sample or real details', async () => {
    const sample = await call('POST', '/api/v1/admin/signatures/preview', 'admin', { html: template });
    expect(sample.json.html).toContain('Alex Morgan');
    const real = await call('POST', '/api/v1/admin/signatures/preview', 'admin', { html: template, userId: helenId });
    expect(real.json.html).toContain('<strong>Helen</strong> (she/her)<br>Head of People · Acme');
    expect(real.json.html).toContain('href="tel:+442079460000"');
    expect(real.json.html).toContain('<a href="https://www.acme.test">www.acme.test</a>');
    expect(real.json.html).not.toContain('M:');
  });

  it('are served to webmail for the signed-in person', async () => {
    const mine = await call('GET', '/api/v1/mail/signature', 'helen');
    expect(mine.json.signature).toMatchObject({ name: 'Standard', useForNew: true, useForReplies: true });
    expect(mine.json.signature.html).toContain('Head of People');
    await call('PUT', `/api/v1/admin/signatures/${sigId}`, 'admin', { name: 'Standard', html: template, enabled: false });
    expect((await call('GET', '/api/v1/mail/signature', 'helen')).json.signature).toBeNull();
  });

  it('host images publicly', async () => {
    const up = await call('POST', '/api/v1/admin/signatures/images', 'admin', { dataUrl: PNG, name: 'logo.png' });
    expect(up.status, up.text).toBe(201);
    const res = await fetch(up.json.image.url.replace(/^https?:\/\/[^/]+/, server.baseUrl));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect((await call('GET', '/api/v1/admin/signatures/images', 'admin')).json.items).toHaveLength(1);
    expect((await call('GET', '/api/v1/admin/audit?action=mail.signature_created', 'admin')).json.items).toHaveLength(1);
  });
});
