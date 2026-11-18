import { ImapFlow } from 'imapflow';
import { createTransport } from 'nodemailer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '@forge/auth';
import { buildEventIcs } from '@forge/calendar';
import { appPasswords, autoReplies, calendarObjects, groupMembers, groups, mailFilters, mailboxes, messages, orm, outboundMessages, resources } from '@forge/db';
import { composeMessage, deliverInbound, ensureMailboxes } from '../src';
import { startHarness, type Harness } from './harness';

const { and, eq } = orm;

let h: Harness;
let alice: Awaited<ReturnType<Harness['createUser']>>;
let bob: Awaited<ReturnType<Harness['createUser']>>;

const external = (opts: Record<string, unknown>) =>
  createTransport({ host: '127.0.0.1', port: h.ports.smtp, secure: false, ignoreTLS: true, ...opts } as never);

const submit = (user: string, pass: string) =>
  createTransport({ host: '127.0.0.1', port: h.ports.submission, secure: false, ignoreTLS: true, auth: { user, pass } } as never);

async function imap(user: string, pass: string) {
  const client = new ImapFlow({ host: '127.0.0.1', port: h.ports.imap, secure: false, doSTARTTLS: false, auth: { user, pass }, logger: false });
  await client.connect();
  return client;
}

async function inbox(userId: string) {
  const boxes = await ensureMailboxes(h.ctx, userId);
  const box = boxes.find((b) => b.specialUse === '\\Inbox')!;
  return h.handle.db.select().from(messages).where(eq(messages.mailboxId, box.id));
}

