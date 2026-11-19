import { SMTPServer } from 'smtp-server';
import { createTransport } from 'nodemailer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptString } from '@forge/auth';
import { organizations, outboundMessages, orm } from '@forge/db';
import { smarthostKey, testRelay } from '../src';
import { startHarness, type Harness } from './harness';

const { eq } = orm;
const SECRET = 'test-master-secret-that-is-long-enough-0123456789';

let h: Harness;
let smarthost: SMTPServer;
let port: number;
const got: { user: string; to: string[] }[] = [];

beforeAll(async () => {
  h = await startHarness();
  await h.createUser('alice', 'alice password 123');
  (h.ctx.config as { masterSecret?: string }).masterSecret = SECRET;
  // A relay that requires a login, like a provider's smarthost.
  smarthost = new SMTPServer({
    authOptional: false,
    allowInsecureAuth: true,
    disabledCommands: ['STARTTLS'],
    logger: false,
    onAuth(auth, _session, cb) {
      if (auth.username === 'relay-user' && auth.password === 'relay-pass') return cb(null, { user: auth.username });
      return cb(Object.assign(new Error('Invalid credentials'), { responseCode: 535 }));
    },
    onData(stream, session, cb) {
      stream.on('data', () => {});
      stream.on('end', () => {
        got.push({ user: String(session.user), to: session.envelope.rcptTo.map((r) => r.address) });
        cb();
      });
    },
  });
  await new Promise<void>((r) => smarthost.listen(0, '127.0.0.1', () => r()));
  port = (smarthost.server.address() as { port: number }).port;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => smarthost?.close(() => r()));
  await h?.close();
});

const configure = (values: Partial<typeof organizations.$inferInsert>) => h.handle.db.update(organizations).set(values).where(eq(organizations.id, h.orgId));
const send = (to: string, subject: string) =>
  createTransport({ host: '127.0.0.1', port: h.ports.submission, secure: false, ignoreTLS: true, auth: { user: 'alice@acme.test', pass: 'alice password 123' } } as never).sendMail({ from: 'alice@acme.test', to, subject, text: 'x' });

describe('outgoing smarthost', () => {
  it('sends outside mail through the smarthost, signing in with the saved password', async () => {
    await configure({
      smtpRelayEnabled: true,
      smtpRelayHost: '127.0.0.1',
      smtpRelayPort: port,
      smtpRelaySecurity: 'none',
      smtpRelayUsername: 'relay-user',
      smtpRelayPasswordEnc: encryptString(smarthostKey(SECRET), 'relay-pass'),
      smtpRelayDomains: [],
    });
    await send('bob@partner.example', 'Via smarthost');
    await h.waitFor(async () => got.find((g) => g.to.includes('bob@partner.example')));
    expect(got.find((g) => g.to.includes('bob@partner.example'))!.user).toBe('relay-user');
    expect(h.relay.received.some((r) => r.to.includes('bob@partner.example'))).toBe(false);
  });

  it('can be limited to some domains; other mail uses the environment relay (or direct delivery)', async () => {
    await configure({ smtpRelayDomains: ['partner.example'] });
    await send('carol@sub.partner.example', 'Scoped in');
    await send('dave@elsewhere.example', 'Scoped out');
    await h.waitFor(async () => got.find((g) => g.to.includes('carol@sub.partner.example')));
    await h.waitFor(async () => h.relay.received.find((r) => r.to.includes('dave@elsewhere.example')));
  });

  it('a wrong password defers delivery (retried later) instead of bouncing', async () => {
    await configure({ smtpRelayDomains: [], smtpRelayPasswordEnc: encryptString(smarthostKey(SECRET), 'wrong') });
    await send('erin@partner.example', 'Bad login');
    const row = await h.waitFor(async () =>
      (await h.handle.db.select().from(outboundMessages)).find((m) => m.recipients.some((x) => x.address === 'erin@partner.example' && x.status === 'deferred')),
    );
    const rcpt = row.recipients.find((x) => x.address === 'erin@partner.example')!;
    expect(rcpt.response).toMatch(/smarthost 127\.0\.0\.1/);
    await configure({ smtpRelayEnabled: false });
  });

  it('tests settings with clear messages', async () => {
    const ok = await testRelay({ host: '127.0.0.1', port, security: 'none', username: 'relay-user', password: 'relay-pass' }, 'mail.acme.test', { from: 'alice@acme.test', to: 'x@partner.example' });
    expect(ok).toMatchObject({ ok: true, message: expect.stringContaining('accepted') });
    const bad = await testRelay({ host: '127.0.0.1', port, security: 'none', username: 'relay-user', password: 'nope' }, 'mail.acme.test');
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/username or password/);
    const tls = await testRelay({ host: '127.0.0.1', port, security: 'starttls', username: null, password: null }, 'mail.acme.test');
    expect(tls.ok).toBe(false);
  });
});
