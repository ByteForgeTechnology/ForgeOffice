import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, signIn, startServer } from './harness';

let server: Awaited<ReturnType<typeof startServer>>;
let relay: SMTPServer;
let relayPort: number;
const delivered: string[] = [];
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
  relay = new SMTPServer({
    authOptional: false,
    allowInsecureAuth: true,
    disabledCommands: ['STARTTLS'],
    logger: false,
    onAuth: (a, _s, cb) => (a.username === 'apikey' && a.password === 'SG.secret' ? cb(null, { user: 'apikey' }) : cb(Object.assign(new Error('Bad credentials'), { responseCode: 535 }))),
    onData(stream, session, cb) {
      stream.on('data', () => {});
      stream.on('end', () => {
        delivered.push(...session.envelope.rcptTo.map((r) => r.address));
        cb();
      });
    },
  });
  await new Promise<void>((r) => relay.listen(0, '127.0.0.1', () => r()));
  relayPort = (relay.server.address() as { port: number }).port;
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
  await new Promise<void>((r) => relay?.close(() => r()));
});

describe('smarthost settings', () => {
  const base = () => ({ enabled: true, host: '127.0.0.1', port: relayPort, security: 'none', username: 'apikey', domains: [] as string[] });

  it('saves settings without ever returning the password', async () => {
    const initial = await call('GET', '/api/v1/admin/mail/smarthost', 'admin');
    expect(initial.json).toMatchObject({ enabled: false, hasPassword: false, port: 587, security: 'starttls' });
    const saved = await call('PUT', '/api/v1/admin/mail/smarthost', 'admin', { ...base(), password: 'SG.secret', domains: ['*.Partner.example', 'other.example'] });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.json).toMatchObject({ enabled: true, host: '127.0.0.1', username: 'apikey', hasPassword: true, domains: ['partner.example', 'other.example'] });
    expect(saved.text).not.toContain('SG.secret');
    // Leaving the password out keeps it.
    expect((await call('PUT', '/api/v1/admin/mail/smarthost', 'admin', base())).json.hasPassword).toBe(true);
    expect((await call('GET', '/api/v1/admin/org', 'admin')).text).not.toMatch(/smtpRelay|SG\.secret/);
    expect((await call('PUT', '/api/v1/admin/mail/smarthost', 'admin', { ...base(), host: 'not a host!' })).status).toBe(400);
    expect((await call('PUT', '/api/v1/admin/mail/smarthost', 'admin', { ...base(), domains: ['bad domain'] })).status).toBe(400);
    expect((await call('PUT', '/api/v1/admin/mail/smarthost', 'admin', { ...base(), host: '' })).status).toBe(400);
  });

  it('tests the connection and login, with the saved password or a new one, and can send a test message', async () => {
    const ok = await call('POST', '/api/v1/admin/mail/smarthost/test', 'admin', base());
    expect(ok.json).toMatchObject({ ok: true, message: expect.stringContaining('signed in as apikey') });
    const wrong = await call('POST', '/api/v1/admin/mail/smarthost/test', 'admin', { ...base(), password: 'nope' });
    expect(wrong.json.ok).toBe(false);
    expect(wrong.json.message).toMatch(/username or password/);
    const sent = await call('POST', '/api/v1/admin/mail/smarthost/test', 'admin', { ...base(), sendTo: 'it@partner.example' });
    expect(sent.json.ok).toBe(true);
    expect(delivered).toContain('it@partner.example');
    const audit = await call('GET', '/api/v1/admin/audit?action=mail.smarthost_updated', 'admin');
    expect(JSON.stringify(audit.json)).not.toContain('SG.secret');
  });

  it('only organisation admins can change it', async () => {
    expect((await call('PUT', '/api/v1/admin/mail/smarthost', 'helen', base())).status).toBe(403);
    expect((await call('POST', '/api/v1/admin/mail/smarthost/test', 'helen', base())).status).toBe(403);
  });
});
