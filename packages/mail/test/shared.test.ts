import { ImapFlow } from 'imapflow';
import { createTransport } from 'nodemailer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { groupMembers, groups, mailboxPermissions, messages, orm } from '@forge/db';
import { ensureMailboxes } from '../src';
import { startHarness, type Harness } from './harness';

const { eq } = orm;

let h: Harness;
let support: Awaited<ReturnType<Harness['createUser']>>;
let alice: Awaited<ReturnType<Harness['createUser']>>;

const imap = async (user: string, pass: string) => {
  const c = new ImapFlow({ host: '127.0.0.1', port: h.ports.imap, secure: false, doSTARTTLS: false, auth: { user, pass }, logger: false });
  await c.connect();
  return c;
};
const submit = (user: string, pass: string) => createTransport({ host: '127.0.0.1', port: h.ports.submission, secure: false, ignoreTLS: true, auth: { user, pass } } as never);
const external = () => createTransport({ host: '127.0.0.1', port: h.ports.smtp, secure: false, ignoreTLS: true } as never);

beforeAll(async () => {
  h = await startHarness();
  support = await h.createUser('support', 'never used password', { kind: 'shared' });
  alice = await h.createUser('alice', 'alice password 123');
  const bob = await h.createUser('bob', 'bob password 1234');
  const carol = await h.createUser('carol', 'carol secret 12345');
  // Alice: full access + send as. Bob: read-only + send on behalf (via a group). Carol: nothing.
  const [team] = await h.handle.db.insert(groups).values({ orgId: h.orgId, name: 'Helpdesk', type: 'security' }).returning();
  await h.handle.db.insert(groupMembers).values({ groupId: team!.id, userId: bob.id });
  await h.handle.db.insert(mailboxPermissions).values([
    { ownerId: support.id, principalType: 'user', principalId: alice.id, access: 'full', sendAs: true },
    { ownerId: support.id, principalType: 'group', principalId: team!.id, access: 'read', sendOnBehalf: true },
  ]);
  void carol;
  await external().sendMail({ from: 'customer@example.org', to: 'support@acme.test', subject: 'Help please', text: 'My widget broke' });
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe('shared mailboxes over IMAP', () => {
  it('cannot be signed in to directly', async () => {
    await expect(imap('support@acme.test', 'never used password')).rejects.toThrow();
  });

  it('appear under the Shared/ namespace for members', async () => {
    const c = await imap('alice@acme.test', 'alice password 123');
    const paths = (await c.list()).map((l) => l.path);
    expect(paths).toEqual(expect.arrayContaining(['INBOX', 'Shared/support@acme.test/INBOX', 'Shared/support@acme.test/Sent']));
    const lock = await c.getMailboxLock('Shared/support@acme.test/INBOX');
    try {
      const msg = await c.fetchOne('*', { envelope: true });
      expect(msg && msg.envelope?.subject).toBe('Help please');
      await c.messageFlagsAdd('*', ['\\Flagged']);
      // Move a copy into her own mailbox: crosses accounts.
      const moved = await c.messageMove('*', 'INBOX');
      expect(moved && moved.uidMap?.size).toBe(1);
    } finally {
      lock.release();
    }
    const own = await h.handle.db.select().from(messages).where(eq(messages.userId, alice.id));
    expect(own.map((m) => m.subject)).toContain('Help please');
    const sharedInbox = (await ensureMailboxes(h.ctx, support.id)).find((b) => b.specialUse === '\\Inbox')!;
    expect(await h.handle.db.select().from(messages).where(eq(messages.mailboxId, sharedInbox.id))).toHaveLength(0);
    await c.logout();
  });

  it('are read-only for read grants (including via groups) and hidden from others', async () => {
    await external().sendMail({ from: 'customer@example.org', to: 'support@acme.test', subject: 'Second ticket', text: '…' });
    const bob = await imap('bob@acme.test', 'bob password 1234');
    const box = await bob.mailboxOpen('Shared/support@acme.test/INBOX');
    expect(box.readOnly).toBe(true);
    expect(await bob.messageFlagsAdd('*', ['\\Deleted'])).toBe(false);
    await expect(bob.append('Shared/support@acme.test/INBOX', 'Subject: x\r\n\r\ny')).rejects.toThrow();
    await bob.logout();

    const carol = await imap('carol@acme.test', 'carol secret 12345');
    expect((await carol.list()).some((l) => l.path.startsWith('Shared/'))).toBe(false);
    await expect(carol.mailboxOpen('Shared/support@acme.test/INBOX')).rejects.toThrow();
    await carol.logout();
  });
});

describe('sending from shared mailboxes', () => {
  it('allows Send As for granted users', async () => {
    await submit('alice@acme.test', 'alice password 123').sendMail({ from: 'Support <support@acme.test>', to: 'customer@example.org', subject: 'Re: Help please', text: 'Fixed!' });
    const out = await h.waitFor(async () => h.relay.received.find((r) => r.raw.toString().includes('Subject: Re: Help please')));
    expect(out.from).toBe('support@acme.test');
    expect(out.raw.toString()).not.toMatch(/^Sender:/m);
  });

  it('requires a Sender header for Send on Behalf', async () => {
    const bob = submit('bob@acme.test', 'bob password 1234');
    await expect(bob.sendMail({ from: 'support@acme.test', to: 'customer@example.org', subject: 'No sender', text: 'x' })).rejects.toThrow(/own addresses/);
    await bob.sendMail({ from: 'support@acme.test', sender: 'bob@acme.test', to: 'customer@example.org', subject: 'On behalf', text: 'x' });
    const out = await h.waitFor(async () => h.relay.received.find((r) => r.raw.toString().includes('Subject: On behalf')));
    expect(out.raw.toString()).toMatch(/^Sender: bob@acme\.test/m);
  });

  it('refuses people without send rights', async () => {
    await expect(submit('carol@acme.test', 'carol secret 12345').sendMail({ from: 'support@acme.test', to: 'customer@example.org', text: 'x' })).rejects.toThrow(/not allowed|own addresses/);
  });
});

describe('individually shared folders over IMAP', () => {
  it('list only the shared folder and enforce read / write', async () => {
    const { createMailbox, deliverInbound, composeMessage } = await import('../src');
    const { folderPermissions, users } = await import('@forge/db');
    const [bobRow] = await h.handle.db.select().from(users).where(eq(users.email, 'bob@acme.test'));
    const [carolRow] = await h.handle.db.select().from(users).where(eq(users.email, 'carol@acme.test'));
    const projects = await createMailbox(h.ctx, alice.id, 'Projects');
    await h.handle.db.insert(folderPermissions).values([
      { mailboxId: projects.id, ownerId: alice.id, principalType: 'user', principalId: bobRow!.id, access: 'read' },
      { mailboxId: projects.id, ownerId: alice.id, principalType: 'user', principalId: carolRow!.id, access: 'write' },
    ]);
    const { raw } = await composeMessage({ from: { name: 'X', address: 'x@example.org' }, to: [{ name: '', address: 'alice@acme.test' }], subject: 'Apollo', text: 'notes' });
    await deliverInbound(h.ctx, { raw, envelopeFrom: 'x@example.org', recipients: ['alice@acme.test'] });
    const c = await imap('alice@acme.test', 'alice password 123');
    await c.mailboxOpen('INBOX');
    await c.messageMove('*', 'Projects');
    await c.logout();

    const bob = await imap('bob@acme.test', 'bob password 1234');
    const paths = (await bob.list()).map((l) => l.path);
    expect(paths).toContain('Shared/alice@acme.test/Projects');
    expect(paths).not.toContain('Shared/alice@acme.test/INBOX');
    expect((await bob.mailboxOpen('Shared/alice@acme.test/Projects')).readOnly).toBe(true);
    await expect(bob.mailboxOpen('Shared/alice@acme.test/INBOX')).rejects.toThrow();
    await bob.logout();

    const carol = await imap('carol@acme.test', 'carol secret 12345');
    const box = await carol.mailboxOpen('Shared/alice@acme.test/Projects');
    expect(box.readOnly).toBe(false);
    expect(await carol.messageFlagsAdd('*', ['\\Flagged'])).toBe(true);
    expect(await carol.messageFlagsAdd('*', ['\\Deleted'])).toBe(false);
    await carol.logout();
  });
});
