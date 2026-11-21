import { ImapFlow } from 'imapflow';
import { createTransport } from 'nodemailer';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureTaskLists, findByUid, flagTaskUid } from '@forge/calendar';
import { messages, orm, organizations, resetFeatureCache, type FeatureFlags } from '@forge/db';
import { setFlags } from '../src';
import { startHarness, type Harness } from './harness';

const { eq } = orm;
let h: Harness;
let alice: Awaited<ReturnType<Harness['createUser']>>;

const set = async (features: Partial<FeatureFlags>) => {
  await h.handle.db.update(organizations).set({ features: { mail: true, calendar: true, contacts: true, tasks: true, drive: true, ...features } }).where(eq(organizations.id, h.orgId));
  resetFeatureCache();
};
const external = () => createTransport({ host: '127.0.0.1', port: h.ports.smtp, secure: false, ignoreTLS: true } as never);

beforeAll(async () => {
  h = await startHarness();
  alice = await h.createUser('alice', 'alice password 123');
}, 60_000);
beforeEach(() => set({}));
afterAll(async () => {
  await set({});
  await h?.close();
});

describe('ForgeMail switched off', () => {
  it('refuses mail from outside and IMAP / SMTP sign-ins', async () => {
    await set({ mail: false });
    await expect(external().sendMail({ from: 'x@example.org', to: 'alice@acme.test', subject: 'Hi', text: 'x' })).rejects.toThrow(/does not receive email here/);
    const imap = new ImapFlow({ host: '127.0.0.1', port: h.ports.imap, secure: false, doSTARTTLS: false, auth: { user: 'alice@acme.test', pass: 'alice password 123' }, logger: false });
    await expect(imap.connect()).rejects.toThrow();
    const submit = createTransport({ host: '127.0.0.1', port: h.ports.submission, secure: false, ignoreTLS: true, auth: { user: 'alice@acme.test', pass: 'alice password 123' } } as never);
    await expect(submit.sendMail({ from: 'alice@acme.test', to: 'x@example.org', text: 'x' })).rejects.toThrow(/turned off/);

    // Back on: everything works again.
    await set({});
    await external().sendMail({ from: 'x@example.org', to: 'alice@acme.test', subject: 'Back', text: 'x' });
    expect((await h.handle.db.select().from(messages).where(eq(messages.subject, 'Back'))).length).toBe(1);
  });
});

describe('ForgeTasks switched off', () => {
  it('flagging an email keeps the flag but makes no task', async () => {
    await external().sendMail({ from: 'x@example.org', to: 'alice@acme.test', subject: 'Flag me', text: 'x' });
    const [m] = await h.handle.db.select().from(messages).where(eq(messages.subject, 'Flag me'));
    await set({ tasks: false });
    await setFlags(h.ctx, alice.id, [m!.id], { flagged: true });
    const { flagged } = await ensureTaskLists(h.handle.db, alice);
    expect(await findByUid(h.handle.db, [flagged.id], flagTaskUid(m!.id))).toBeNull();
    expect((await h.handle.db.select().from(messages).where(eq(messages.id, m!.id)))[0]!.flagged).toBe(true);
  });
});
