import { Type } from 'typebox';
import { domains, orm, senderLists, users, type Database } from '@forge/db';
import { normaliseSenderEntry, splitAddress } from '@forge/mail';
import { badRequest } from '../errors';

const { and, asc, count, eq, inArray, isNull, notInArray, sql } = orm;

export const SenderListBody = Type.Object({
  list: Type.Union([Type.Literal('block'), Type.Literal('allow')]),
  entries: Type.Array(Type.String({ minLength: 1, maxLength: 320 }), { minItems: 1, maxItems: 500 }),
  note: Type.Optional(Type.String({ maxLength: 500 })),
});

export const LIMITS = { mailbox: 1000, organisation: 10_000 };

type Scope = { orgId: string; userId: string | null };
const scopeWhere = (s: Scope) => (s.userId ? eq(senderLists.userId, s.userId) : and(eq(senderLists.orgId, s.orgId), isNull(senderLists.userId)));

export async function listSenderEntries(db: Database, scope: Scope) {
  return db
    .select({ id: senderLists.id, list: senderLists.list, entry: senderLists.entry, note: senderLists.note, createdAt: senderLists.createdAt, createdBy: users.displayName })
    .from(senderLists)
    .leftJoin(users, eq(users.id, senderLists.createdBy))
    .where(scopeWhere(scope))
    .orderBy(asc(senderLists.entry));
}

/**
 * Add entries to a block or allow list. An entry already on the other list
 * moves across. Invalid entries reject the whole request so nothing is half-applied.
 */
export async function addSenderEntries(db: Database, scope: Scope, body: { list: 'block' | 'allow'; entries: string[]; note?: string }, createdBy: string) {
  const normalised = body.entries.map((e) => [e, normaliseSenderEntry(e)] as const);
  const invalid = normalised.filter(([, n]) => !n).map(([e]) => e);
  if (invalid.length) throw badRequest(`Not an email address or domain: ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? '…' : ''}`);
  const entries = [...new Set(normalised.map(([, n]) => n!))];

  // Allowing your own domains would let anyone who forges them past the spam filter.
  if (body.list === 'allow' && !scope.userId) {
    const own = await db.select({ name: domains.name }).from(domains).where(eq(domains.orgId, scope.orgId));
    const clash = entries.filter((e) => own.some((d) => (e.includes('@') ? splitAddress(e).domain : e) === d.name || d.name.endsWith(`.${e}`)));
    if (clash.length) throw badRequest(`Your own domains can't be allowed: ${clash.join(', ')}. Mail from inside the organisation is never filtered as spam.`);
  }

  const [{ n }] = (await db.select({ n: count() }).from(senderLists).where(and(scopeWhere(scope), notInArray(senderLists.entry, entries)))) as [{ n: number }];
  const limit = scope.userId ? LIMITS.mailbox : LIMITS.organisation;
  if (n + entries.length > limit) throw badRequest(`Lists are limited to ${limit.toLocaleString('en')} entries`);

  const rows = await db
    .insert(senderLists)
    .values(entries.map((entry) => ({ orgId: scope.orgId, userId: scope.userId, list: body.list, entry, note: body.note ?? '', createdBy })))
    .onConflictDoUpdate({
      target: scope.userId ? [senderLists.userId, senderLists.entry] : [senderLists.orgId, senderLists.entry],
      targetWhere: scope.userId ? sql`${senderLists.userId} is not null` : sql`${senderLists.userId} is null`,
      set: { list: body.list, note: sql`case when excluded.note <> '' then excluded.note else ${senderLists.note} end` },
    })
    .returning();
  return rows;
}

export async function removeSenderEntries(db: Database, scope: Scope, ids: string[]) {
  return db
    .delete(senderLists)
    .where(and(scopeWhere(scope), inArray(senderLists.id, ids)))
    .returning();
}
