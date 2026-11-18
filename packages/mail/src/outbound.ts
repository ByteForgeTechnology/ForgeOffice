import { resolveMx } from 'node:dns/promises';
import { createTransport } from 'nodemailer';
import type { PartStat } from '@forge/calendar';
import { domains, messages, orm, outboundMessages, users, type MailAddress, type OutboundMessage, type OutboundRecipient } from '@forge/db';
import { normaliseAddress, splitAddress } from './addresses';
import { composeMessage } from './compose';
import type { MailContext } from './context';
import { deliverInbound } from './delivery';
import { signMessage } from './dkim';
import { headerBlock, headerValue, normaliseLineEndings, parseHeaderBlock, parseMimeTree } from './mime';
import { isLocalDomain } from './routing';
import { indexMessage } from './ingest';
import { appendDisclaimer, applyTransportRules, TransportRejectedError } from './transport';
import { renderSignatureFor } from './signature';
import { quarantine } from '@forge/db';
import { appendMessage, moveMessages, releaseBlob, retainBlob, setFlags, specialMailbox } from './store';

const { and, eq, inArray } = orm;

export const MAX_DELIVERY_ATTEMPTS = 8;

export interface SubmitInput {
  userId: string | null;
  raw: Buffer;
  envelopeFrom: string;
  recipients: string[];
  /** Hold the message (undo send / scheduled send). */
  delayMs?: number;
  /** Save a copy in a Sent folder: the sender's, or `ownerId`'s (shared mailbox). */
  saveToSent?: { bcc?: MailAddress[]; ownerId?: string };
  source: OutboundMessage['source'];
  /** DKIM-sign with the From domain key (default true). */
  sign?: boolean;
}

/** Accept a message for delivery: sign, store, record recipients and schedule the send. */
export async function submitMessage(ctx: MailContext, input: SubmitInput): Promise<OutboundMessage> {
  let raw = normaliseLineEndings(input.raw);
  let rcpts = [...new Set(input.recipients.map(normaliseAddress))];

  // Transport rules apply to mail people send (not to bounces, auto-replies and other system mail),
  // before DKIM signing so header/disclaimer edits keep the signature valid.
  let held: string | null = null;
  // Organisation signatures marked "also for desktop and phone apps" are added to SMTP submissions.
  if (input.source === 'smtp' && input.userId) raw = await addAppSignature(ctx, input.userId, raw);
  if (input.source !== 'system') {
    const local = await Promise.all(rcpts.map((r) => isLocalDomain(ctx, splitAddress(r).domain)));
    const idx = await indexMessage(raw);
    const outcome = await applyTransportRules(ctx, {
      direction: local.every(Boolean) ? 'internal' : 'outbound',
      envelopeFrom: input.envelopeFrom,
      recipients: rcpts,
      raw,
      idx,
    });
    if (outcome.reject) throw new TransportRejectedError(outcome.reject);
    if (outcome.drop) held = 'Deleted by a transport rule';
    else if (outcome.quarantine) {
      held = `Held for review (${outcome.quarantine})`;
      const stored = await retainBlob(ctx, raw);
      await ctx.db.insert(quarantine).values({
        blobSha: stored.sha256,
        size: stored.size,
        envelopeFrom: input.envelopeFrom,
        recipients: rcpts,
        fromHeader: idx.from ? `${idx.from.name} <${idx.from.address}>` : input.envelopeFrom,
        subject: idx.subject,
        reason: outcome.quarantine,
      });
    }
    raw = outcome.raw;
    rcpts = outcome.recipients;
  }

  const tree = parseMimeTree(raw);
  const fields = parseHeaderBlock(headerBlock(raw, tree));
  const fromHeader = headerValue(fields, 'from') ?? '';
  const fromDomain = /@([^>\s]+)/.exec(fromHeader)?.[1] ?? '';
  if (input.sign !== false && fromDomain) raw = await signMessage(ctx, raw, fromDomain);

  const recipients: OutboundRecipient[] = [];
  for (const r of rcpts) {
    recipients.push({ address: r, local: await isLocalDomain(ctx, splitAddress(r).domain), status: 'pending', attempts: 0 });
  }
  const { sha256, size } = await retainBlob(ctx, raw);
  const delay = Math.max(0, input.delayMs ?? 0);
  const [row] = await ctx.db
    .insert(outboundMessages)
    .values({
      userId: input.userId,
      blobSha: sha256,
      size,
      envelopeFrom: input.envelopeFrom,
      recipients,
      subject: (headerValue(fields, 'subject') ?? '').slice(0, 500),
      status: held ? 'cancelled' : delay > 0 ? 'scheduled' : 'queued',
      sendAt: new Date(Date.now() + delay),
      source: input.source,
      lastError: held,
    })
    .returning();

  if (input.saveToSent && input.userId) {
    const owner = input.saveToSent.ownerId ?? input.userId;
    const sent = await specialMailbox(ctx, owner, '\\Sent');
    const copy = await appendMessage(ctx, { userId: owner, mailboxId: sent.id, raw, seen: true, bcc: input.saveToSent.bcc, ignoreQuota: true });
    await ctx.db.update(outboundMessages).set({ sentMessageId: copy.id }).where(eq(outboundMessages.id, row!.id));
    row!.sentMessageId = copy.id;
  }
  if (!held) await ctx.scheduler.schedule(row!.id, delay);
  else await releaseBlob(ctx, sha256);
  return row!;
}

