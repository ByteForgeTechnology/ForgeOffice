import { randomInt, randomUUID } from 'node:crypto';
import { removeFlagTasks, syncFlagTasks } from './flag-tasks';
import { blobs, mailboxes, messages, orm, organizations, users, type Mailbox, type MailAddress, type Message } from '@forge/db';
import { notifyMailChanged, type MailContext } from './context';
import { indexMessage, type IndexedMessage } from './ingest';
import { normaliseLineEndings } from './mime';

const { and, asc, eq, inArray, sql } = orm;

export type SpecialUse = '\\Inbox' | '\\Drafts' | '\\Sent' | '\\Junk' | '\\Trash' | '\\Archive';

export const DEFAULT_MAILBOXES: { path: string; specialUse: SpecialUse }[] = [
  { path: 'INBOX', specialUse: '\\Inbox' },
  { path: 'Drafts', specialUse: '\\Drafts' },
  { path: 'Sent', specialUse: '\\Sent' },
  { path: 'Archive', specialUse: '\\Archive' },
  { path: 'Junk', specialUse: '\\Junk' },
  { path: 'Trash', specialUse: '\\Trash' },
];

export class QuotaExceededError extends Error {
  constructor() {
    super('Mailbox is full');
    this.name = 'QuotaExceededError';
  }
}

export class MailboxNotFoundError extends Error {
  constructor() {
    super('Mailbox not found');
    this.name = 'MailboxNotFoundError';
  }
}

export const newUidValidity = () => randomInt(1, 2 ** 31 - 1);

/** Create any missing default folders for a user and return all their mailboxes. */
export async function ensureMailboxes(ctx: Pick<MailContext, 'db'>, userId: string): Promise<Mailbox[]> {
  const existing = await ctx.db.select().from(mailboxes).where(eq(mailboxes.userId, userId)).orderBy(asc(mailboxes.path));
  const missing = DEFAULT_MAILBOXES.filter((d) => !existing.some((m) => m.specialUse === d.specialUse || m.path.toLowerCase() === d.path.toLowerCase()));
  if (!missing.length) return existing;
  await ctx.db
    .insert(mailboxes)
    .values(missing.map((m) => ({ userId, path: m.path, specialUse: m.specialUse, uidValidity: newUidValidity() })))
    .onConflictDoNothing();
  return ctx.db.select().from(mailboxes).where(eq(mailboxes.userId, userId)).orderBy(asc(mailboxes.path));
}

export async function specialMailbox(ctx: Pick<MailContext, 'db'>, userId: string, use: SpecialUse): Promise<Mailbox> {
  const all = await ensureMailboxes(ctx, userId);
  const box = all.find((m) => m.specialUse === use);
  if (!box) throw new MailboxNotFoundError();
  return box;
}

export async function retainBlob(ctx: Pick<MailContext, 'db' | 'blobs'>, raw: Buffer): Promise<{ sha256: string; size: number }> {
  const { sha256, size } = await ctx.blobs.put(raw);
  await ctx.db
    .insert(blobs)
    .values({ sha256, volume: 'mail', size, mime: 'message/rfc822', refCount: 1 })
    .onConflictDoUpdate({ target: blobs.sha256, set: { refCount: sql`${blobs.refCount} + 1` } });
  return { sha256, size };
}

export async function releaseBlob(ctx: Pick<MailContext, 'db' | 'blobs'>, sha256: string): Promise<void> {
  const [row] = await ctx.db
    .update(blobs)
    .set({ refCount: sql`greatest(${blobs.refCount} - 1, 0)` })
    .where(eq(blobs.sha256, sha256))
    .returning();
  if (row && row.refCount === 0) {
    await ctx.db.delete(blobs).where(eq(blobs.sha256, sha256));
    await ctx.blobs.delete(sha256);
  }
}

