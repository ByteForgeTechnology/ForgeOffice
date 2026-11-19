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

describe('changing the primary address', () => {
  it('swaps an alias with the primary address everywhere it matters', async () => {
    const c = new Client(server.baseUrl);
    const created = await c.post('/api/v1/admin/users', { username: 'dana', displayName: 'Dana Smith', password: 'marble orchard 4471', mustChangePassword: false }, tokens.admin);
    const id = created.json.user.id;
    tokens.dana = (await signIn(new Client(server.baseUrl), login('dana@acme.test', 'marble orchard 4471'))).tokens.access_token;
    const alias = await call('POST', `/api/v1/admin/users/${id}/aliases`, 'helen', { address: 'd.smith@acme.test' });
    expect(alias.status, alias.text).toBe(201);

    // An event Dana organises, under her current address.
    const cals = (await call('GET', '/api/v1/calendar/calendars', 'dana')).json.items;
    const ev = await call('POST', '/api/v1/calendar/events', 'dana', { calendarId: cals[0].id, summary: 'Planning', start: '2031-05-05T09:00:00.000Z', end: '2031-05-05T10:00:00.000Z', attendees: [{ email: 'helen@acme.test' }] });
    expect(ev.status, ev.text).toBe(201);

    expect((await call('POST', `/api/v1/admin/users/${id}/aliases/${crypto.randomUUID()}/make-primary`, 'helen')).status).toBe(404);
    const swap = await call('POST', `/api/v1/admin/users/${id}/aliases/${alias.json.alias.id}/make-primary`, 'helen');
    expect(swap.status, swap.text).toBe(200);
    expect(swap.json).toEqual({ email: 'd.smith@acme.test', previous: 'dana@acme.test' });

    const detail = await call('GET', `/api/v1/admin/users/${id}`, 'admin');
    expect(detail.json.user).toMatchObject({ email: 'd.smith@acme.test', username: 'd.smith' });
    expect((await call('GET', `/api/v1/admin/users/${id}/aliases`, 'admin')).json.items.map((a: { address: string }) => a.address)).toEqual(['dana@acme.test']);

    // Her own copy of the event now names her by the new address.
    const after = await call('GET', `/api/v1/calendar/events/${ev.json.event.id}`, 'dana');
    const text = JSON.stringify(after.json.event);
    expect(text).toContain('d.smith@acme.test');
    expect(text).not.toContain('dana@acme.test');

    // She signs in with the new address; the old one is now only an alias.
    await expect(signIn(new Client(server.baseUrl), login('d.smith@acme.test', 'marble orchard 4471'))).resolves.toBeTruthy();
    await expect(signIn(new Client(server.baseUrl), login('dana@acme.test', 'marble orchard 4471'))).rejects.toThrow();

    // Swapping back works too.
    const back = (await call('GET', `/api/v1/admin/users/${id}/aliases`, 'admin')).json.items[0];
    expect((await call('POST', `/api/v1/admin/users/${id}/aliases/${back.id}/make-primary`, 'admin')).json.email).toBe('dana@acme.test');

    const audit = await call('GET', '/api/v1/admin/audit?action=user.primary_address_changed', 'admin');
    expect(audit.json.items.map((i: { metadata: { to: string } }) => i.metadata.to).sort()).toEqual(['d.smith@acme.test', 'dana@acme.test']);
  });
});