/** Undo send / cancel a scheduled message. The Sent copy moves back to Drafts. */
export async function cancelOutbound(ctx: MailContext, userId: string, id: string): Promise<{ draftMessageId: string | null } | null> {
  const [row] = await ctx.db
    .select()
    .from(outboundMessages)
    .where(and(eq(outboundMessages.id, id), eq(outboundMessages.userId, userId)))
    .limit(1);
  if (!row || !['scheduled', 'queued'].includes(row.status)) return null;
  if (!(await ctx.scheduler.cancel(id))) return null;
  await ctx.db.update(outboundMessages).set({ status: 'cancelled' }).where(eq(outboundMessages.id, id));
  let draftMessageId: string | null = null;
  if (row.sentMessageId) {
    // The Sent copy may live in a shared mailbox; restore the draft there.
    const [copy] = await ctx.db.select({ userId: messages.userId }).from(messages).where(eq(messages.id, row.sentMessageId)).limit(1);
    const owner = copy?.userId ?? userId;
    const drafts = await specialMailbox(ctx, owner, '\\Drafts');
    await moveMessages(ctx, owner, [row.sentMessageId], drafts.id);
    await setFlags(ctx, owner, [row.sentMessageId], { draft: true, seen: true });
    draftMessageId = row.sentMessageId;
  }
  await releaseBlob(ctx, row.blobSha);
  return { draftMessageId };
}

interface RemoteResult {
  address: string;
  ok: boolean;
  permanent: boolean;
  response: string;
}

function transportFor(ctx: MailContext, host: string | null) {
  if (ctx.config.relayUrl) return createTransport(ctx.config.relayUrl);
  return createTransport({
    host: host!,
    port: ctx.config.remotePort ?? 25,
    secure: false,
    name: ctx.config.hostname,
    opportunisticTLS: true,
    tls: { rejectUnauthorized: false },
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 120_000,
  } as Parameters<typeof createTransport>[0]);
}

async function sendVia(ctx: MailContext, host: string | null, from: string, rcpts: string[], raw: Buffer): Promise<RemoteResult[]> {
  const transport = transportFor(ctx, host);
  try {
    const info = (await transport.sendMail({ envelope: { from, to: rcpts }, raw })) as {
      accepted: string[];
      rejected: string[];
      rejectedErrors?: { recipient?: string; response?: string; responseCode?: number }[];
      response: string;
    };
    return rcpts.map((address) => {
      const rejected = info.rejected.map((r) => r.toLowerCase()).includes(address);
      const err = info.rejectedErrors?.find((e) => e.recipient?.toLowerCase() === address);
      return { address, ok: !rejected, permanent: rejected && (err?.responseCode ?? 550) >= 500, response: rejected ? (err?.response ?? 'Rejected') : info.response };
    });
  } finally {
    transport.close();
  }
}

