import { driveItems, driveLibraries, drivePermissions, groupMembers, groups, orm, users, type Database, type DriveItem, type DriveLibrary, type DriveRole } from '@forge/db';

const { and, eq, inArray, isNull, or } = orm;

export const ROLE_RANK: Record<DriveRole, number> = { viewer: 1, commenter: 2, editor: 3, owner: 4 };
export const atLeast = (role: DriveRole | null, need: DriveRole) => !!role && ROLE_RANK[role] >= ROLE_RANK[need];
const best = (a: DriveRole | null, b: DriveRole | null): DriveRole | null => (!a ? b : !b ? a : ROLE_RANK[a] >= ROLE_RANK[b] ? a : b);

export class DriveAccessError extends Error {
  constructor(
    readonly status: 403 | 404,
    message: string,
  ) {
    super(message);
    this.name = 'DriveAccessError';
  }
}

export interface Principal {
  userId: string;
  orgId: string;
  groupIds: string[];
  /** Groups the person owns (group libraries: owners manage, members edit). */
  ownedGroupIds: string[];
}

export async function principalFor(db: Database, userId: string): Promise<Principal> {
  const rows = await db.select({ id: groupMembers.groupId, role: groupMembers.role }).from(groupMembers).where(eq(groupMembers.userId, userId));
  const [u] = await db.select({ orgId: users.orgId }).from(users).where(eq(users.id, userId)).limit(1);
  return { userId, orgId: u?.orgId ?? '', groupIds: rows.map((r) => r.id), ownedGroupIds: rows.filter((r) => r.role === 'owner').map((r) => r.id) };
}

/** Grants (library-level or on items) that apply to this person. */
async function grantsFor(db: Database, p: Principal, libraryId: string) {
  return db
    .select({ itemId: drivePermissions.itemId, role: drivePermissions.role })
    .from(drivePermissions)
    .where(
      and(
        eq(drivePermissions.libraryId, libraryId),
        or(
          and(eq(drivePermissions.principalType, 'user'), eq(drivePermissions.principalId, p.userId)),
          p.groupIds.length ? and(eq(drivePermissions.principalType, 'group'), inArray(drivePermissions.principalId, p.groupIds)) : undefined,
        ),
      ),
    );
}

/** A person's role on a library as a whole (ownership, group membership, library-level grants). */
export function builtInRole(lib: DriveLibrary, p: Principal): DriveRole | null {
  if (lib.kind === 'personal') return lib.ownerUserId === p.userId ? 'owner' : null;
  let role: DriveRole | null = null;
  if (lib.groupId) {
    if (p.ownedGroupIds.includes(lib.groupId)) return 'owner';
    if (p.groupIds.includes(lib.groupId)) role = 'editor';
  }
  // Organisation-wide libraries (e.g. a communication site everyone can read).
  if (lib.everyoneRole && lib.orgId === p.orgId) role = best(role, lib.everyoneRole);
  return role;
}

/**
 * Effective role on an item: grants on the item and its ancestors, plus the
 * library's (unless a folder on the way up stops inheritance). The best one wins.
 */
export async function effectiveRole(db: Database, p: Principal, lib: DriveLibrary, item: DriveItem | null): Promise<DriveRole | null> {
  const grants = await grantsFor(db, p, lib.id);
  const onItem = (id: string | null) => grants.filter((g) => g.itemId === id).reduce<DriveRole | null>((r, g) => best(r, g.role), null);
  let role: DriveRole | null = null;
  let inherit = true;
  let current: DriveItem | null = item;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    role = best(role, onItem(current.id));
    if (!current.inheritPermissions) {
      inherit = false;
      break;
    }
    if (!current.parentId) break;
    const [parent] = await db.select().from(driveItems).where(eq(driveItems.id, current.parentId)).limit(1);
    current = parent ?? null;
  }
  // The library owner always keeps access, even below a folder that stops inheritance.
  const builtIn = builtInRole(lib, p);
  if (builtIn === 'owner') return 'owner';
  if (inherit) role = best(role, best(builtIn, onItem(null)));
  return role;
}

/** Load an item and its library, and check the person's role (404 when they can't see it at all). */
export async function requireItem(db: Database, p: Principal, itemId: string, need: DriveRole, opts: { includeDeleted?: boolean } = {}) {
  const [row] = await db.select({ item: driveItems, lib: driveLibraries }).from(driveItems).innerJoin(driveLibraries, eq(driveLibraries.id, driveItems.libraryId)).where(eq(driveItems.id, itemId)).limit(1);
  if (!row || (row.item.deletedAt && !opts.includeDeleted)) throw new DriveAccessError(404, 'File or folder not found');
  const role = await effectiveRole(db, p, row.lib, row.item);
  if (!role) throw new DriveAccessError(404, 'File or folder not found');
  if (!atLeast(role, need)) throw new DriveAccessError(403, need === 'owner' ? 'Only owners can do this' : need === 'editor' ? 'You can only view this' : 'You cannot comment here');
  return { item: row.item, lib: row.lib, role };
}

