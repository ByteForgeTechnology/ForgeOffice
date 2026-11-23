import { autoReplies, autoReplyLog, orm, type User } from '@forge/db';
import { normaliseAddress, splitAddress } from './addresses';
import { composeMessage } from './compose';
import type { MailContext } from './context';
import type { IndexedMessage } from './ingest';
import { submitMessage } from './outbound';
import { isLocalDomain } from './routing';

const { and, eq, gt } = orm;

const REPLY_INTERVAL_MS = 4 * 86400_000;
const NO_REPLY_SENDER = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?|notifications?)([+.-]|@)/i;

/** RFC 3834 out-of-office reply: once per sender per 4 days, never to lists or robots. */
export async function maybeAutoReply(ctx: MailContext, user: User, idx: IndexedMessage, envelopeFrom: string): Promise<boolean> {
  const [ar] = await ctx.db.select().from(autoReplies).where(eq(autoReplies.userId, user.id)).limit(1);
  if (!ar?.enabled) return false;
  const now = new Date();
  if ((ar.startsAt && now < ar.startsAt) || (ar.endsAt && now > ar.endsAt)) return false;

  const sender = normaliseAddress(envelopeFrom);
  if (!sender || sender === user.email || NO_REPLY_SENDER.test(sender)) return false;
  const h = idx.headers;
  const autoSubmitted = (h.get('auto-submitted')?.[0] ?? 'no').toLowerCase();
  if (autoSubmitted !== 'no') return false;
  if (/^(bulk|list|junk)$/i.test(h.get('precedence')?.[0] ?? '')) return false;
  if (h.has('list-id') || h.has('list-unsubscribe') || h.has('x-auto-response-suppress')) return false;
  if (ar.internalOnly && !(await isLocalDomain(ctx, splitAddress(sender).domain))) return false;

  const [recent] = await ctx.db
    .select()
    .from(autoReplyLog)
    .where(and(eq(autoReplyLog.userId, user.id), eq(autoReplyLog.sender, sender), gt(autoReplyLog.sentAt, new Date(now.getTime() - REPLY_INTERVAL_MS))))
    .limit(1);
  if (recent) return false;
  await ctx.db
    .insert(autoReplyLog)
    .values({ userId: user.id, sender, sentAt: now })
    .onConflictDoUpdate({ target: [autoReplyLog.userId, autoReplyLog.sender], set: { sentAt: now } });

  const { raw } = await composeMessage({
    from: { name: user.displayName, address: user.email },
    to: [{ name: '', address: sender }],
    subject: ar.subject || `Automatic reply: ${idx.subject}`,
    text: ar.body,
    inReplyTo: idx.messageId,
    references: [...idx.references, ...(idx.messageId ? [idx.messageId] : [])],
    headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All', 'X-Forge-Loop': user.email },
  });
  // RFC 3834 §3.3: use the null reverse-path so bounces of the reply are not answered.
  await submitMessage(ctx, { userId: user.id, raw, envelopeFrom: '', recipients: [sender], source: 'system' });
  return true;
}