/** Deliver to one remote domain via MX lookup (or the configured relay). */
async function deliverRemoteDomain(ctx: MailContext, from: string, domain: string, rcpts: string[], raw: Buffer): Promise<RemoteResult[]> {
  if (ctx.config.relayUrl) {
    try {
      return await sendVia(ctx, null, from, rcpts, raw);
    } catch (err) {
      const e = err as { responseCode?: number; response?: string; message: string };
      return rcpts.map((address) => ({ address, ok: false, permanent: (e.responseCode ?? 0) >= 500, response: e.response ?? e.message }));
    }
  }
  let hosts: string[];
  try {
    hosts = (await resolveMx(domain)).sort((a, b) => a.priority - b.priority).map((m) => m.exchange).filter(Boolean);
    if (!hosts.length) hosts = [domain];
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      // RFC 5321 §5.1: fall back to the domain's address record when there is no MX.
      hosts = [domain];
    } else {
      return rcpts.map((address) => ({ address, ok: false, permanent: false, response: `DNS lookup failed: ${code}` }));
    }
  }
  let last: RemoteResult[] = rcpts.map((address) => ({ address, ok: false, permanent: false, response: 'No mail exchanger reachable' }));
  for (const host of hosts) {
    try {
      return await sendVia(ctx, host, from, rcpts, raw);
    } catch (err) {
      const e = err as { responseCode?: number; response?: string; message: string; code?: string };
      const permanent = (e.responseCode ?? 0) >= 500;
      last = rcpts.map((address) => ({ address, ok: false, permanent, response: e.response ?? `${e.code ?? ''} ${e.message}`.trim() }));
      if (permanent) return last;
    }
  }
  return last;
}

/**
 * Worker entry point for one outbound message. Returns whether a retry is
 * needed for temporarily failed recipients.
 */
export async function processOutbound(ctx: MailContext, id: string, attempt: { number: number; final: boolean }): Promise<{ retry: boolean; status: OutboundMessage['status'] }> {
  const [row] = await ctx.db.select().from(outboundMessages).where(eq(outboundMessages.id, id)).limit(1);
  if (!row || row.status === 'cancelled' || row.status === 'sent' || row.status === 'failed') return { retry: false, status: row?.status ?? 'failed' };
  await ctx.db.update(outboundMessages).set({ status: 'sending' }).where(eq(outboundMessages.id, id));
  const raw = await ctx.blobs.read(row.blobSha);
  const recipients = row.recipients.map((r) => ({ ...r }));
  const now = new Date().toISOString();
  const pending = recipients.filter((r) => r.status === 'pending' || r.status === 'deferred');

  const local = pending.filter((r) => r.local);
  if (local.length) {
    const results = await deliverInbound(ctx, { raw, envelopeFrom: row.envelopeFrom, recipients: local.map((r) => r.address), internal: true });
    for (const res of results) {
      const r = recipients.find((x) => x.address === normaliseAddress(res.address))!;
      r.attempts++;
      r.updatedAt = now;
      r.status = res.status === 'rejected' ? 'failed' : 'delivered';
      r.response = res.reason ?? (res.status === 'quarantined' ? 'Quarantined' : 'Delivered locally');
    }
  }

  const remote = pending.filter((r) => !r.local);
  const byDomain = new Map<string, string[]>();
  for (const r of remote) {
    const d = splitAddress(r.address).domain;
    byDomain.set(d, [...(byDomain.get(d) ?? []), r.address]);
  }
  for (const [domain, rcpts] of byDomain) {
    const results = await deliverRemoteDomain(ctx, row.envelopeFrom, domain, rcpts, raw);
    for (const res of results) {
      const r = recipients.find((x) => x.address === res.address)!;
      r.attempts++;
      r.updatedAt = now;
      r.response = res.response.slice(0, 500);
      r.status = res.ok ? 'delivered' : res.permanent || attempt.final ? 'failed' : 'deferred';
    }
  }

  const deferred = recipients.some((r) => r.status === 'deferred');
  const failed = recipients.filter((r) => r.status === 'failed');
  const delivered = recipients.some((r) => r.status === 'delivered');
  const status: OutboundMessage['status'] = deferred ? 'queued' : failed.length === 0 ? 'sent' : delivered ? 'partial' : 'failed';
  await ctx.db
    .update(outboundMessages)
    .set({ recipients, status, lastError: failed[0]?.response ?? recipients.find((r) => r.status === 'deferred')?.response ?? null })
    .where(eq(outboundMessages.id, id));

  const newlyFailed = failed.filter((f) => !row.recipients.find((o) => o.address === f.address && o.status === 'failed'));
  if (newlyFailed.length && row.envelopeFrom && row.userId) await bounce(ctx, row, raw, newlyFailed).catch((err) => ctx.log.error({ err }, 'could not create bounce'));
  if (!deferred) await releaseBlob(ctx, row.blobSha);
  return { retry: deferred, status };
}