beforeAll(async () => {
  h = await startHarness();
  alice = await h.createUser('alice', 'alice password 123');
  bob = await h.createUser('bob', 'bob password 1234');
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe('inbound SMTP (MX)', () => {
  it('accepts mail for local users and stores it in INBOX', async () => {
    await external({}).sendMail({ from: 'Carol <carol@example.org>', to: 'alice@acme.test', subject: 'Hello Alice', text: 'First message body', messageId: '<m1@example.org>' });
    const rows = await inbox(alice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject: 'Hello Alice', seen: false, messageId: '<m1@example.org>' });
    expect(rows[0]!.fromAddr).toEqual({ name: 'Carol', address: 'carol@example.org' });
  });

  it('rejects unknown recipients and refuses to relay', async () => {
    await expect(external({}).sendMail({ from: 'x@example.org', to: 'nobody@acme.test', text: 'hi' })).rejects.toThrow(/550|No such user/);
    await expect(external({}).sendMail({ from: 'x@example.org', to: 'victim@elsewhere.example', text: 'hi' })).rejects.toThrow(/Relaying denied/);
  });

  it('threads replies with their parent', async () => {
    await external({}).sendMail({ from: 'carol@example.org', to: 'alice@acme.test', subject: 'Re: Hello Alice', text: 'reply', inReplyTo: '<m1@example.org>', references: ['<m1@example.org>'] });
    const rows = await inbox(alice.id);
    expect(new Set(rows.map((r) => r.threadId)).size).toBe(1);
  });

  it('expands distribution lists and blocks external senders when configured', async () => {
    const [list] = await h.handle.db.insert(groups).values({ orgId: h.orgId, name: 'Team', type: 'distribution', email: 'team@acme.test' }).returning();
    await h.handle.db.insert(groupMembers).values([{ groupId: list!.id, userId: alice.id }, { groupId: list!.id, userId: bob.id }]);
    await expect(external({}).sendMail({ from: 'carol@example.org', to: 'team@acme.test', text: 'x' })).rejects.toThrow(/inside the organisation/);
    await h.handle.db.update(groups).set({ allowExternalSenders: true }).where(eq(groups.id, list!.id));
    await external({}).sendMail({ from: 'carol@example.org', to: 'team@acme.test', subject: 'To the team', text: 'x' });
    expect((await inbox(bob.id)).map((m) => m.subject)).toContain('To the team');
    expect((await inbox(alice.id)).map((m) => m.subject)).toContain('To the team');
  });

  it('applies server-side filters', async () => {
    const boxes = await ensureMailboxes(h.ctx, bob.id);
    const archive = boxes.find((b) => b.specialUse === '\\Archive')!;
    await h.handle.db.insert(mailFilters).values({ userId: bob.id, name: 'Invoices', conditions: [{ field: 'subject', op: 'contains', value: 'invoice' }], actions: [{ type: 'move', value: archive.id }, { type: 'markRead' }] });
    await external({}).sendMail({ from: 'billing@example.org', to: 'bob@acme.test', subject: 'Your INVOICE #42', text: 'pay' });
    const [m] = await h.handle.db.select().from(messages).where(and(eq(messages.mailboxId, archive.id), eq(messages.subject, 'Your INVOICE #42')));
    expect(m?.seen).toBe(true);
  });
});

describe('IMAP', () => {
  it('lists special-use folders and fetches messages', async () => {
    const client = await imap('alice@acme.test', 'alice password 123');
    const list = await client.list();
    const byUse = Object.fromEntries(list.map((l) => [l.specialUse, l.path]));
    expect(byUse).toMatchObject({ '\\Inbox': 'INBOX', '\\Sent': 'Sent', '\\Drafts': 'Drafts', '\\Trash': 'Trash', '\\Junk': 'Junk' });

    const lock = await client.getMailboxLock('INBOX');
    try {
      const msg = await client.fetchOne('1', { envelope: true, bodyStructure: true, source: true, flags: true, uid: true });
      expect(msg && msg.envelope?.subject).toBe('Hello Alice');
      expect(msg && msg.envelope?.from?.[0]?.address).toBe('carol@example.org');
      expect(msg && msg.source?.toString()).toContain('First message body');
      expect(msg && msg.bodyStructure?.type).toBe('text/plain');
      // imapflow fetches with BODY.PEEK[], so the message stays unread.
      expect(msg && msg.flags?.has('\\Seen')).toBe(false);
      await client.messageFlagsAdd('1', ['\\Seen']);

      const hits = await client.search({ subject: 'hello' });
      expect(hits).toEqual([1, 2]);
      const unseen = await client.search({ seen: false });
      expect(unseen).not.toContain(1);

      await client.messageFlagsAdd('2', ['\\Flagged', '$Important']);
      const flagged = await client.fetchOne('2', { flags: true });
      expect(flagged && [...flagged.flags!]).toEqual(expect.arrayContaining(['\\Flagged', '$Important']));

      const moved = await client.messageMove('2', 'Archive');
      expect(moved && moved.uidMap?.size).toBe(1);
    } finally {
      lock.release();
    }
    await client.logout();
  });

  it('fetches individual MIME parts of multipart messages', async () => {
    const { raw } = await composeMessage({
      from: { name: 'Dan', address: 'dan@example.org' },
      to: [{ name: '', address: 'alice@acme.test' }],
      subject: 'With attachment',
      html: '<p>See <b>attached</b></p>',
      attachments: [{ filename: 'notes.txt', contentType: 'text/plain', content: Buffer.from('attachment content') }],
    });
    await deliverInbound(h.ctx, { raw, envelopeFrom: 'dan@example.org', recipients: ['alice@acme.test'] });
    const client = await imap('alice', 'alice password 123');
    const lock = await client.getMailboxLock('INBOX');
    try {
      const last = await client.fetchOne('*', { bodyStructure: true, uid: true });
      expect(last && last.bodyStructure?.type).toBe('multipart/mixed');
      const attachmentPart = (last ? last.bodyStructure?.childNodes?.find((n) => n.disposition === 'attachment') : undefined) as { dispositionParameters?: Record<string, string>; part: string } | undefined;
      expect(attachmentPart?.dispositionParameters?.filename).toBe('notes.txt');
      const { content } = await client.download(String(last && last.uid), attachmentPart!.part, { uid: true });
      const chunks: Buffer[] = [];
      for await (const c of content!) chunks.push(c as Buffer);
      expect(Buffer.concat(chunks).toString()).toBe('attachment content');
    } finally {
      lock.release();
    }
    await client.logout();
  });

  it('appends drafts and notifies IDLE sessions of new mail', async () => {
    const client = await imap('alice@acme.test', 'alice password 123');
    const appended = await client.append('Drafts', 'From: alice@acme.test\r\nSubject: draft\r\n\r\nbody', ['\\Draft']);
    expect(appended && appended.uid).toBeGreaterThan(0);

    await client.mailboxOpen('INBOX');
    const before = client.mailbox && client.mailbox.exists;
    const sawExists = new Promise<number>((resolve) => client.on('exists', (e: { count: number }) => resolve(e.count)));
    const idle = client.idle();
    await new Promise((r) => setTimeout(r, 200));
    await external({}).sendMail({ from: 'carol@example.org', to: 'alice@acme.test', subject: 'While idling', text: 'ping' });
    expect(await sawExists).toBe((before as number) + 1);
    await client.noop();
    await idle;
    await client.logout();
  });

  it('requires an app password once MFA is enabled', async () => {
    await h.createUser('erin', 'erin password 123', { totpEnabledAt: new Date() });
    await expect(imap('erin@acme.test', 'erin password 123')).rejects.toThrow();
    const [erin] = await h.handle.db.select().from((await import('@forge/db')).users).where(eq((await import('@forge/db')).users.email, 'erin@acme.test'));
    await h.handle.db.insert(appPasswords).values({ userId: erin!.id, name: 'Thunderbird', passwordHash: await hashPassword('abcdabcdabcdabcd') });
    const client = await imap('erin@acme.test', 'abcd-abcd-abcd-abcd');
    await client.logout();
  });
});

describe('submission and outbound delivery', () => {
  it('delivers locally and relays remote recipients with a DKIM signature', async () => {
    await submit('bob@acme.test', 'bob password 1234').sendMail({ from: 'bob@acme.test', to: ['alice@acme.test', 'zed@remote.example'], subject: 'Lunch?', text: 'Noon?' });
    await h.waitFor(async () => (await inbox(alice.id)).find((m) => m.subject === 'Lunch?'));
    const remote = await h.waitFor(async () => h.relay.received.find((r) => r.to.includes('zed@remote.example')));
    expect(remote.from).toBe('bob@acme.test');
    expect(remote.raw.toString()).toMatch(/^DKIM-Signature:[\s\S]*?d=acme\.test;[\s\S]*?s=forge;/m);
    const [out] = await h.handle.db.select().from(outboundMessages).where(eq(outboundMessages.subject, 'Lunch?'));
    await h.waitFor(async () => (await h.handle.db.select().from(outboundMessages).where(eq(outboundMessages.id, out!.id)))[0]?.status === 'sent');
  });

  it('refuses to send as someone else', async () => {
    await expect(submit('bob@acme.test', 'bob password 1234').sendMail({ from: 'alice@acme.test', to: 'x@remote.example', text: 'spoof' })).rejects.toThrow(/not allowed|own addresses/);
    await expect(
      submit('bob@acme.test', 'bob password 1234').sendMail({ envelope: { from: 'bob@acme.test', to: ['x@remote.example'] }, from: 'alice@acme.test', to: 'x@remote.example', text: 'spoof' }),
    ).rejects.toThrow(/own addresses/);
  });

  it('sends out-of-office replies once per sender', async () => {
    await h.handle.db.insert(autoReplies).values({ userId: bob.id, enabled: true, subject: 'Away', body: 'Back Monday' });
    const before = h.relay.received.length;
    for (let i = 0; i < 2; i++) await external({}).sendMail({ from: 'frank@example.org', to: 'bob@acme.test', subject: `Question ${i}`, text: '?' });
    const reply = await h.waitFor(async () => h.relay.received.slice(before).find((r) => r.to.includes('frank@example.org')));
    expect(reply.from).toBe('');
    expect(reply.raw.toString()).toMatch(/Auto-Submitted: auto-replied/);
    await new Promise((r) => setTimeout(r, 300));
    expect(h.relay.received.slice(before).filter((r) => r.to.includes('frank@example.org'))).toHaveLength(1);
  });
});

describe('calendar messages', () => {
  it('adds external invitations to the calendar and lets rooms auto-accept', async () => {
    const ics = buildEventIcs(
      {
        uid: 'ext-1@example.org',
        summary: 'Partner sync',
        start: new Date('2030-01-10T10:00:00Z'),
        end: new Date('2030-01-10T11:00:00Z'),
        organizer: { email: 'olga@example.org', name: 'Olga' },
        attendees: [{ email: 'alice@acme.test' }, { email: 'room-1@acme.test', cutype: 'ROOM' }],
      },
      'REQUEST',
    );
    await h.handle.db.insert(resources).values({ orgId: h.orgId, name: 'Room 1', email: 'room-1@acme.test' });
    const { raw } = await composeMessage({
      from: { name: 'Olga', address: 'olga@example.org' },
      to: [{ name: '', address: 'alice@acme.test' }, { name: '', address: 'room-1@acme.test' }],
      subject: 'Invitation: Partner sync',
      text: 'Join us',
      calendar: { method: 'REQUEST', content: ics },
    });
    const before = h.relay.received.length;
    await deliverInbound(h.ctx, { raw, envelopeFrom: 'olga@example.org', recipients: ['alice@acme.test', 'room-1@acme.test'] });
    const objs = await h.handle.db.select().from(calendarObjects).where(eq(calendarObjects.uid, 'ext-1@example.org'));
    expect(objs).toHaveLength(2); // Alice's calendar and the room's calendar
    const reply = await h.waitFor(async () => h.relay.received.slice(before).find((r) => r.to.includes('olga@example.org')));
    expect(reply.raw.toString()).toMatch(/METHOD:REPLY/);
    expect(reply.raw.toString()).toMatch(/PARTSTAT=ACCEPTED/);
  });
});

describe('mailboxes', () => {
  it('creates, renames and deletes folders over IMAP', async () => {
    const client = await imap('alice@acme.test', 'alice password 123');
    await client.mailboxCreate('Projects/Ünïcode');
    await client.mailboxRename('Projects/Ünïcode', 'Projects/Renamed');
    const paths = (await client.list()).map((l) => l.path);
    expect(paths).toContain('Projects/Renamed');
    await client.mailboxDelete('Projects/Renamed');
    const rows = await h.handle.db.select().from(mailboxes).where(eq(mailboxes.userId, alice.id));
    expect(rows.map((r) => r.path)).not.toContain('Projects/Renamed');
    await client.logout();
  });
});
