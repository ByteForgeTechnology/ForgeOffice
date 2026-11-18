import { createTransport } from 'nodemailer';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mailboxes, messages, orm, senderLists } from '@forge/db';
import { ensureMailboxes, matchSenderList, normaliseSenderEntry } from '../src';
import { startHarness, type Harness } from './harness';

const { eq } = orm;

let h: Harness;
let alice: Awaited<ReturnType<Harness['createUser']>>;
let bob: Awaited<ReturnType<Harness['createUser']>>;

const external = () => createTransport({ host: '127.0.0.1', port: h.ports.smtp, secure: false, ignoreTLS: true } as never);
// Scores well above the spam threshold: spam phrase + executable attachment.
const spammy = (from: string, to: string, subject: string) =>
  external().sendMail({ from, to, subject, text: 'You are a lottery winner', attachments: [{ filename: 'claim.exe', content: 'MZ' }] });

async function folderOf(userId: string, subject: string) {
  await ensureMailboxes(h.ctx, userId);
  const [row] = await h.handle.db
    .select({ path: mailboxes.path })
    .from(messages)
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .where(eq(messages.subject, subject));
  return row?.path;
}

const add = (list: 'block' | 'allow', entry: string, userId: string | null = null) => h.handle.db.insert(senderLists).values({ orgId: h.orgId, userId, list, entry });

beforeAll(async () => {
  h = await startHarness();
  alice = await h.createUser('alice', 'alice password 123');
  bob = await h.createUser('bob', 'bob password 1234');
}, 60_000);

beforeEach(async () => {
  await h.handle.db.delete(senderLists);
});

afterAll(async () => {
  await h?.close();
});

describe('entries', () => {
  it('normalise addresses and domains', () => {
    expect(normaliseSenderEntry(' Spam@Example.COM ')).toBe('spam@example.com');
    expect(normaliseSenderEntry('<a@b.io>')).toBe('a@b.io');
    expect(normaliseSenderEntry('*@example.com')).toBe('example.com');
    expect(normaliseSenderEntry('@example.com')).toBe('example.com');
    expect(normaliseSenderEntry('*.example.com')).toBe('example.com');
    expect(normaliseSenderEntry('xyz')).toBe('xyz');
    expect(normaliseSenderEntry('not an address')).toBeNull();
    expect(normaliseSenderEntry('a@')).toBeNull();
  });

  it('pick the most specific match; any block wins', () => {
    const lists = [
      { list: 'block' as const, entry: 'example.com' },
      { list: 'allow' as const, entry: 'boss@example.com' },
      { list: 'allow' as const, entry: 'news.example.com' },
    ];
    expect(matchSenderList(lists, ['x@example.com'])?.list).toBe('block');
    expect(matchSenderList(lists, ['x@mail.example.com'])?.list).toBe('block');
    expect(matchSenderList(lists, ['boss@example.com'])?.list).toBe('allow');
    expect(matchSenderList(lists, ['x@news.example.com'])?.list).toBe('allow');
    expect(matchSenderList(lists, ['boss@example.com', 'bounce@example.com'])?.list).toBe('block');
    expect(matchSenderList(lists, ['x@other.org'])).toBeNull();
  });
});

describe('organisation lists', () => {
  it('refuse blocked senders at SMTP, except more specific allows', async () => {
    await add('block', 'badcorp.example');
    await add('allow', 'billing@badcorp.example');
    await expect(external().sendMail({ from: 'x@mail.badcorp.example', to: 'alice@acme.test', subject: 'Blocked', text: 'x' })).rejects.toThrow(/does not accept mail from this sender/);
    await external().sendMail({ from: 'billing@badcorp.example', to: 'alice@acme.test', subject: 'Invoice', text: 'x' });
    expect(await folderOf(alice.id, 'Invoice')).toBe('INBOX');
  });

  it('let allowed senders skip spam filtering', async () => {
    await spammy('promo@unknown.example', 'alice@acme.test', 'Spam one');
    expect(await folderOf(alice.id, 'Spam one')).toBe('Junk');
    await add('allow', 'partner.example');
    await spammy('ops@partner.example', 'alice@acme.test', 'Partner tool');
    expect(await folderOf(alice.id, 'Partner tool')).toBe('INBOX');
  });
});

describe('mailbox lists', () => {
  it('send blocked senders to Junk for that mailbox only', async () => {
    await add('block', 'newsletter@shop.example', alice.id);
    await external().sendMail({ from: 'newsletter@shop.example', to: ['alice@acme.test', 'bob@acme.test'], subject: 'Sale', text: 'x' });
    const rows = await h.handle.db
      .select({ userId: messages.userId, path: mailboxes.path })
      .from(messages)
      .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
      .where(eq(messages.subject, 'Sale'));
    expect(rows.find((r) => r.userId === alice.id)?.path).toBe('Junk');
    expect(rows.find((r) => r.userId === bob.id)?.path).toBe('INBOX');
  });

  it('keep allowed senders out of Junk', async () => {
    await add('allow', 'friend.example', bob.id);
    await spammy('pal@friend.example', 'bob@acme.test', 'From a friend');
    expect(await folderOf(bob.id, 'From a friend')).toBe('INBOX');
  });

  it('a mailbox block overrides an organisation allow', async () => {
    await add('allow', 'vendor.example');
    await add('block', 'vendor.example', alice.id);
    await external().sendMail({ from: 'sales@vendor.example', to: 'alice@acme.test', subject: 'Pitch', text: 'x' });
    expect(await folderOf(alice.id, 'Pitch')).toBe('Junk');
  });
});