/** Non-delivery report placed in the sender's inbox. */
async function bounce(ctx: MailContext, row: OutboundMessage, original: Buffer, failed: OutboundRecipient[]) {
  const [sender] = await ctx.db.select().from(users).where(eq(users.id, row.userId!)).limit(1);
  if (!sender) return;
  const [primary] = await ctx.db.select({ name: domains.name }).from(domains).where(eq(domains.isPrimary, true)).limit(1);
  const tree = parseMimeTree(original);
  const { raw } = await composeMessage({
    from: { name: 'Mail Delivery System', address: `mailer-daemon@${primary?.name ?? ctx.config.hostname}` },
    to: [{ name: sender.displayName, address: sender.email }],
    subject: `Undeliverable: ${row.subject}`,
    text:
      `Your message could not be delivered to the following recipients:\n\n` +
      failed.map((f) => `  ${f.address}\n    ${f.response ?? 'Unknown error'}`).join('\n\n') +
      `\n\nThe original message headers are attached.`,
    attachments: [{ filename: 'original-headers.txt', contentType: 'text/rfc822-headers', content: original.subarray(0, tree.bodyStart) }],
    headers: { 'Auto-Submitted': 'auto-replied' },
  });
  const inbox = await specialMailbox(ctx, sender.id, '\\Inbox');
  await appendMessage(ctx, { userId: sender.id, mailboxId: inbox.id, raw, ignoreQuota: true });
}

/** Send an iTIP REPLY (e.g. a room's automatic acceptance) to an organiser. */
export async function sendCalendarReply(ctx: MailContext, from: MailAddress, to: string, ics: string, subject: string, partstat: PartStat) {
  const verb = partstat === 'ACCEPTED' ? 'Accepted' : partstat === 'DECLINED' ? 'Declined' : 'Tentative';
  const { raw } = await composeMessage({
    from,
    to: [{ name: '', address: to }],
    subject: `${verb}: ${subject.replace(/^(invitation|updated invitation):\s*/i, '')}`,
    text: `${from.name || from.address} has ${verb.toLowerCase()} this invitation.`,
    calendar: { method: 'REPLY', content: ics },
    headers: { 'Auto-Submitted': 'auto-replied' },
  });
  await submitMessage(ctx, { userId: null, raw, envelopeFrom: '', recipients: [to], source: 'system' });
}

export async function outboundForUser(ctx: MailContext, userId: string, ids: string[]) {
  if (!ids.length) return [];
  return ctx.db.select().from(outboundMessages).where(and(eq(outboundMessages.userId, userId), inArray(outboundMessages.id, ids)));
}


async function addAppSignature(ctx: MailContext, userId: string, raw: Buffer): Promise<Buffer> {
  const [user] = await ctx.db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || user.kind !== 'person') return raw;
  const sig = await renderSignatureFor(ctx, user);
  if (!sig?.signature.applyToApps || !sig.text) return raw;
  // Skip when the app already added it (or the person pasted it in).
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const body = squash((await indexMessage(raw)).bodyText);
  const firstLine = squash(sig.text.split('\n').find((l) => l.trim()) ?? '');
  if (body.includes(squash(sig.text)) || (firstLine.length > 3 && body.includes(firstLine) && body.includes(squash(user.email)))) return raw;
  return appendDisclaimer(raw, `-- \n${sig.text}`, sig.html, { signature: true });
}