/** Allocate the next UID and modseq atomically. */
async function allocateUid(ctx: Pick<MailContext, 'db'>, mailboxId: string): Promise<{ uid: number; modseq: number }> {
  const [row] = await ctx.db
    .update(mailboxes)
    .set({ uidNext: sql`${mailboxes.uidNext} + 1`, modseq: sql`${mailboxes.modseq} + 1` })
    .where(eq(mailboxes.id, mailboxId))
    .returning({ uidNext: mailboxes.uidNext, modseq: mailboxes.modseq });
  if (!row) throw new MailboxNotFoundError();
  return { uid: row.uidNext - 1, modseq: row.modseq };
}

async function bumpModseq(ctx: Pick<MailContext, 'db'>, mailboxId: string): Promise<number> {
  const [row] = await ctx.db
    .update(mailboxes)
    .set({ modseq: sql`${mailboxes.modseq} + 1` })
    .where(eq(mailboxes.id, mailboxId))
    .returning({ modseq: mailboxes.modseq });
  return row?.modseq ?? 0;
}

async function threadFor(ctx: Pick<MailContext, 'db'>, userId: string, idx: Pick<IndexedMessage, 'messageId' | 'inReplyTo' | 'references'>): Promise<string> {
  const ids = [...new Set([...idx.references, ...(idx.inReplyTo ? [idx.inReplyTo] : [])])].slice(-50);
  if (ids.length) {
    const [parent] = await ctx.db
      .select({ threadId: messages.threadId })
      .from(messages)
      .where(and(eq(messages.userId, userId), inArray(messages.messageId, ids)))
      .limit(1);
    if (parent) return parent.threadId;
  }
  if (idx.messageId) {
    // A reply may have arrived before its parent (or the parent was re-imported).
    const [child] = await ctx.db
      .select({ threadId: messages.threadId })
      .from(messages)
      .where(and(eq(messages.userId, userId), sql`(${messages.inReplyTo} = ${idx.messageId} or ${messages.references} @> ${JSON.stringify([idx.messageId])}::jsonb)`))
      .limit(1);
    if (child) return child.threadId;
  }
  return randomUUID();
}

export async function userQuota(ctx: Pick<MailContext, 'db'>, userId: string): Promise<{ used: number; quota: number }> {
  const [row] = await ctx.db
    .select({ used: users.usedBytes, own: users.quotaBytes, def: organizations.defaultQuotaBytes })
    .from(users)
    .innerJoin(organizations, eq(organizations.id, users.orgId))
    .where(eq(users.id, userId))
    .limit(1);
  return { used: row?.used ?? 0, quota: row?.own ?? row?.def ?? 0 };
}

export interface AppendOptions {
  userId: string;
  mailboxId: string;
  raw: Buffer;
  seen?: boolean;
  flagged?: boolean;
  answered?: boolean;
  draft?: boolean;
  keywords?: string[];
  internalDate?: Date;
  indexed?: IndexedMessage;
  /** Values that are not in the raw message (e.g. Bcc of sent mail). */
  bcc?: MailAddress[];
  spamScore?: number | null;
  authResults?: Record<string, unknown> | null;
  /** Skip the quota check (system copies such as bounces). */
  ignoreQuota?: boolean;
}

