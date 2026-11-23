import { delegatedMailboxes } from '@forge/calendar';
import { folderPermissions, groupMembers, orm, users, type User } from '@forge/db';

const { and, eq, inArray, or } = orm;
import type { MailContext } from './context';
import { ensureMailboxes } from './store';


/** none < read (view) < write (flag, file in/out) < full (also delete) < owner. */
export type MailAccess = 'owner' | 'full' | 'write' | 'read' | 'none';

export interface MailboxGrant {
  ownerId: string;
  address: string;
  name: string;
  access: Exclude<MailAccess, 'owner'>;
  sendAs: boolean;
  sendOnBehalf: boolean;
}

const RANK: Record<MailAccess, number> = { none: 0, read: 1, write: 2, full: 3, owner: 4 };

/**
 * Mailboxes other than their own that a user has been granted rights on,
 * merging direct grants with grants to security groups they belong to.
 * (Shared with calendars and contacts via @forge/calendar.)
 */
export async function accessibleMailboxes(ctx: Pick<MailContext, 'db'>, userId: string): Promise<MailboxGrant[]> {
  return (await delegatedMailboxes(ctx.db, userId)).map(({ orgId: _o, ...g }) => g);
}

/** Effective rights of `userId` on the mailbox owned by `ownerId`. */
export async function mailboxAccess(ctx: Pick<MailContext, 'db'>, userId: string, ownerId: string): Promise<{ access: MailAccess; sendAs: boolean; sendOnBehalf: boolean }> {
  if (userId === ownerId) return { access: 'owner', sendAs: true, sendOnBehalf: true };
  const grant = (await accessibleMailboxes(ctx, userId)).find((g) => g.ownerId === ownerId);
  return grant ? { access: grant.access, sendAs: grant.sendAs, sendOnBehalf: grant.sendOnBehalf } : { access: 'none', sendAs: false, sendOnBehalf: false };
}

export const canRead = (a: MailAccess) => RANK[a] >= RANK.read;
export const canWrite = (a: MailAccess) => RANK[a] >= RANK.write;
export const canDelete = (a: MailAccess) => RANK[a] >= RANK.full;
/** Whole-mailbox management (create/rename/delete folders, rules, auto-reply, drafts). */
export const canManage = (a: MailAccess) => RANK[a] >= RANK.full;
export const maxAccess = (a: MailAccess, b: MailAccess): MailAccess => (RANK[a] >= RANK[b] ? a : b);

/** Addresses `userId` may put in From: on behalf of someone else (requires a Sender: header). */
export async function onBehalfAddresses(ctx: Pick<MailContext, 'db'>, userId: string): Promise<string[]> {
  return (await accessibleMailboxes(ctx, userId)).filter((g) => g.sendOnBehalf && !g.sendAs).map((g) => g.address);
}

/** Owner of a "Send as" / "on behalf" address, for saving the Sent copy in the shared mailbox. */
export async function sharedOwnerByAddress(ctx: Pick<MailContext, 'db'>, userId: string, address: string): Promise<MailboxGrant | null> {
  return (await accessibleMailboxes(ctx, userId)).find((g) => g.address === address.toLowerCase() && (g.sendAs || g.sendOnBehalf)) ?? null;
}

export const isSharedMailbox = (u: Pick<User, 'kind'>) => u.kind === 'shared';

// ---------------------------------------------------------------------------
// Individually shared folders
// ---------------------------------------------------------------------------

async function folderShares(ctx: Pick<MailContext, 'db'>, userId: string, ownerId?: string) {
  const groupIds = (await ctx.db.select({ id: groupMembers.groupId }).from(groupMembers).where(eq(groupMembers.userId, userId))).map((g) => g.id);
  return ctx.db
    .select({ mailboxId: folderPermissions.mailboxId, ownerId: folderPermissions.ownerId, access: folderPermissions.access })
    .from(folderPermissions)
    .where(
      and(
        ownerId ? eq(folderPermissions.ownerId, ownerId) : undefined,
        or(
          and(eq(folderPermissions.principalType, 'user'), eq(folderPermissions.principalId, userId)),
          groupIds.length ? and(eq(folderPermissions.principalType, 'group'), inArray(folderPermissions.principalId, groupIds)) : undefined,
        ),
      ),
    );
}

export interface FolderScope {
  ownerId: string;
  /** Access to the mailbox as a whole ("none" when only some folders are shared). */
  mailbox: MailAccess;
  /** Every folder the user can see, with their access to it. */
  folders: Map<string, MailAccess>;
}

/** Combine the mailbox-wide grant with per-folder shares into per-folder access. */
export async function folderScope(ctx: Pick<MailContext, 'db'>, userId: string, ownerId: string): Promise<FolderScope> {
  // Make sure default folders exist (a brand-new account may not have any yet).
  const all = await ensureMailboxes(ctx, ownerId);
  if (userId === ownerId) return { ownerId, mailbox: 'owner', folders: new Map(all.map((b) => [b.id, 'owner' as MailAccess])) };
  const { access } = await mailboxAccess(ctx, userId, ownerId);
  const folders = new Map<string, MailAccess>();
  if (canRead(access)) for (const b of all) folders.set(b.id, access);
  for (const share of await folderShares(ctx, userId, ownerId)) folders.set(share.mailboxId, maxAccess(folders.get(share.mailboxId) ?? 'none', share.access));
  return { ownerId, mailbox: access, folders };
}

/** Accounts whose folders (but not whole mailbox) are shared with the user. */
export async function sharedFolderOwners(ctx: Pick<MailContext, 'db'>, userId: string): Promise<{ ownerId: string; address: string; name: string }[]> {
  const owners = [...new Set((await folderShares(ctx, userId)).map((s) => s.ownerId))].filter((id) => id !== userId);
  if (!owners.length) return [];
  const rows = await ctx.db.select({ id: users.id, email: users.email, name: users.displayName, status: users.status }).from(users).where(inArray(users.id, owners));
  return rows.filter((r) => r.status === 'active').map((r) => ({ ownerId: r.id, address: r.email, name: r.name }));
}
