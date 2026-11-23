import { ImapFlow } from 'imapflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTask, ensureTaskLists, findByUid, flagTaskUid, nextDue, parseTask, putCalendarObject, deleteCalendarObject } from '@forge/calendar';
import { messages, orm } from '@forge/db';
import { applyFlagTaskChange, composeMessage, deliverInbound, ensureMailboxes, expungeMessages, moveMessages, setFlags } from '../src';
import { startHarness, type Harness } from './harness';

const { eq } = orm;

let h: Harness;
let alice: Awaited<ReturnType<Harness['createUser']>>;

async function deliver(subject: string) {
  const { raw } = await composeMessage({ from: { name: 'Pat Client', address: 'pat@client.example' }, to: [{ name: '', address: 'alice@acme.test' }], subject, text: 'Please review' });
  await deliverInbound(h.ctx, { raw, envelopeFrom: 'pat@client.example', recipients: ['alice@acme.test'] });
  const [m] = await h.handle.db.select().from(messages).where(eq(messages.subject, subject));
  return m!;
}

async function taskFor(messageId: string) {
  const { flagged } = await ensureTaskLists(h.handle.db, alice);
  const obj = await findByUid(h.handle.db, [flagged.id], flagTaskUid(messageId));
  return obj ? { obj, task: parseTask(obj.ics) } : null;
}

beforeAll(async () => {
  h = await startHarness();
  alice = await h.createUser('alice', 'alice password 123');
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe('task model', () => {
  it('round-trips fields and keeps unknown properties', () => {
    const ics = buildTask({ title: 'Send report', notes: 'Q3 numbers', due: '2026-12-01', reminder: '2026-11-30T09:00:00.000Z', importance: 'high', repeat: 'monthly', status: 'NEEDS-ACTION' });
    expect(parseTask(ics)).toMatchObject({ title: 'Send report', notes: 'Q3 numbers', due: '2026-12-01', reminder: '2026-11-30T09:00:00.000Z', importance: 'high', repeat: 'monthly', status: 'NEEDS-ACTION' });
    const withX = ics.replace('END:VTODO', 'X-APPLE-SORT-ORDER:42\r\nEND:VTODO');
    const done = buildTask({ status: 'COMPLETED' }, withX);
    expect(parseTask(done)).toMatchObject({ status: 'COMPLETED', title: 'Send report' });
    expect(done).toContain('X-APPLE-SORT-ORDER:42');
    expect(parseTask(buildTask({ status: 'NEEDS-ACTION' }, done)).completedAt).toBeNull();
  });

  it('works out the next due date of repeating tasks', () => {
    expect(nextDue('2026-01-31', 'monthly')).toBe('2026-02-28');
    expect(nextDue('2026-11-20', 'weekdays')).toBe('2026-11-23');
    expect(nextDue('2028-02-29', 'yearly')).toBe('2029-02-28');
  });
});

describe('flagged email', () => {
  it('flagging creates a task; unflagging completes it; reflagging reopens it', async () => {
    const m = await deliver('Contract review');
    expect(await taskFor(m.id)).toBeNull();
    await setFlags(h.ctx, alice.id, [m.id], { flagged: true });
    const created = await taskFor(m.id);
    expect(created!.task).toMatchObject({ title: 'Contract review', status: 'NEEDS-ACTION', messageId: m.id, from: 'Pat Client <pat@client.example>' });
    await setFlags(h.ctx, alice.id, [m.id], { flagged: false });
    expect((await taskFor(m.id))!.task.status).toBe('COMPLETED');
    await setFlags(h.ctx, alice.id, [m.id], { flagged: true });
    expect((await taskFor(m.id))!.task.status).toBe('NEEDS-ACTION');
  });

  it('works for flags set by IMAP apps and survives moving the message', async () => {
    const m = await deliver('From the phone');
    const c = new ImapFlow({ host: '127.0.0.1', port: h.ports.imap, secure: false, doSTARTTLS: false, auth: { user: 'alice@acme.test', pass: 'alice password 123' }, logger: false });
    await c.connect();
    await c.mailboxOpen('INBOX');
    const uid = (await c.search({ subject: 'From the phone' }, { uid: true })) as number[];
    await c.messageFlagsAdd(uid, ['\\Flagged'], { uid: true });
    await c.logout();
    expect((await taskFor(m.id))!.task.status).toBe('NEEDS-ACTION');
    const archive = (await ensureMailboxes(h.ctx, alice.id)).find((b) => b.specialUse === '\\Archive') ?? (await ensureMailboxes(h.ctx, alice.id)).find((b) => b.specialUse === '\\Trash')!;
    await moveMessages(h.ctx, alice.id, [m.id], archive.id);
    await setFlags(h.ctx, alice.id, [m.id], { flagged: false });
    expect((await taskFor(m.id))!.task.status).toBe('COMPLETED');
  });

  it('completing, reopening or deleting the task updates the message flag', async () => {
    const m = await deliver('Invoice 1042');
    await setFlags(h.ctx, alice.id, [m.id], { flagged: true });
    const { obj } = (await taskFor(m.id))!;
    const flagOf = async () => (await h.handle.db.select().from(messages).where(eq(messages.id, m.id)))[0]!.flagged;

    const done = buildTask({ status: 'COMPLETED' }, obj.ics);
    await putCalendarObject(h.handle.db, obj.calendarId, obj.href, done);
    await applyFlagTaskChange(h.ctx, alice.id, obj.uid, done);
    expect(await flagOf()).toBe(false);

    const reopened = buildTask({ status: 'NEEDS-ACTION' }, done);
    await putCalendarObject(h.handle.db, obj.calendarId, obj.href, reopened);
    await applyFlagTaskChange(h.ctx, alice.id, obj.uid, reopened);
    expect(await flagOf()).toBe(true);

    await deleteCalendarObject(h.handle.db, obj.calendarId, obj.href);
    await applyFlagTaskChange(h.ctx, alice.id, obj.uid, null);
    expect(await flagOf()).toBe(false);
  });

  it('deleting the message removes its task', async () => {
    const m = await deliver('Old thread');
    await setFlags(h.ctx, alice.id, [m.id], { flagged: true });
    expect(await taskFor(m.id)).not.toBeNull();
    await expungeMessages(h.ctx, alice.id, [m.id]);
    expect(await taskFor(m.id)).toBeNull();
  });
});
