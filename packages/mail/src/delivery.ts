import { authenticate } from 'mailauth';
import { processItip } from '@forge/calendar';
import { mailFilters, orm, quarantine, type User } from '@forge/db';
import { normaliseAddress } from './addresses';
import { maybeAutoReply } from './autoreply';
import type { MailContext } from './context';
import { indexMessage, type IndexedMessage } from './ingest';
import { normaliseLineEndings } from './mime';
import { sendCalendarReply, submitMessage } from './outbound';
import { isLocalDomain, resolveRecipient } from './routing';
import { applyTransportRules } from './transport';
import { recipientOrgs, senderAddresses, senderListVerdict } from './sender-lists';
import { splitAddress } from './addresses';
import { scoreMessage, type AuthSummary, type SpamVerdict } from './spam';
import { appendMessage, ensureMailboxes, QuotaExceededError, retainBlob } from './store';
import { evaluateFilters } from './rules';

const { asc, eq } = orm;

export interface InboundInput {
  raw: Buffer;
  /** MAIL FROM (empty string for bounces). */
  envelopeFrom: string;
  recipients: string[];
  remoteIp?: string | null;
  helo?: string | null;
  /** Mail from our own authenticated users: skip SPF/DMARC and spam scoring. */
  internal?: boolean;
}

export interface RecipientResult {
  address: string;
  status: 'delivered' | 'quarantined' | 'rejected';
  reason?: string;
}

const LOOP_HEADER = 'x-forge-loop';

function smtpDate(d = new Date()) {
  return d.toUTCString().replace('GMT', '+0000');
}

async function checkAuthentication(ctx: MailContext, raw: Buffer, input: InboundInput): Promise<{ summary: AuthSummary | null; headers: string; results: Record<string, unknown> | null }> {
  if (ctx.config.disableAuthChecks || !input.remoteIp) return { summary: null, headers: '', results: null };
  try {
    const res = (await authenticate(raw, { ip: input.remoteIp, helo: input.helo ?? undefined, sender: input.envelopeFrom || undefined, mta: ctx.config.hostname, disableArc: true, disableBimi: true })) as unknown as {
      headers: string;
      spf?: { status?: { result?: string } };
      dkim?: { results?: { status?: { result?: string } }[] };
      dmarc?: { status?: { result?: string }; policy?: string } | false;
    };
    const dkimResults = res.dkim?.results ?? [];
    const summary: AuthSummary = {
      spf: res.spf?.status?.result ?? 'none',
      dkim: dkimResults.some((r) => r.status?.result === 'pass') ? 'pass' : dkimResults.length ? 'fail' : 'none',
      dmarc: (res.dmarc && res.dmarc.status?.result) || 'none',
      dmarcPolicy: (res.dmarc && res.dmarc.policy) || null,
    };
    return { summary, headers: res.headers ?? '', results: summary as unknown as Record<string, unknown> };
  } catch (err) {
    ctx.log.warn({ err: (err as Error).message }, 'mail authentication checks failed');
    return { summary: null, headers: '', results: null };
  }
}

/**
 * Deliver a message to local recipients: authenticate (external mail),
 * score for spam, expand lists, run each user's rules, store, then trigger
 * auto-replies and calendar processing.
 */
