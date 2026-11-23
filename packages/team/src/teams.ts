import { channelMembers, channels, driveItems, driveLibraries, drivePermissions, groupMembers, groups, orm, teams, users, type Channel, type Database, type DriveLibrary, type Team } from '@forge/db';
import { createFolder, ensureGroupLibrary, ensurePersonalLibrary, type DriveContext } from '@forge/drive';

const { and, asc, eq, inArray, isNull, sql } = orm;

export interface TeamCtx {
  db: Database;
  drive: DriveContext;
}

export type TeamRole = 'owner' | 'member';

export class TeamError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'team_error',
  ) {
    super(message);
    this.name = 'TeamError';
  }
}

const notFound = (what: string) => new TeamError(404, `${what} not found`, 'not_found');

// ---------------------------------------------------------------------------
// Teams (each backed by a security group: its members and its library)
// ---------------------------------------------------------------------------

export async function teamRole(db: Database, userId: string, team: Pick<Team, 'groupId'>): Promise<TeamRole | null> {
  const [m] = await db.select({ role: groupMembers.role }).from(groupMembers).where(and(eq(groupMembers.groupId, team.groupId), eq(groupMembers.userId, userId))).limit(1);
  return m?.role ?? null;
}

export async function requireTeam(db: Database, userId: string, orgId: string, teamId: string, need: TeamRole = 'member') {
  const [team] = await db.select().from(teams).where(and(eq(teams.id, teamId), eq(teams.orgId, orgId))).limit(1);
  if (!team) throw notFound('Team');
  const role = await teamRole(db, userId, team);
  if (!role) throw notFound('Team');
  if (need === 'owner' && role !== 'owner') throw new TeamError(403, 'Only team owners can do this', 'forbidden');
  return { team, role };
}

export async function teamLibrary(db: Database, team: Team): Promise<DriveLibrary> {
  const [g] = await db.select().from(groups).where(eq(groups.id, team.groupId)).limit(1);
  if (!g) throw notFound('Team group');
  return ensureGroupLibrary(db, g);
}

/** Teams someone belongs to, with their role. */
export async function myTeams(db: Database, userId: string) {
  return db
    .select({ team: teams, role: groupMembers.role })
    .from(teams)
    .innerJoin(groupMembers, and(eq(groupMembers.groupId, teams.groupId), eq(groupMembers.userId, userId)))
    .where(isNull(teams.archivedAt))
    .orderBy(asc(teams.name));
}

export async function teamMemberIds(db: Database, team: Pick<Team, 'groupId'>) {
  return (await db.select({ id: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, team.groupId))).map((r) => r.id);
}

/** People in the organisation (active), checked. */
async function orgPeople(db: Database, orgId: string, ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const rows = await db.select({ id: users.id }).from(users).where(and(inArray(users.id, unique), eq(users.orgId, orgId), eq(users.status, 'active'), eq(users.kind, 'person')));
  if (rows.length !== unique.length) throw new TeamError(400, 'Some of those people are not in the organisation', 'bad_member');
  return unique;
}

export async function createTeam(ctx: TeamCtx, user: { id: string; orgId: string }, input: { name: string; description?: string; visibility?: 'public' | 'private'; color?: string; memberIds?: string[] }) {
  const name = input.name.trim();
  if (!name) throw new TeamError(400, 'Give the team a name');
  const members = await orgPeople(ctx.db, user.orgId, (input.memberIds ?? []).filter((id) => id !== user.id));
  const [group] = await ctx.db.insert(groups).values({ orgId: user.orgId, name, description: input.description ?? '', type: 'security' }).returning();
  await ctx.db.insert(groupMembers).values([{ groupId: group!.id, userId: user.id, role: 'owner' as const }, ...members.map((id) => ({ groupId: group!.id, userId: id, role: 'member' as const }))]);
  const [team] = await ctx.db
    .insert(teams)
    .values({ orgId: user.orgId, groupId: group!.id, name, description: input.description ?? '', visibility: input.visibility ?? 'private', color: input.color ?? '#4f46e5', createdBy: user.id })
    .returning();
  const general = await createChannel(ctx, team!, user, { name: 'General', kind: 'standard', general: true });
  return { team: team!, general };
}