/** Store a message in a mailbox: blob on disk, metadata and search index in the database. */
export async function appendMessage(ctx: Pick<MailContext, 'db' | 'blobs' | 'bus' | 'events'>, opts: AppendOptions): Promise<Message> {
  const raw = normaliseLineEndings(opts.raw);
  if (!opts.ignoreQuota) {
    const q = await userQuota(ctx, opts.userId);
    if (q.quota > 0 && q.used + raw.length > q.quota) throw new QuotaExceededError();
  }
  const idx = opts.indexed ?? (await indexMessage(raw));
  const { sha256 } = await retainBlob(ctx, raw);
  try {
    const threadId = await threadFor(ctx, opts.userId, idx);
    const { uid, modseq } = await allocateUid(ctx, opts.mailboxId);
    const participants = [idx.from, ...idx.to, ...idx.cc, ...(opts.bcc ?? idx.bcc)].filter(Boolean) as MailAddress[];
    const [row] = await ctx.db
      .insert(messages)
      .values({
        userId: opts.userId,
        mailboxId: opts.mailboxId,
        uid,
        modseq,
        blobSha: sha256,
        size: raw.length,
        internalDate: opts.internalDate ?? new Date(),
        seen: opts.seen ?? false,
        flagged: opts.flagged ?? false,
        answered: opts.answered ?? false,
        draft: opts.draft ?? false,
        keywords: opts.keywords ?? [],
        messageId: idx.messageId,
        inReplyTo: idx.inReplyTo,
        references: idx.references,
        threadId,
        subject: idx.subject,
        fromAddr: idx.from,
        toAddrs: idx.to,
        ccAddrs: idx.cc,
        bccAddrs: opts.bcc ?? idx.bcc,
        replyTo: idx.replyTo,
        sentAt: idx.sentAt,
        snippet: idx.snippet,
        bodyText: idx.bodyText,
        hasAttachments: idx.attachments.some((a) => !a.inline),
        attachments: idx.attachments,
        mimeTree: idx.tree,
        searchAddresses: participants.map((p) => `${p.name} ${p.address}`).join(' '),
        spamScore: opts.spamScore ?? null,
        authResults: opts.authResults ?? null,
      })
      .returning();
    await ctx.db.update(users).set({ usedBytes: sql`${users.usedBytes} + ${raw.length}` }).where(eq(users.id, opts.userId));
    notifyMailChanged(ctx as MailContext, opts.userId, opts.mailboxId);
    if (row!.flagged) await syncFlagTasks(ctx as MailContext, [row!]);
    return row!;
  } catch (err) {
    await releaseBlob(ctx, sha256);
    throw err;
  }
}

export interface FlagChange {
  seen?: boolean;
  flagged?: boolean;
  answered?: boolean;
  draft?: boolean;
  deleted?: boolean;
  /** Replace keywords entirely. */
  keywords?: string[];
  addKeywords?: string[];
  removeKeywords?: string[];
}

/** Update flags on messages (all must belong to `userId`). Returns updated rows. */
export async function setFlags(ctx: Pick<MailContext, 'db' | 'bus' | 'events'>, userId: string, ids: string[], change: FlagChange): Promise<Message[]> {
  if (!ids.length) return [];
  const rows = await ctx.db.select().from(messages).where(and(eq(messages.userId, userId), inArray(messages.id, ids)));
  const updated: Message[] = [];
  const byBox = new Map<string, Message[]>();
  for (const r of rows) byBox.set(r.mailboxId, [...(byBox.get(r.mailboxId) ?? []), r]);
  for (const [mailboxId, list] of byBox) {
    const modseq = await bumpModseq(ctx, mailboxId);
    for (const m of list) {
      let keywords = change.keywords ?? m.keywords;
      if (change.addKeywords) keywords = [...new Set([...keywords, ...change.addKeywords])];
      if (change.removeKeywords) keywords = keywords.filter((k) => !change.removeKeywords!.includes(k));
      const [u] = await ctx.db
        .update(messages)
        .set({
          ...(change.seen !== undefined && { seen: change.seen }),
          ...(change.flagged !== undefined && { flagged: change.flagged }),
          ...(change.answered !== undefined && { answered: change.answered }),
          ...(change.draft !== undefined && { draft: change.draft }),
          ...(change.deleted !== undefined && { deleted: change.deleted }),
          keywords,
          modseq,
        })
        .where(eq(messages.id, m.id))
        .returning();
      if (u) updated.push(u);
    }
    notifyMailChanged(ctx as MailContext, userId, mailboxId);
  }
  // Flag changes create, complete or reopen the message's task.
  if (change.flagged !== undefined) {
    const before = new Map(rows.map((r) => [r.id, r.flagged]));
    await syncFlagTasks(ctx as MailContext, updated.filter((u) => before.get(u.id) !== u.flagged));
  }
  return updated;
}

