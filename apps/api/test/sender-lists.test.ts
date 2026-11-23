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


describe('mailbox sender lists', () => {
  it('add, move between lists and remove entries', async () => {
    const added = await call('POST', '/api/v1/mail/sender-lists', 'helen', { list: 'block', entries: ['Spam@Junk.example', '*@ads.example', 'ads.example'], note: 'annoying' });
    expect(added.status, added.text).toBe(201);
    expect(added.json.items.map((i: { entry: string }) => i.entry).sort()).toEqual(['ads.example', 'spam@junk.example']);
    // Allowing an entry that is blocked moves it, keeping the note.
    await call('POST', '/api/v1/mail/sender-lists', 'helen', { list: 'allow', entries: ['ads.example'] });
    const list = await call('GET', '/api/v1/mail/sender-lists', 'helen');
    expect(list.json.items).toEqual([
      expect.objectContaining({ entry: 'ads.example', list: 'allow', note: 'annoying', createdBy: 'Helen' }),
      expect.objectContaining({ entry: 'spam@junk.example', list: 'block' }),
    ]);
    const bad = await call('POST', '/api/v1/mail/sender-lists', 'helen', { list: 'block', entries: ['fine.example', 'not valid'] });
    expect(bad.status).toBe(400);
    expect(bad.json.message).toContain('not valid');
    // Lists are private to each mailbox.
    expect((await call('GET', '/api/v1/mail/sender-lists', 'admin')).json.items).toHaveLength(0);
    expect((await call('POST', '/api/v1/mail/sender-lists/remove', 'admin', { ids: [list.json.items[0].id] })).json.removed).toBe(0);
    expect((await call('POST', '/api/v1/mail/sender-lists/remove', 'helen', { ids: list.json.items.map((i: { id: string }) => i.id) })).json.removed).toBe(2);
  });
});

describe('organisation sender lists', () => {
  it('are managed by organisation admins and audited', async () => {
    const r = await call('POST', '/api/v1/admin/sender-lists', 'admin', { list: 'block', entries: ['spammer.example'] });
    expect(r.status, r.text).toBe(201);
    expect((await call('POST', '/api/v1/admin/sender-lists', 'helen', { list: 'block', entries: ['x.example'] })).status).toBe(403);
    expect((await call('GET', '/api/v1/admin/sender-lists', 'helen')).status).toBe(403);
    // Allowing our own domain would let forged mail skip the spam filter.
    const own = await call('POST', '/api/v1/admin/sender-lists', 'admin', { list: 'allow', entries: ['ceo@acme.test'] });
    expect(own.status).toBe(400);
    expect(own.json.message).toMatch(/own domains/);
    // Organisation and mailbox lists are separate.
    expect((await call('GET', '/api/v1/mail/sender-lists', 'admin')).json.items).toHaveLength(0);
    const items = (await call('GET', '/api/v1/admin/sender-lists', 'admin')).json.items;
    expect(items).toEqual([expect.objectContaining({ entry: 'spammer.example', list: 'block' })]);
    await call('POST', '/api/v1/admin/sender-lists/remove', 'admin', { ids: [items[0].id] });
    const audit = await call('GET', '/api/v1/admin/audit?action=mail.senders_blocked', 'admin');
    expect(audit.json.items[0].metadata.entries).toEqual(['spammer.example']);
    expect((await call('GET', '/api/v1/admin/audit?action=mail.sender_list_entries_removed', 'admin')).json.items).toHaveLength(1);
  });
});