export async function requireLibrary(db: Database, p: Principal, libraryId: string, need: DriveRole) {
  const [lib] = await db.select().from(driveLibraries).where(eq(driveLibraries.id, libraryId)).limit(1);
  if (!lib) throw new DriveAccessError(404, 'Library not found');
  const role = await effectiveRole(db, p, lib, null);
  if (!role) throw new DriveAccessError(404, 'Library not found');
  if (!atLeast(role, need)) throw new DriveAccessError(403, 'You can only view this library');
  return { lib, role };
}

/** A person's own library ("My files"), created on first use. */
export async function ensurePersonalLibrary(db: Database, user: { id: string; orgId: string }): Promise<DriveLibrary> {
  const find = () => db.select().from(driveLibraries).where(and(eq(driveLibraries.kind, 'personal'), eq(driveLibraries.ownerUserId, user.id))).limit(1);
  const [existing] = await find();
  if (existing) return existing;
  await db.insert(driveLibraries).values({ orgId: user.orgId, kind: 'personal', ownerUserId: user.id, name: 'My files' }).onConflictDoNothing();
  return (await find())[0]!;
}

/** The library of a security group (a team's shared files), created on first use. */
export async function ensureGroupLibrary(db: Database, group: { id: string; orgId: string; name: string }): Promise<DriveLibrary> {
  const find = () => db.select().from(driveLibraries).where(and(eq(driveLibraries.kind, 'group'), eq(driveLibraries.groupId, group.id))).limit(1);
  const [existing] = await find();
  if (existing) return existing;
  await db.insert(driveLibraries).values({ orgId: group.orgId, kind: 'group', groupId: group.id, name: group.name }).onConflictDoNothing();
  return (await find())[0]!;
}

/** Libraries a person can open: their own, their groups', and any granted to them as a whole. */
export async function accessibleLibraries(db: Database, p: Principal, orgId: string) {
  const own = await ensurePersonalLibrary(db, { id: p.userId, orgId });
  const myGroups = p.groupIds.length ? await db.select().from(groups).where(and(inArray(groups.id, p.groupIds), eq(groups.type, 'security'))) : [];
  for (const g of myGroups) await ensureGroupLibrary(db, g);
  const granted = await db
    .selectDistinct({ id: drivePermissions.libraryId })
    .from(drivePermissions)
    .where(
      and(
        isNull(drivePermissions.itemId),
        or(
          and(eq(drivePermissions.principalType, 'user'), eq(drivePermissions.principalId, p.userId)),
          p.groupIds.length ? and(eq(drivePermissions.principalType, 'group'), inArray(drivePermissions.principalId, p.groupIds)) : undefined,
        ),
      ),
    );
  const ids = [...new Set([own.id, ...granted.map((g) => g.id)])];
  const libs = await db.select().from(driveLibraries).where(or(inArray(driveLibraries.id, ids), myGroups.length ? inArray(driveLibraries.groupId, myGroups.map((g) => g.id)) : undefined));
  const out: (DriveLibrary & { role: DriveRole })[] = [];
  for (const lib of libs) {
    const role = await effectiveRole(db, p, lib, null);
    if (role) out.push({ ...lib, role });
  }
  return out;
}

/** Items shared with the person directly (not through a whole library they can already open). */
export async function sharedWithMe(db: Database, p: Principal) {
  const rows = await db
    .select({ item: driveItems, lib: driveLibraries, role: drivePermissions.role })
    .from(drivePermissions)
    .innerJoin(driveItems, eq(driveItems.id, drivePermissions.itemId))
    .innerJoin(driveLibraries, eq(driveLibraries.id, driveItems.libraryId))
    .where(
      and(
        isNull(driveItems.deletedAt),
        or(
          and(eq(drivePermissions.principalType, 'user'), eq(drivePermissions.principalId, p.userId)),
          p.groupIds.length ? and(eq(drivePermissions.principalType, 'group'), inArray(drivePermissions.principalId, p.groupIds)) : undefined,
        ),
      ),
    );
  const out = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (builtInRole(r.lib, p)) continue; // their own or their group's library
    const prev = out.get(r.item.id);
    if (!prev || ROLE_RANK[r.role] > ROLE_RANK[prev.role]) out.set(r.item.id, r);
  }
  return [...out.values()];
}
