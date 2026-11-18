import { domains, groupMembers, groups, orm, resources, userAliases, users, type Group, type Resource, type User } from '@forge/db';
import { baseAddress, normaliseAddress, splitAddress } from './addresses';
import type { MailContext } from './context';
import { accessibleMailboxes } from './shared';

const { and, eq } = orm;

export type Route =
  | { kind: 'user'; address: string; user: User }
  | { kind: 'group'; address: string; group: Group; members: User[] }
  | { kind: 'resource'; address: string; resource: Resource };

export async function isLocalDomain(ctx: Pick<MailContext, 'db'>, domain: string): Promise<boolean> {
  const [d] = await ctx.db.select({ id: domains.id }).from(domains).where(eq(domains.name, domain.toLowerCase())).limit(1);
  return !!d;
}

/**
 * Resolve a recipient address on one of our domains: user, alias,
 * distribution list, bookable resource, or the domain's catch-all.
 * Sub-addressing ("user+tag@") resolves to the base address.
 */
export async function resolveRecipient(ctx: Pick<MailContext, 'db'>, address: string): Promise<Route | null> {
  const addr = normaliseAddress(address);
  const base = baseAddress(addr);
  const { domain } = splitAddress(addr);

  const [user] = await ctx.db.select().from(users).where(eq(users.email, base)).limit(1);
  if (user) return user.status === 'active' ? { kind: 'user', address: addr, user } : null;

  const [alias] = await ctx.db
    .select({ user: users })
    .from(userAliases)
    .innerJoin(users, eq(users.id, userAliases.userId))
    .where(eq(userAliases.address, base))
    .limit(1);
  if (alias) return alias.user.status === 'active' ? { kind: 'user', address: addr, user: alias.user } : null;

  const [group] = await ctx.db.select().from(groups).where(eq(groups.email, base)).limit(1);
  if (group) {
    const members = await ctx.db
      .select({ user: users })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(and(eq(groupMembers.groupId, group.id), eq(users.status, 'active')));
    return { kind: 'group', address: addr, group, members: members.map((m) => m.user) };
  }

  const [resource] = await ctx.db.select().from(resources).where(eq(resources.email, base)).limit(1);
  if (resource) return { kind: 'resource', address: addr, resource };

  const [dom] = await ctx.db.select().from(domains).where(eq(domains.name, domain)).limit(1);
  if (dom?.catchAllUserId) {
    const [catchAll] = await ctx.db.select().from(users).where(eq(users.id, dom.catchAllUserId)).limit(1);
    if (catchAll?.status === 'active') return { kind: 'user', address: addr, user: catchAll };
  }
  return null;
}

/** Addresses a user may send as: primary, aliases, lists they own, and shared mailboxes with Send As. */
export async function sendableAddresses(ctx: Pick<MailContext, 'db'>, userId: string): Promise<string[]> {
  const [u] = await ctx.db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  const aliases = await ctx.db.select({ address: userAliases.address }).from(userAliases).where(eq(userAliases.userId, userId));
  const owned = await ctx.db
    .select({ email: groups.email })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(eq(groupMembers.userId, userId), eq(groupMembers.role, 'owner')));
  const shared = (await accessibleMailboxes(ctx, userId)).filter((g) => g.sendAs).map((g) => g.address);
  return [u?.email, ...aliases.map((a) => a.address), ...owned.map((g) => g.email), ...shared].filter((x): x is string => !!x);
}