export async function deliverInbound(ctx: MailContext, input: InboundInput): Promise<RecipientResult[]> {
  let raw = normaliseLineEndings(input.raw);
  const auth = input.internal ? { summary: null, headers: '', results: null } : await checkAuthentication(ctx, raw, input);
  const trace =
    `Return-Path: <${input.envelopeFrom}>\r\n` +
    (input.internal ? '' : `Received: from ${input.helo ?? 'unknown'} ([${input.remoteIp ?? 'unknown'}]) by ${ctx.config.hostname} with ESMTP; ${smtpDate()}\r\n`) +
    auth.headers.replace(/\r?\n/g, '\r\n');
  raw = Buffer.concat([Buffer.from(trace), raw]);
  let idx = await indexMessage(raw);
  let verdict: SpamVerdict = input.internal ? { score: 0, verdict: 'ham', reasons: [] } : scoreMessage(auth.summary, idx);
  let recipients = input.recipients;
  const forwardOut: string[] = [];
  const senders = senderAddresses(input.envelopeFrom, idx.from?.address);
  // Allow-list entries are ignored for mail that fails DMARC, so they cannot be used to spoof a trusted sender.
  const spoofed = auth.summary?.dmarc === 'fail';

  // Organisation block / allow lists: blocked senders are refused outright; allowed ones skip spam filtering.
  if (!input.internal) {
    for (const orgId of await recipientOrgs(ctx, recipients)) {
      const hit = await senderListVerdict(ctx, { orgId, userId: null }, senders);
      if (hit?.list === 'block') return recipients.map((address) => ({ address, status: 'rejected' as const, reason: 'The recipient\'s organisation does not accept mail from this sender' }));
      if (hit?.list === 'allow' && !spoofed && verdict.verdict !== 'ham') verdict = { ...verdict, verdict: 'ham', reasons: [...verdict.reasons, `Allowed sender ${hit.entry} (organisation)`] };
    }
  }

  // Organisation transport rules for mail arriving from outside (internal mail was checked at submission).
  if (!input.internal) {
    const outcome = await applyTransportRules(ctx, { direction: 'inbound', envelopeFrom: input.envelopeFrom, recipients, raw, idx, spamScore: verdict.score });
    if (outcome.reject) return recipients.map((address) => ({ address, status: 'rejected' as const, reason: outcome.reject }));
    if (outcome.drop) return recipients.map((address) => ({ address, status: 'delivered' as const }));
    if (outcome.quarantine) verdict = { ...verdict, verdict: 'quarantine', reasons: [...verdict.reasons, outcome.quarantine] };
    else if (outcome.junk) verdict = { ...verdict, verdict: 'spam', reasons: [...verdict.reasons, 'Transport rule'] };
    if (outcome.raw !== raw) {
      raw = outcome.raw;
      idx = await indexMessage(raw);
    }
    recipients = [];
    for (const r of outcome.recipients) {
      if (await isLocalDomain(ctx, splitAddress(r).domain)) recipients.push(r);
      else forwardOut.push(r);
    }
  }

  const results: RecipientResult[] = [];
  const users = new Map<string, { user: User; address: string }>();
  const resources: Extract<Awaited<ReturnType<typeof resolveRecipient>>, { kind: 'resource' }>[] = [];

  for (const address of recipients) {
    const route = await resolveRecipient(ctx, address);
    if (!route) {
      results.push({ address, status: 'rejected', reason: 'No such recipient' });
      continue;
    }
    if (route.kind === 'user') users.set(route.user.id, { user: route.user, address });
    else if (route.kind === 'resource') resources.push(route);
    else {
      if (!input.internal && !route.group.allowExternalSenders) {
        results.push({ address, status: 'rejected', reason: 'This list only accepts mail from inside the organisation' });
        continue;
      }
      for (const m of route.members) if (!users.has(m.id)) users.set(m.id, { user: m, address });
    }
    results.push({ address, status: 'delivered' });
  }

  if (verdict.verdict === 'quarantine') {
    const { sha256, size } = await retainBlob(ctx, raw);
    const orgId = [...users.values()][0]?.user.orgId ?? null;
    await ctx.db.insert(quarantine).values({
      orgId,
      blobSha: sha256,
      size,
      envelopeFrom: input.envelopeFrom,
      recipients: [...recipients, ...forwardOut],
      fromHeader: idx.from ? `${idx.from.name} <${idx.from.address}>` : '',
      subject: idx.subject,
      reason: verdict.reasons.join('; '),
      spamScore: verdict.score,
      authResults: auth.results,
      remoteIp: input.remoteIp ?? null,
    });
    return results.map((r) => (r.status === 'delivered' ? { ...r, status: 'quarantined' as const } : r));
  }

  for (const { user, address } of users.values()) {
    try {
      await deliverToUser(ctx, user, raw, idx, { spam: verdict.verdict === 'spam', score: verdict.score, authResults: auth.results, envelopeFrom: input.envelopeFrom, internal: !!input.internal, senders, spoofed });
    } catch (err) {
      const r = results.find((x) => x.address === address);
      if (r) {
        r.status = 'rejected';
        r.reason = err instanceof QuotaExceededError ? 'Mailbox full' : 'Delivery failed';
      }
      if (!(err instanceof QuotaExceededError)) ctx.log.error({ err, userId: user.id }, 'local delivery failed');
    }
  }

  // Redirects/BCCs to addresses outside the organisation.
  if (forwardOut.length) {
    await submitMessage(ctx, { userId: null, raw, envelopeFrom: input.envelopeFrom, recipients: forwardOut, source: 'system', sign: false });
    for (const address of forwardOut) results.push({ address, status: 'delivered' });
  }

  for (const route of resources) {
    for (const part of idx.calendarParts) {
      if (!part.method) continue;
      try {
        const outcome = await processItip(ctx.db, { kind: 'resource', resource: route.resource }, part.method, part.ics);
        if (outcome.reply) await sendCalendarReply(ctx, { address: route.resource.email, name: route.resource.name }, outcome.reply.to, outcome.reply.ics, idx.subject, outcome.reply.partstat);
      } catch (err) {
        ctx.log.warn({ err: (err as Error).message, resource: route.resource.email }, 'resource booking failed');
      }
    }
  }
  return results;
}