/** Move messages to another mailbox of the same user. Returns [oldUid, newUid] pairs. */
export async function moveMessages(ctx: Pick<MailContext, 'db' | 'bus' | 'events'>, userId: string, ids: string[], targetMailboxId: string): Promise<{ id: string; fromUid: number; toUid: number; fromMailboxId: string }[]> {
  const [target] = await ctx.db.select().from(mailboxes).where(and(eq(mailboxes.id, targetMailboxId), eq(mailboxes.userId, userId))).limit(1);
  if (!target) throw new MailboxNotFoundError();
  const rows = await ctx.db
    .select({ id: messages.id, uid: messages.uid, mailboxId: messages.mailboxId })
    .from(messages)
    .where(and(eq(messages.userId, userId), inArray(messages.id, ids)))
    .orderBy(asc(messages.uid));
  const out: { id: string; fromUid: number; toUid: number; fromMailboxId: string }[] = [];
  const sources = new Set<string>();
  for (const r of rows) {
    if (r.mailboxId === targetMailboxId) continue;
    const { uid, modseq } = await allocateUid(ctx, targetMailboxId);
    await ctx.db.update(messages).set({ mailboxId: targetMailboxId, uid, modseq, deleted: false }).where(eq(messages.id, r.id));
    sources.add(r.mailboxId);
    out.push({ id: r.id, fromUid: r.uid, toUid: uid, fromMailboxId: r.mailboxId });
  }
  for (const s of sources) {
    await bumpModseq(ctx, s);
    notifyMailChanged(ctx as MailContext, userId, s);
  }
  if (out.length) notifyMailChanged(ctx as MailContext, userId, targetMailboxId);
  return out;
}

/** Copy messages into another mailbox (shares the blob; counts against quota). */
export async function copyMessages(ctx: Pick<MailContext, 'db' | 'blobs' | 'bus' | 'events'>, userId: string, ids: string[], targetMailboxId: string): Promise<{ fromUid: number; toUid: number }[]> {
  const [target] = await ctx.db.select().from(mailboxes).where(and(eq(mailboxes.id, targetMailboxId), eq(mailboxes.userId, userId))).limit(1);
  if (!target) throw new MailboxNotFoundError();
  const rows = await ctx.db.select().from(messages).where(and(eq(messages.userId, userId), inArray(messages.id, ids))).orderBy(asc(messages.uid));
  const total = rows.reduce((n, r) => n + r.size, 0);
  const q = await userQuota(ctx, userId);
  if (q.quota > 0 && q.used + total > q.quota) throw new QuotaExceededError();
  const out: { fromUid: number; toUid: number }[] = [];
  const flaggedCopies: Message[] = [];
  for (const r of rows) {
    const { uid, modseq } = await allocateUid(ctx, targetMailboxId);
    const { id: _id, searchVector: _sv, createdAt: _c, ...rest } = r;
    const [copy] = await ctx.db.insert(messages).values({ ...rest, mailboxId: targetMailboxId, uid, modseq, deleted: false }).returning();
    if (copy?.flagged) flaggedCopies.push(copy);
    await ctx.db.update(blobs).set({ refCount: sql`${blobs.refCount} + 1` }).where(eq(blobs.sha256, r.blobSha));
    out.push({ fromUid: r.uid, toUid: uid });
  }
  if (total) await ctx.db.update(users).set({ usedBytes: sql`${users.usedBytes} + ${total}` }).where(eq(users.id, userId));
  if (out.length) notifyMailChanged(ctx as MailContext, userId, targetMailboxId);
  await syncFlagTasks(ctx as MailContext, flaggedCopies);
  return out;
}