export async function setTeamMembers(ctx: TeamCtx, team: Team, changes: { add?: { userId: string; role: TeamRole }[]; remove?: string[] }) {
  const add = changes.add ?? [];
  await orgPeople(ctx.db, team.orgId, add.map((a) => a.userId));
  for (const a of add)
    await ctx.db
      .insert(groupMembers)
      .values({ groupId: team.groupId, userId: a.userId, role: a.role })
      .onConflictDoUpdate({ target: [groupMembers.groupId, groupMembers.userId], set: { role: a.role } });
  if (changes.remove?.length) await ctx.db.delete(groupMembers).where(and(eq(groupMembers.groupId, team.groupId), inArray(groupMembers.userId, changes.remove)));
  const owners = await ctx.db.select({ id: groupMembers.userId }).from(groupMembers).where(and(eq(groupMembers.groupId, team.groupId), eq(groupMembers.role, 'owner')));
  if (!owners.length) throw new TeamError(400, 'A team needs at least one owner', 'last_owner');
  // People who left a team leave its private channels too.
  if (changes.remove?.length) {
    const priv = await ctx.db.select({ id: channels.id }).from(channels).where(and(eq(channels.teamId, team.id), eq(channels.kind, 'private')));
    for (const c of priv) await removeChannelMembers(ctx, c.id, changes.remove);
  }
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/** A channel and whether (and how) this person is in it. */
export async function requireChannel(db: Database, userId: string, orgId: string, channelId: string) {
  const [channel] = await db.select().from(channels).where(and(eq(channels.id, channelId), eq(channels.orgId, orgId))).limit(1);
  if (!channel) throw notFound('Channel');
  const [member] = await db.select().from(channelMembers).where(and(eq(channelMembers.channelId, channel.id), eq(channelMembers.userId, userId))).limit(1);
  let team: Team | null = null;
  let teamRoleOf: TeamRole | null = null;
  if (channel.teamId) {
    [team] = (await db.select().from(teams).where(eq(teams.id, channel.teamId)).limit(1)) as [Team];
    teamRoleOf = team ? await teamRole(db, userId, team) : null;
  }
  const allowed = channel.kind === 'standard' ? !!teamRoleOf : !!member && member.role !== undefined && (channel.kind !== 'private' || !!teamRoleOf);
  if (!allowed) throw notFound('Channel');
  // Only owners of a private channel or the team manage it; chats are managed by their members.
  const canManage = channel.kind === 'dm' || channel.kind === 'group' ? true : channel.kind === 'private' ? member?.role === 'owner' || teamRoleOf === 'owner' : teamRoleOf === 'owner';
  return { channel, team, member: member ?? null, teamRole: teamRoleOf, canManage };
}

/** Everyone who can read a channel (who gets its live updates). */
export async function channelAudience(db: Database, channel: Channel): Promise<string[]> {
  if (channel.kind === 'standard' && channel.teamId) {
    const [team] = await db.select().from(teams).where(eq(teams.id, channel.teamId)).limit(1);
    return team ? teamMemberIds(db, team) : [];
  }
  return (await db.select({ id: channelMembers.userId }).from(channelMembers).where(eq(channelMembers.channelId, channel.id))).map((r) => r.id);
}

export async function createChannel(ctx: TeamCtx, team: Team, user: { id: string }, input: { name: string; description?: string; kind: 'standard' | 'private'; memberIds?: string[]; general?: boolean }) {
  const name = input.name.trim();
  if (!name) throw new TeamError(400, 'Give the channel a name');
  const existing = await ctx.db.select({ id: channels.id }).from(channels).where(and(eq(channels.teamId, team.id), isNull(channels.archivedAt), sql`lower(${channels.name}) = ${name.toLowerCase()}`)).limit(1);
  if (existing.length) throw new TeamError(409, `There is already a channel called “${name}”`, 'name_conflict');
  const lib = await teamLibrary(ctx.db, team);
  // Files shared in the channel live in its folder in the team's library.
  const folder = await createFolder(ctx.drive, lib, null, name, user.id, 'rename');
  const [channel] = await ctx.db
    .insert(channels)
    .values({ orgId: team.orgId, teamId: team.id, kind: input.kind, name, description: input.description ?? '', folderId: folder.id, isGeneral: input.general ? 1 : 0, createdBy: user.id })
    .returning();
  if (input.kind === 'private') {
    // A private channel's folder is only for its members.
    await ctx.db.update(driveItems).set({ inheritPermissions: false }).where(eq(driveItems.id, folder.id));
    const members = [...new Set([user.id, ...(input.memberIds ?? [])])];
    const inTeam = new Set(await teamMemberIds(ctx.db, team));
    const outside = members.filter((m) => !inTeam.has(m));
    if (outside.length) throw new TeamError(400, 'Private channel members must be in the team', 'bad_member');
    await addChannelMembers(ctx, channel!, members, user.id);
  }
  return channel!;
}

export async function addChannelMembers(ctx: TeamCtx, channel: Channel, userIds: string[], ownerId?: string) {
  for (const id of [...new Set(userIds)]) {
    await ctx.db
      .insert(channelMembers)
      .values({ channelId: channel.id, userId: id, role: id === ownerId ? 'owner' : 'member', hiddenAt: null })
      .onConflictDoUpdate({ target: [channelMembers.channelId, channelMembers.userId], set: { hiddenAt: null } });
    if (channel.kind === 'private' && channel.folderId) {
      const [folder] = await ctx.db.select().from(driveItems).where(eq(driveItems.id, channel.folderId)).limit(1);
      const has = folder && (await ctx.db.select({ id: drivePermissions.id }).from(drivePermissions).where(and(eq(drivePermissions.itemId, folder.id), eq(drivePermissions.principalType, 'user'), eq(drivePermissions.principalId, id))).limit(1)).length;
      if (folder && !has) await ctx.db.insert(drivePermissions).values({ libraryId: folder.libraryId, itemId: folder.id, principalType: 'user', principalId: id, role: 'editor', createdBy: ownerId ?? null });
    }
  }
}

export async function removeChannelMembers(ctx: TeamCtx, channelId: string, userIds: string[]) {
  if (!userIds.length) return;
  const [channel] = await ctx.db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
  if (!channel) return;
  if (channel.kind === 'standard') return; // membership is the team's
  await ctx.db.delete(channelMembers).where(and(eq(channelMembers.channelId, channelId), inArray(channelMembers.userId, userIds)));
  if (channel.kind === 'private' && channel.folderId)
    await ctx.db.delete(drivePermissions).where(and(eq(drivePermissions.itemId, channel.folderId), eq(drivePermissions.principalType, 'user'), inArray(drivePermissions.principalId, userIds)));
}

/** A team's channels this person can see (standard ones, and private ones they're in). */
export async function teamChannels(db: Database, team: Team, userId: string) {
  const rows = await db
    .select({ channel: channels, member: channelMembers })
    .from(channels)
    .leftJoin(channelMembers, and(eq(channelMembers.channelId, channels.id), eq(channelMembers.userId, userId)))
    .where(and(eq(channels.teamId, team.id), isNull(channels.archivedAt)))
    .orderBy(sql`${channels.isGeneral} desc`, asc(channels.name));
  return rows.filter((r) => r.channel.kind === 'standard' || r.member);
}

// ---------------------------------------------------------------------------
// Chats (one-to-one and group chats, outside teams)
// ---------------------------------------------------------------------------

/** The chat between these people: the existing one-to-one chat, or a new chat. */
export async function openChat(ctx: TeamCtx, user: { id: string; orgId: string }, otherIds: string[], name?: string) {
  const others = await orgPeople(ctx.db, user.orgId, otherIds.filter((id) => id !== user.id));
  if (!others.length) throw new TeamError(400, 'Choose who to chat with');
  if (others.length === 1 && !name) {
    const dmKey = [user.id, others[0]!].sort().join(':');
    const [existing] = await ctx.db.select().from(channels).where(and(eq(channels.orgId, user.orgId), eq(channels.dmKey, dmKey))).limit(1);
    if (existing) {
      await ctx.db.update(channelMembers).set({ hiddenAt: null }).where(and(eq(channelMembers.channelId, existing.id), eq(channelMembers.userId, user.id)));
      return { channel: existing, created: false };
    }
    const [channel] = await ctx.db.insert(channels).values({ orgId: user.orgId, kind: 'dm', dmKey, createdBy: user.id }).returning();
    await addChannelMembers(ctx, channel!, [user.id, ...others]);
    return { channel: channel!, created: true };
  }
  const [channel] = await ctx.db.insert(channels).values({ orgId: user.orgId, kind: 'group', name: name?.trim() ?? '', createdBy: user.id }).returning();
  await addChannelMembers(ctx, channel!, [user.id, ...others], user.id);
  return { channel: channel!, created: true };
}

/**
 * Where files shared in a conversation are uploaded: the channel's folder,
 * or (chats) a "Chat files" folder in the sender's own library.
 */
export async function uploadTarget(ctx: TeamCtx, channel: Channel, user: { id: string; orgId: string }) {
  if (channel.folderId) {
    const [folder] = await ctx.db.select().from(driveItems).where(eq(driveItems.id, channel.folderId)).limit(1);
    if (folder && !folder.deletedAt) return { libraryId: folder.libraryId, parentId: folder.id };
    // The folder was deleted: make a new one.
    if (channel.teamId) {
      const [team] = await ctx.db.select().from(teams).where(eq(teams.id, channel.teamId)).limit(1);
      const lib = await teamLibrary(ctx.db, team!);
      const created = await createFolder(ctx.drive, lib, null, channel.name || 'Channel', user.id, 'rename');
      await ctx.db.update(channels).set({ folderId: created.id }).where(eq(channels.id, channel.id));
      return { libraryId: lib.id, parentId: created.id };
    }
  }
  const lib = await ensurePersonalLibrary(ctx.db, user);
  const [existing] = await ctx.db
    .select()
    .from(driveItems)
    .where(and(eq(driveItems.libraryId, lib.id), isNull(driveItems.parentId), eq(driveItems.kind, 'folder'), isNull(driveItems.deletedAt), eq(driveItems.name, 'Chat files')))
    .limit(1);
  const folder = existing ?? (await createFolder(ctx.drive, lib, null, 'Chat files', user.id, 'rename'));
  return { libraryId: lib.id, parentId: folder.id };
}

/** Files posted in a chat are shared (view) with the chat's members. */
export async function shareWithChat(ctx: TeamCtx, channel: Channel, itemIds: string[], by: string) {
  if (channel.kind !== 'dm' && channel.kind !== 'group') return;
  const audience = await channelAudience(ctx.db, channel);
  for (const itemId of itemIds) {
    const [item] = await ctx.db.select().from(driveItems).where(eq(driveItems.id, itemId)).limit(1);
    if (!item) continue;
    const [lib] = await ctx.db.select().from(driveLibraries).where(eq(driveLibraries.id, item.libraryId)).limit(1);
    for (const userId of audience) {
      if (userId === by || userId === lib?.ownerUserId) continue;
      const has = await ctx.db.select({ id: drivePermissions.id }).from(drivePermissions).where(and(eq(drivePermissions.itemId, item.id), eq(drivePermissions.principalType, 'user'), eq(drivePermissions.principalId, userId))).limit(1);
      if (!has.length) await ctx.db.insert(drivePermissions).values({ libraryId: item.libraryId, itemId: item.id, principalType: 'user', principalId: userId, role: 'viewer', createdBy: by });
    }
  }
}
