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

describe('transport rules admin', () => {
  let externalTag: string;

  it('creates rules in priority order and validates them', async () => {
    const tag = await call('POST', '/api/v1/admin/transport-rules', 'admin', {
      name: 'Tag external mail',
      appliesTo: 'inbound',
      conditions: [{ type: 'senderScope', scope: 'external' }],
      actions: [{ type: 'prependSubject', text: '[EXTERNAL]' }],
    });
    expect(tag.status, tag.text).toBe(201);
    externalTag = tag.json.rule.id;
    const block = await call('POST', '/api/v1/admin/transport-rules', 'admin', {
      name: 'Block secrets',
      appliesTo: 'outbound',
      conditions: [{ type: 'subjectOrBodyContains', values: ['top secret'] }],
      actions: [{ type: 'reject', text: 'Classified material cannot be emailed outside' }],
    });
    expect(block.json.rule.priority).toBe(1);
    expect((await call('POST', '/api/v1/admin/transport-rules', 'admin', { name: 'Bad', actions: [{ type: 'setHeader', header: 'From', text: 'ceo@acme.test' }] })).status).toBe(400);
    expect((await call('POST', '/api/v1/admin/transport-rules', 'admin', { name: 'Bad', conditions: [{ type: 'senderAddress', values: [] }], actions: [{ type: 'delete' }] })).status).toBe(400);
    expect((await call('POST', '/api/v1/admin/transport-rules', 'admin', { name: 'Bad', appliesTo: 'outbound', actions: [{ type: 'junk' }] })).status).toBe(400);
    // Only organisation managers can change mail flow.
    expect((await call('POST', '/api/v1/admin/transport-rules', 'helen', { name: 'x', actions: [{ type: 'delete' }] })).status).toBe(403);
    const order = await call('POST', '/api/v1/admin/transport-rules/order', 'admin', { ids: [block.json.rule.id, externalTag] });
    expect(order.status).toBe(200);
    const list = await call('GET', '/api/v1/admin/transport-rules', 'admin');
    expect(list.json.items.map((r: { name: string }) => r.name)).toEqual(['Block secrets', 'Tag external mail']);
  });

  it('dry-runs a sample message without sending anything', async () => {
    const inbound = await call('POST', '/api/v1/admin/transport-rules/test', 'admin', { direction: 'inbound', from: 'someone@outside.example', to: ['admin@acme.test'], subject: 'Hello', body: 'Hi' });
    expect(inbound.json.matched.map((m: { name: string }) => m.name)).toEqual(['Tag external mail']);
    expect(inbound.json.result).toMatchObject({ verdict: 'delivered', subject: '[EXTERNAL] Hello' });
    const outbound = await call('POST', '/api/v1/admin/transport-rules/test', 'admin', { direction: 'outbound', from: 'admin@acme.test', to: ['x@outside.example'], subject: 'Plans', body: 'This is TOP SECRET' });
    expect(outbound.json.result).toEqual({ verdict: 'rejected', message: 'Classified material cannot be emailed outside' });
  });

  it('applies to mail sent from webmail and records matches', async () => {
    await call('PATCH', '/api/v1/admin/org', 'admin', { undoSendSeconds: 0 });
    const blocked = await call('POST', '/api/v1/mail/send', 'admin', { to: [{ address: 'x@outside.example' }], subject: 'Plans', html: '<p>top secret stuff</p>' });
    expect(blocked.status).toBe(400);
    expect(blocked.json.message).toBe('Your message was not sent: Classified material cannot be emailed outside');
    // Internal mail is not "outbound", so the rule does not apply.
    const internal = await call('POST', '/api/v1/mail/send', 'admin', { to: [{ address: 'helen@acme.test' }], subject: 'Plans', html: '<p>top secret stuff</p>' });
    expect(internal.status, internal.text).toBe(200);
    const rules = (await call('GET', '/api/v1/admin/transport-rules', 'admin')).json.items;
    const block = rules.find((r: { name: string }) => r.name === 'Block secrets');
    expect(block.hits30d).toBe(1);
    const hits = await call('GET', `/api/v1/admin/transport-rules/${block.id}/hits`, 'admin');
    expect(hits.json.items[0]).toMatchObject({ direction: 'outbound', subject: 'Plans', sender: 'admin@acme.test', mode: 'enforce' });
    const audit = await call('GET', '/api/v1/admin/audit?action=mail.transport_rule_created', 'admin');
    expect(audit.json.items).toHaveLength(2);
  });

  it('can be disabled and deleted', async () => {
    const rules = (await call('GET', '/api/v1/admin/transport-rules', 'admin')).json.items;
    const block = rules.find((r: { name: string }) => r.name === 'Block secrets');
    await call('PUT', `/api/v1/admin/transport-rules/${block.id}`, 'admin', { ...block, enabled: false, createdAt: undefined, updatedAt: undefined, id: undefined, orgId: undefined, priority: undefined, hits30d: undefined });
    expect((await call('POST', '/api/v1/mail/send', 'admin', { to: [{ address: 'x@outside.example' }], subject: 'Plans', html: '<p>top secret</p>' })).status).toBe(200);
    expect((await call('DELETE', `/api/v1/admin/transport-rules/${block.id}`, 'admin')).status).toBe(200);
  });
});
