import { domains, orm, senderLists } from '@forge/db';
import { normaliseAddress, splitAddress } from './addresses';
import type { MailContext } from './context';

const { and, eq, inArray, isNull } = orm;

export type SenderListKind = 'block' | 'allow';

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const LOCAL_RE = /^[^\s@<>()",;:]{1,64}$/;

/**
 * Turn user input into a stored entry: an address (`a@b.com`) or a domain
 * (`b.com`). Accepts `@b.com`, `*@b.com`, `*.b.com` and `<a@b.com>` too.
 * Returns null when the input is neither.
 */
export function normaliseSenderEntry(input: string): string | null {
  let s = normaliseAddress(input).replace(/^mailto:/, '');
  s = s.replace(/^\*?@/, '').replace(/^\*\./, '').replace(/^\./, '');
  if (s.includes('@')) {
    const { local, domain } = splitAddress(s);
    return LOCAL_RE.test(local) && DOMAIN_RE.test(domain) ? `${local}@${domain}` : null;
  }
  return DOMAIN_RE.test(s) ? s : null;
}

/** Every entry that could match an address, most specific first: the address, then each parent domain. */
export function senderCandidates(address: string): string[] {
  const a = normaliseAddress(address);
  const { domain } = splitAddress(a);
  if (!domain) return [];
  const labels = domain.split('.');
  return [a, ...labels.map((_, i) => labels.slice(i).join('.'))];
}

/**
 * Decide which list a set of sender addresses falls on. For each address the
 * most specific entry wins (an address beats its domain, a subdomain beats its
 * parent), so "block example.com, allow boss@example.com" works. If any
 * address is blocked the message is blocked.
 */
export function matchSenderList(entries: { list: SenderListKind; entry: string }[], addresses: string[]): { list: SenderListKind; entry: string } | null {
  const byEntry = new Map(entries.map((e) => [e.entry, e]));
  let allowed: { list: SenderListKind; entry: string } | null = null;
  for (const address of addresses) {
    const hit = senderCandidates(address)
      .map((c) => byEntry.get(c))
      .find(Boolean);
    if (hit?.list === 'block') return hit;
    if (hit) allowed ??= hit;
  }
  return allowed;
}

/** The addresses a message is checked against: envelope sender and From header (bounces have no envelope sender). */
export function senderAddresses(envelopeFrom: string, fromHeader: string | undefined | null): string[] {
  return [...new Set([envelopeFrom, fromHeader ?? ''].map(normaliseAddress).filter((a) => a.includes('@')))];
}

/** Look up a mailbox's (userId) or an organisation's (userId null) list entry for these senders. */
export async function senderListVerdict(ctx: Pick<MailContext, 'db'>, scope: { orgId: string; userId: string | null }, addresses: string[]) {
  const candidates = [...new Set(addresses.flatMap(senderCandidates))];
  if (!candidates.length) return null;
  const rows = await ctx.db
    .select({ list: senderLists.list, entry: senderLists.entry })
    .from(senderLists)
    .where(
      and(
        scope.userId ? eq(senderLists.userId, scope.userId) : and(eq(senderLists.orgId, scope.orgId), isNull(senderLists.userId)),
        inArray(senderLists.entry, candidates),
      ),
    );
  return matchSenderList(rows, addresses);
}

/** Organisations that own the domains of these recipients. */
export async function recipientOrgs(ctx: Pick<MailContext, 'db'>, recipients: string[]): Promise<string[]> {
  const names = [...new Set(recipients.map((r) => splitAddress(r).domain).filter(Boolean))];
  if (!names.length) return [];
  const rows = await ctx.db.selectDistinct({ orgId: domains.orgId }).from(domains).where(inArray(domains.name, names));
  return rows.map((r) => r.orgId);
}