async function deliverToUser(
  ctx: MailContext,
  user: User,
  raw: Buffer,
  idx: IndexedMessage,
  opts: { spam: boolean; score: number; authResults: Record<string, unknown> | null; envelopeFrom: string; internal: boolean; senders: string[]; spoofed: boolean },
) {
  const boxes = await ensureMailboxes(ctx, user.id);
  const inbox = boxes.find((b) => b.specialUse === '\\Inbox')!;
  const junk = boxes.find((b) => b.specialUse === '\\Junk')!;
  const trash = boxes.find((b) => b.specialUse === '\\Trash')!;
  const loops = (idx.headers.get(LOOP_HEADER) ?? []).map((v) => v.toLowerCase());
  const looped = loops.includes(user.email);

  // The mailbox's own lists: blocked senders go to Junk, allowed ones stay out of it.
  let spam = opts.spam;
  const personal = await senderListVerdict(ctx, { orgId: user.orgId, userId: user.id }, opts.senders);
  if (personal?.list === 'block') spam = true;
  else if (personal?.list === 'allow' && !opts.spoofed) spam = false;

  let target = spam ? junk : inbox;
  let seen = false;
  let flagged = false;
  const forwards: string[] = [];
  if (!spam) {
    const filters = await ctx.db.select().from(mailFilters).where(eq(mailFilters.userId, user.id)).orderBy(asc(mailFilters.position));
    for (const action of evaluateFilters(filters, idx, raw.length)) {
      if (action.type === 'move' && action.value) {
        const box = boxes.find((b) => b.id === action.value);
        if (box) target = box;
      } else if (action.type === 'markRead') seen = true;
      else if (action.type === 'flag') flagged = true;
      else if (action.type === 'delete') target = trash;
      else if (action.type === 'forward' && action.value) forwards.push(action.value);
    }
  }

  await appendMessage(ctx, { userId: user.id, mailboxId: target.id, raw, indexed: idx, seen, flagged, spamScore: opts.score, authResults: opts.authResults });

  if (spam || looped) return;

  // Scheduling messages update the recipient's calendar (external organisers/attendees).
  for (const part of idx.calendarParts) {
    if (!part.method || normaliseAddress(idx.from?.address ?? '') === user.email) continue;
    try {
      const outcome = await processItip(ctx.db, { kind: 'user', id: user.id, orgId: user.orgId, email: user.email, name: user.displayName }, part.method, part.ics);
      if (outcome.affectedUserIds.length) void ctx.bus?.publish('calendar.changed', { userIds: outcome.affectedUserIds }).catch(() => {});
    } catch (err) {
      ctx.log.warn({ err: (err as Error).message }, 'could not apply calendar message');
    }
  }

  for (const to of forwards) {
    const header = Buffer.from(`X-Forge-Loop: ${user.email}\r\nResent-From: ${user.email}\r\n`);
    await submitMessage(ctx, { userId: null, raw: Buffer.concat([header, raw]), envelopeFrom: user.email, recipients: [to], source: 'system', sign: false });
  }

  await maybeAutoReply(ctx, user, idx, opts.envelopeFrom).catch((err) => ctx.log.warn({ err: (err as Error).message }, 'auto-reply failed'));
}

/** Release a quarantined message to its original recipients. */
export async function releaseFromQuarantine(ctx: MailContext, id: string, releasedBy: string): Promise<RecipientResult[]> {
  const [row] = await ctx.db.select().from(quarantine).where(eq(quarantine.id, id)).limit(1);
  if (!row || row.releasedAt) return [];
  const raw = await ctx.blobs.read(row.blobSha);
  const local: string[] = [];
  const remote: string[] = [];
  for (const r of row.recipients) (await isLocalDomain(ctx, splitAddress(r).domain) ? local : remote).push(r);
  // Deliver as internal so it is not checked again; outgoing mail held by a rule goes out as system mail.
  const results = local.length ? await deliverInbound(ctx, { raw, envelopeFrom: row.envelopeFrom, recipients: local, internal: true }) : [];
  if (remote.length) {
    await submitMessage(ctx, { userId: null, raw, envelopeFrom: row.envelopeFrom, recipients: remote, source: 'system' });
    results.push(...remote.map((address) => ({ address, status: 'delivered' as const })));
  }
  await ctx.db.update(quarantine).set({ releasedAt: new Date(), releasedBy }).where(eq(quarantine.id, id));
  return results;
}