/** Permanently remove messages, releasing their blobs and quota. */
export async function expungeMessages(ctx: Pick<MailContext, 'db' | 'blobs' | 'bus' | 'events'>, userId: string, ids: string[]): Promise<Message[]> {
  if (!ids.length) return [];
  const removed = await ctx.db
    .delete(messages)
    .where(and(eq(messages.userId, userId), inArray(messages.id, ids)))
    .returning();
  const total = removed.reduce((n, r) => n + r.size, 0);
  if (total) await ctx.db.update(users).set({ usedBytes: sql`greatest(${users.usedBytes} - ${total}, 0)` }).where(eq(users.id, userId));
  for (const r of removed) await releaseBlob(ctx, r.blobSha);
  for (const box of new Set(removed.map((r) => r.mailboxId))) {
    await bumpModseq(ctx, box);
    notifyMailChanged(ctx as MailContext, userId, box);
  }
  await removeFlagTasks(ctx as MailContext, removed);
  return removed;
}

export async function readRaw(ctx: Pick<MailContext, 'blobs'>, message: Pick<Message, 'blobSha'>): Promise<Buffer> {
  return ctx.blobs.read(message.blobSha);
}

export const MAILBOX_NAME_RE = /^[^\\%*"\x00-\x1f]{1,200}$/;

export async function createMailbox(ctx: Pick<MailContext, 'db'>, userId: string, path: string): Promise<Mailbox> {
  const clean = path.replace(/^\/+|\/+$/g, '');
  if (!MAILBOX_NAME_RE.test(clean) || clean.toUpperCase() === 'INBOX') throw new Error('Invalid mailbox name');
  const [row] = await ctx.db.insert(mailboxes).values({ userId, path: clean, uidValidity: newUidValidity() }).returning();
  return row!;
}

/** Rename a mailbox and its children. INBOX and special folders keep their role. */
export async function renameMailbox(ctx: Pick<MailContext, 'db' | 'bus' | 'events'>, userId: string, mailboxId: string, newPath: string): Promise<void> {
  const clean = newPath.replace(/^\/+|\/+$/g, '');
  if (!MAILBOX_NAME_RE.test(clean) || clean.toUpperCase() === 'INBOX') throw new Error('Invalid mailbox name');
  const [box] = await ctx.db.select().from(mailboxes).where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.userId, userId))).limit(1);
  if (!box) throw new MailboxNotFoundError();
  if (box.specialUse === '\\Inbox') throw new Error('INBOX cannot be renamed');
  const all = await ctx.db.select().from(mailboxes).where(eq(mailboxes.userId, userId));
  for (const m of all) {
    if (m.id === box.id) await ctx.db.update(mailboxes).set({ path: clean, uidValidity: newUidValidity() }).where(eq(mailboxes.id, m.id));
    else if (m.path.startsWith(box.path + '/')) {
      await ctx.db
        .update(mailboxes)
        .set({ path: clean + m.path.slice(box.path.length), uidValidity: newUidValidity() })
        .where(eq(mailboxes.id, m.id));
    }
  }
  notifyMailChanged(ctx as MailContext, userId);
}

export async function deleteMailbox(ctx: Pick<MailContext, 'db' | 'blobs' | 'bus' | 'events'>, userId: string, mailboxId: string): Promise<void> {
  const [box] = await ctx.db.select().from(mailboxes).where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.userId, userId))).limit(1);
  if (!box) throw new MailboxNotFoundError();
  if (box.specialUse) throw new Error('System folders cannot be deleted');
  const all = await ctx.db.select().from(mailboxes).where(eq(mailboxes.userId, userId));
  const doomed = all.filter((m) => m.id === box.id || m.path.startsWith(box.path + '/'));
  for (const m of doomed) {
    const ids = await ctx.db.select({ id: messages.id }).from(messages).where(eq(messages.mailboxId, m.id));
    await expungeMessages(ctx, userId, ids.map((r) => r.id));
    await ctx.db.delete(mailboxes).where(eq(mailboxes.id, m.id));
  }
  notifyMailChanged(ctx as MailContext, userId);
}
