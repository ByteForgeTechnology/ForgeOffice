import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from 'typebox';
import { hasPermission } from '@forge/auth';
import { signToken, verifyToken } from '@forge/drive';
import {
  DEFAULT_TEAM_SETTINGS,
  calendarObjects,
  channelMembers,
  channels,
  groupMembers,
  meetings,
  teamMessages,
  orm,
  organizations,
  recordings,
  teams,
  users,
  type Channel,
  type Meeting,
  type TeamSettings,
} from '@forge/db';
import {
  PRESENCE_LABELS,
  TeamError,
  addChannelMembers,
  channelAudience,
  computePresence,
  createChannel,
  createTeam,
  deleteMessage,
  editMessage,
  listMessages,
  liveAttachments,
  listReplies,
  loadMessage,
  markRead,
  myTeams,
  notifyLevel,
  openChat,
  postMessage,
  react,
  removeChannelMembers,
  requireChannel,
  requireTeam,
  searchMessages,
  serialiseMessages,
  setManualPresence,
  setNotify,
  setTeamMembers,
  teamChannels,
  teamMemberIds,
  unreadCounts,
  uploadTarget,
  type TeamCtx,
} from '@forge/team';
import type { AppContext } from '../context';
import { HttpError, badRequest, forbidden, notFound } from '../errors';
import { authenticate } from '../plugins/auth';
import { avatarUrl } from '../services/avatars';
import type { App } from '../types';

const { and, asc, desc, eq, ilike, inArray, isNull, sql } = orm;

export async function teamSettings(ctx: AppContext, orgId: string): Promise<TeamSettings> {
  const [o] = await ctx.db.select({ s: organizations.teamSettings }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return { ...DEFAULT_TEAM_SETTINGS, ...(o?.s ?? {}) };
}

/** A new meeting code, the same shape as calendar meeting links (/team/meet/<code>). */
export const newMeetingCode = () => randomBytes(9).toString('base64url');

/** Meeting codes in calendar invitations become meetings when first opened. */
export async function meetingByCode(ctx: AppContext, code: string, orgIdForNew?: string): Promise<Meeting | null> {
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(code)) return null;
  const [existing] = await ctx.db.select().from(meetings).where(eq(meetings.code, code)).limit(1);
  if (existing) return existing;
  // Only codes that really are in a calendar event (so links can't be made up).
  const [event] = await ctx.db
    .select({ summary: calendarObjects.summary })
    .from(calendarObjects)
    .where(and(isNull(calendarObjects.deletedAt), sql`position(${`/team/meet/${code}`} in ${calendarObjects.ics}) > 0`))
    .limit(1);
  if (!event) return null;
  const [org] = orgIdForNew ? [{ id: orgIdForNew }] : await ctx.db.select({ id: organizations.id }).from(organizations).orderBy(asc(organizations.createdAt)).limit(1);
  if (!org) return null;
  const [created] = await ctx.db
    .insert(meetings)
    .values({ orgId: org.id, code, title: event.summary || 'Meeting' })
    .onConflictDoNothing()
    .returning();
  return created ?? (await ctx.db.select().from(meetings).where(eq(meetings.code, code)).limit(1))[0] ?? null;
}

/** ForgeTeam: teams, channels, chats, messages, presence, meetings and recordings. */
export function teamRoutes(app: App, ctx: AppContext) {
  const { db } = ctx;
  const tctx: TeamCtx = { db, drive: ctx.drive };
  const key = () => ctx.keys.shareLinkKey;
  const me = (req: { principal: { user: { id: string; orgId: string; displayName: string } } | null }) => req.principal!.user;

  // Recordings are fetched with signed URLs (so <video> can play them).
  const auth = authenticate(ctx);
  app.addHook('preHandler', async function (req, reply) {
    if (req.url.startsWith('/api/v1/team/media/') || req.url.startsWith('/api/v1/team/guest/')) return;
    await auth.call(this, req, reply);
  });

  const wrap = (err: unknown): never => {
    if (err instanceof TeamError) throw new HttpError(err.status, err.message, err.code);
    throw err;
  };
  const hub = () => ctx.team.hub;

  const channelSummary = (c: Channel, extra: Record<string, unknown> = {}) => ({ id: c.id, teamId: c.teamId, kind: c.kind, name: c.name, description: c.description, isGeneral: !!c.isGeneral, folderId: c.folderId, lastMessageAt: c.lastMessageAt, ...extra });

  /** Chat members' names, for chat titles. */
  const chatMembers = async (channelIds: string[]) => {
    if (!channelIds.length) return new Map<string, { id: string; name: string }[]>();
    const rows = await db.select({ channelId: channelMembers.channelId, id: users.id, name: users.displayName, avatarSha: users.avatarSha }).from(channelMembers).innerJoin(users, eq(users.id, channelMembers.userId)).where(inArray(channelMembers.channelId, channelIds));
    const out = new Map<string, { id: string; name: string; avatarUrl: string | null }[]>();
    for (const r of rows) out.set(r.channelId, [...(out.get(r.channelId) ?? []), { id: r.id, name: r.name, avatarUrl: avatarUrl(r) }]);
    return out;
  };

  /** Tell everyone who can read a conversation that something changed. */
  const broadcast = async (channel: Channel, event: string, payload: unknown) => hub().toUsers(await channelAudience(db, channel), event, payload);

  // ---------------------------------------------------------------------------
  // Home: my teams and channels, my chats, unread counts
  // ---------------------------------------------------------------------------

  app.get('/api/v1/team/home', { schema: { tags: ['team'], summary: 'Your teams, their channels and your chats, with unread counts' } }, async (req) => {
    const user = me(req);
    const mine = await myTeams(db, user.id);
    const teamRows = [];
    const allChannelIds: string[] = [];
    for (const { team, role } of mine) {
      const chans = await teamChannels(db, team, user.id);
      allChannelIds.push(...chans.map((c) => c.channel.id));
      teamRows.push({ team, role, chans });
    }
    const chats = await db
      .select({ channel: channels, member: channelMembers })
      .from(channels)
      .innerJoin(channelMembers, and(eq(channelMembers.channelId, channels.id), eq(channelMembers.userId, user.id)))
      .where(and(inArray(channels.kind, ['dm', 'group']), isNull(channels.archivedAt), isNull(channelMembers.hiddenAt)))
      .orderBy(desc(sql`coalesce(${channels.lastMessageAt}, ${channels.createdAt})`))
      .limit(200);
    allChannelIds.push(...chats.map((c) => c.channel.id));
    const counts = await unreadCounts(db, user.id, allChannelIds);
    const members = await chatMembers(chats.map((c) => c.channel.id));
    const settings = await teamSettings(ctx, user.orgId);
    const flags = (c: Channel) => {
      const n = counts.get(c.id);
      return { unread: n?.unread ?? 0, mentions: n?.mentions ?? 0, notify: notifyLevel(c, n?.notify) };
    };
    return {
      me: { id: user.id, name: user.displayName },
      canCreateTeams: settings.createTeams === 'everyone' || hasPermission(req.principal!.permissions, 'groups:manage'),
      teams: teamRows.map(({ team, role, chans }) => ({
        id: team.id,
        name: team.name,
        description: team.description,
        color: team.color,
        visibility: team.visibility,
        groupId: team.groupId,
        role,
        channels: chans.map(({ channel }) => channelSummary(channel, flags(channel))),
      })),
      chats: chats.map(({ channel }) => ({ ...channelSummary(channel, flags(channel)), members: members.get(channel.id) ?? [] })),
    };
  });

  // ---------------------------------------------------------------------------
  // Teams
  // ---------------------------------------------------------------------------

  app.post(
    '/api/v1/team/teams',
    {
      schema: {
        tags: ['team'],
        summary: 'Create a team (with a General channel and a document library)',
        body: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 80 }),
          description: Type.Optional(Type.String({ maxLength: 500 })),
          visibility: Type.Optional(Type.Union([Type.Literal('public'), Type.Literal('private')])),
          color: Type.Optional(Type.String({ pattern: '^#[0-9a-fA-F]{6}$' })),
          memberIds: Type.Optional(Type.Array(Type.String({ format: 'uuid' }), { maxItems: 500 })),
        }),
      },
    },
    async (req, reply) => {
      const user = me(req);
      const settings = await teamSettings(ctx, user.orgId);
      if (settings.createTeams === 'admins' && !hasPermission(req.principal!.permissions, 'groups:manage')) throw forbidden('Only administrators can create teams');
      const { team, general } = await createTeam(tctx, user, req.body).catch(wrap);
      await ctx.audit.fromRequest(req, { action: 'team.created', targetType: 'team', targetId: team.id, targetLabel: team.name });
      hub().toUsers(await teamMemberIds(db, team), 'team:changed', { teamId: team.id });
      reply.code(201);
      return { team, generalChannelId: general.id };
    },
  );

  app.get('/api/v1/team/teams/discover', { schema: { tags: ['team'], summary: 'Public teams you can join', querystring: Type.Object({ q: Type.Optional(Type.String({ maxLength: 100 })) }) } }, async (req) => {
    const user = me(req);
    const rows = await db
      .select({ team: teams, members: sql<number>`(select count(*)::int from group_members gm where gm.group_id = "teams"."group_id")` })
      .from(teams)
      .where(
        and(
          eq(teams.orgId, user.orgId),
          eq(teams.visibility, 'public'),
          isNull(teams.archivedAt),
          sql`not exists (select 1 from group_members gm where gm.group_id = "teams"."group_id" and gm.user_id = ${user.id})`,
          req.query.q ? ilike(teams.name, `%${req.query.q.replace(/[\\%_]/g, (c) => '\\' + c)}%`) : undefined,
        ),
      )
      .orderBy(asc(teams.name))
      .limit(100);
    return { items: rows.map((r) => ({ id: r.team.id, name: r.team.name, description: r.team.description, color: r.team.color, members: r.members })) };
  });

  const TeamParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

  app.post('/api/v1/team/teams/:id/join', { schema: { tags: ['team'], summary: 'Join a public team', params: TeamParams } }, async (req) => {
    const user = me(req);
    const [team] = await db.select().from(teams).where(and(eq(teams.id, req.params.id), eq(teams.orgId, user.orgId), isNull(teams.archivedAt))).limit(1);
    if (!team || team.visibility !== 'public') throw notFound('Team');
    await setTeamMembers(tctx, team, { add: [{ userId: user.id, role: (await requireTeam(db, user.id, user.orgId, team.id).catch(() => null))?.role ?? 'member' }] }).catch(wrap);
    hub().toUsers(await teamMemberIds(db, team), 'team:changed', { teamId: team.id });
    return { ok: true };
  });

  app.post('/api/v1/team/teams/:id/leave', { schema: { tags: ['team'], summary: 'Leave a team', params: TeamParams } }, async (req) => {
    const user = me(req);
    const { team } = await requireTeam(db, user.id, user.orgId, req.params.id).catch(wrap);
    const before = await teamMemberIds(db, team);
    await setTeamMembers(tctx, team, { remove: [user.id] }).catch(wrap);
    hub().toUsers(before, 'team:changed', { teamId: team.id });
    return { ok: true };
  });

  app.get('/api/v1/team/teams/:id', { schema: { tags: ['team'], summary: 'A team and its members', params: TeamParams } }, async (req) => {
    const user = me(req);
    const { team, role } = await requireTeam(db, user.id, user.orgId, req.params.id).catch(wrap);
    const members = await db
      .select({ id: users.id, name: users.displayName, email: users.email, jobTitle: users.jobTitle, role: groupMembers.role, avatarSha: users.avatarSha })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(eq(groupMembers.groupId, team.groupId))
      .orderBy(sql`${groupMembers.role} = 'owner' desc`, asc(users.displayName));
    const lib = await import('@forge/team').then((m) => m.teamLibrary(db, team));
    return { team, role, members: members.map(({ avatarSha, ...m }) => ({ ...m, avatarUrl: avatarUrl({ id: m.id, avatarSha }) })), libraryId: lib.id };
  });

  app.patch(
    '/api/v1/team/teams/:id',
    {
      schema: {
        tags: ['team'],
        summary: 'Change a team’s name, description, colour or privacy (owners)',
        params: TeamParams,
        body: Type.Object({ name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })), description: Type.Optional(Type.String({ maxLength: 500 })), visibility: Type.Optional(Type.Union([Type.Literal('public'), Type.Literal('private')])), color: Type.Optional(Type.String({ pattern: '^#[0-9a-fA-F]{6}$' })) }),
      },
    },
    async (req) => {
      const user = me(req);
      const { team } = await requireTeam(db, user.id, user.orgId, req.params.id, 'owner').catch(wrap);
      const [updated] = await db
        .update(teams)
        .set({ name: req.body.name?.trim() ?? team.name, description: req.body.description ?? team.description, visibility: req.body.visibility ?? team.visibility, color: req.body.color ?? team.color })
        .where(eq(teams.id, team.id))
        .returning();
      hub().toUsers(await teamMemberIds(db, team), 'team:changed', { teamId: team.id });
      return { team: updated };
    },
  );

  app.post(
    '/api/v1/team/teams/:id/members',
    {
      schema: {
        tags: ['team'],
        summary: 'Add, remove or change members (owners)',
        params: TeamParams,
        body: Type.Object({ add: Type.Optional(Type.Array(Type.Object({ userId: Type.String({ format: 'uuid' }), role: Type.Union([Type.Literal('owner'), Type.Literal('member')]) }), { maxItems: 500 })), remove: Type.Optional(Type.Array(Type.String({ format: 'uuid' }), { maxItems: 500 })) }),
      },
    },
    async (req) => {
      const user = me(req);
      const { team } = await requireTeam(db, user.id, user.orgId, req.params.id, 'owner').catch(wrap);
      const before = await teamMemberIds(db, team);
      await setTeamMembers(tctx, team, req.body).catch(wrap);
      await ctx.audit.fromRequest(req, { action: 'team.members_changed', targetType: 'team', targetId: team.id, targetLabel: team.name, metadata: { added: req.body.add?.length ?? 0, removed: req.body.remove?.length ?? 0 } });
      hub().toUsers([...new Set([...before, ...(await teamMemberIds(db, team))])], 'team:changed', { teamId: team.id });
      return { ok: true };
    },
  );

  app.delete('/api/v1/team/teams/:id', { schema: { tags: ['team'], summary: 'Archive a team (owners); its files and messages are kept', params: TeamParams } }, async (req) => {
    const user = me(req);
    const { team } = await requireTeam(db, user.id, user.orgId, req.params.id, 'owner').catch(wrap);
    await db.update(teams).set({ archivedAt: new Date() }).where(eq(teams.id, team.id));
    await ctx.audit.fromRequest(req, { action: 'team.archived', targetType: 'team', targetId: team.id, targetLabel: team.name });
    hub().toUsers(await teamMemberIds(db, team), 'team:changed', { teamId: team.id });
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Channels and chats
  // ---------------------------------------------------------------------------

  app.post(
    '/api/v1/team/teams/:id/channels',
    {
      schema: {
        tags: ['team'],
        summary: 'Add a channel (standard: the whole team; private: chosen members)',
        params: TeamParams,
        body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 50 }), description: Type.Optional(Type.String({ maxLength: 500 })), private: Type.Optional(Type.Boolean()), memberIds: Type.Optional(Type.Array(Type.String({ format: 'uuid' }), { maxItems: 250 })) }),
      },
    },
    async (req, reply) => {
      const user = me(req);
      const { team } = await requireTeam(db, user.id, user.orgId, req.params.id).catch(wrap);
      if (/[\\/:*?"<>|]/.test(req.body.name)) throw badRequest('Channel names can’t contain \\ / : * ? " < > |');
      const channel = await createChannel(tctx, team, user, { name: req.body.name, description: req.body.description, kind: req.body.private ? 'private' : 'standard', memberIds: req.body.memberIds }).catch(wrap);
      await broadcast(channel, 'team:changed', { teamId: team.id });
      reply.code(201);
      return { channel: channelSummary(channel) };
    },
  );

  app.post(
    '/api/v1/team/chats',
    { schema: { tags: ['team'], summary: 'Open a chat with people (the existing one-to-one chat, or a new group chat)', body: Type.Object({ userIds: Type.Array(Type.String({ format: 'uuid' }), { minItems: 1, maxItems: 100 }), name: Type.Optional(Type.String({ maxLength: 80 })) }) } },
    async (req) => {
      const user = me(req);
      const { channel, created } = await openChat(tctx, user, req.body.userIds, req.body.name).catch(wrap);
      if (created) await broadcast(channel, 'chat:changed', { channelId: channel.id });
      return { channel: channelSummary(channel), members: (await chatMembers([channel.id])).get(channel.id) ?? [] };
    },
  );

  const ChannelParams = Type.Object({ channelId: Type.String({ format: 'uuid' }) });
  const access = async (req: Parameters<typeof me>[0], channelId: string) => requireChannel(db, me(req).id, me(req).orgId, channelId).catch(wrap);

  app.get('/api/v1/team/channels/:channelId', { schema: { tags: ['team'], summary: 'A channel or chat, with its members (private channels and chats)', params: ChannelParams } }, async (req) => {
    const a = await access(req, req.params.channelId);
    const listed = a.channel.kind !== 'standard' ? ((await chatMembers([a.channel.id])).get(a.channel.id) ?? []) : [];
    const counts = await unreadCounts(db, me(req).id, [a.channel.id]);
    return {
      channel: channelSummary(a.channel),
      team: a.team ? { id: a.team.id, name: a.team.name, color: a.team.color } : null,
      members: listed,
      canManage: a.canManage,
      teamRole: a.teamRole,
      notify: notifyLevel(a.channel, counts.get(a.channel.id)?.notify),
      lastReadAt: counts.get(a.channel.id)?.lastReadAt ?? null,
    };
  });

  app.patch(
    '/api/v1/team/channels/:channelId',
    { schema: { tags: ['team'], summary: 'Rename a channel or group chat, or change its description', params: ChannelParams, body: Type.Object({ name: Type.Optional(Type.String({ maxLength: 80 })), description: Type.Optional(Type.String({ maxLength: 500 })) }) } },
    async (req) => {
      const a = await access(req, req.params.channelId);
      if (a.channel.kind === 'dm') throw badRequest('One-to-one chats have no name');
      if (!a.canManage) throw forbidden('Only owners can change this channel');
      if (a.channel.isGeneral && req.body.name && req.body.name !== a.channel.name) throw badRequest('The General channel can’t be renamed');
      const [updated] = await db.update(channels).set({ name: req.body.name?.trim() ?? a.channel.name, description: req.body.description ?? a.channel.description }).where(eq(channels.id, a.channel.id)).returning();
      await broadcast(updated!, a.channel.teamId ? 'team:changed' : 'chat:changed', { teamId: a.channel.teamId, channelId: a.channel.id });
      return { channel: channelSummary(updated!) };
    },
  );

  app.delete('/api/v1/team/channels/:channelId', { schema: { tags: ['team'], summary: 'Delete a channel (its files stay in the team’s library), or hide a chat', params: ChannelParams } }, async (req) => {
    const a = await access(req, req.params.channelId);
    if (a.channel.kind === 'dm' || a.channel.kind === 'group') {
      await db.update(channelMembers).set({ hiddenAt: new Date() }).where(and(eq(channelMembers.channelId, a.channel.id), eq(channelMembers.userId, me(req).id)));
      hub().toUsers([me(req).id], 'chat:changed', { channelId: a.channel.id });
      return { ok: true };
    }
    if (a.channel.isGeneral) throw badRequest('The General channel can’t be deleted');
    if (!a.canManage) throw forbidden('Only owners can delete this channel');
    const audience = await channelAudience(db, a.channel);
    await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, a.channel.id));
    hub().toUsers(audience, 'team:changed', { teamId: a.channel.teamId });
    return { ok: true };
  });

  app.post(
    '/api/v1/team/channels/:channelId/members',
    { schema: { tags: ['team'], summary: 'Add or remove people (private channels, group chats); leave with your own id', params: ChannelParams, body: Type.Object({ add: Type.Optional(Type.Array(Type.String({ format: 'uuid' }), { maxItems: 100 })), remove: Type.Optional(Type.Array(Type.String({ format: 'uuid' }), { maxItems: 100 })) }) } },
    async (req) => {
      const user = me(req);
      const a = await access(req, req.params.channelId);
      if (a.channel.kind === 'standard') throw badRequest('Everyone in the team is in its standard channels');
      if (a.channel.kind === 'dm') throw badRequest('Start a group chat to add people');
      const leavingOnly = !req.body.add?.length && req.body.remove?.length === 1 && req.body.remove[0] === user.id;
      if (!leavingOnly && a.channel.kind === 'private' && !a.canManage) throw forbidden('Only channel owners can change its members');
      const before = await channelAudience(db, a.channel);
      if (req.body.add?.length) {
        if (a.team) {
          const inTeam = new Set(await teamMemberIds(db, a.team));
          if (req.body.add.some((id) => !inTeam.has(id))) throw badRequest('Private channel members must be in the team');
        }
        const people = await db.select({ id: users.id }).from(users).where(and(inArray(users.id, req.body.add), eq(users.orgId, user.orgId), eq(users.status, 'active')));
        if (people.length !== new Set(req.body.add).size) throw badRequest('Some of those people are not in the organisation');
        await addChannelMembers(tctx, a.channel, req.body.add);
      }
      if (req.body.remove?.length) await removeChannelMembers(tctx, a.channel.id, req.body.remove);
      const names = async (ids: string[]) => (ids.length ? (await db.select({ name: users.displayName }).from(users).where(inArray(users.id, ids))).map((u) => u.name) : []);
      const added = await names(req.body.add ?? []);
      const removed = await names((req.body.remove ?? []).filter((id) => id !== user.id));
      const text = [added.length ? `added ${added.join(', ')}` : '', removed.length ? `removed ${removed.join(', ')}` : '', leavingOnly ? 'left' : ''].filter(Boolean).join(' and ');
      if (text) {
        const msg = await postMessage(tctx, a.channel, null, { body: `${user.displayName} ${text}`, kind: 'system' });
        hub().toUsers([...new Set([...before, ...(await channelAudience(db, a.channel))])], 'message:new', { message: msg });
      }
      hub().toUsers([...new Set([...before, ...(await channelAudience(db, a.channel))])], a.team ? 'team:changed' : 'chat:changed', { teamId: a.team?.id, channelId: a.channel.id });
      return { ok: true };
    },
  );

  app.put(
    '/api/v1/team/channels/:channelId/notify',
    { schema: { tags: ['team'], summary: 'Your notifications for this conversation: all, mentions or muted (null: the default)', params: ChannelParams, body: Type.Object({ notify: Type.Union([Type.Literal('all'), Type.Literal('mentions'), Type.Literal('muted'), Type.Null()]) }) } },
    async (req) => {
      const a = await access(req, req.params.channelId);
      await setNotify(db, a.channel.id, me(req).id, req.body.notify);
      hub().toUsers([me(req).id], 'channel:notify', { channelId: a.channel.id, notify: notifyLevel(a.channel, req.body.notify) });
      return { notify: notifyLevel(a.channel, req.body.notify) };
    },
  );

  app.post('/api/v1/team/channels/:channelId/read', { schema: { tags: ['team'], summary: 'Mark a conversation read', params: ChannelParams } }, async (req) => {
    const a = await access(req, req.params.channelId);
    await markRead(db, a.channel.id, me(req).id);
    // Other tabs and devices clear their badge too.
    hub().toUsers([me(req).id], 'channel:read', { channelId: a.channel.id });
    return { ok: true };
  });

  app.get('/api/v1/team/channels/:channelId/upload-target', { schema: { tags: ['team'], summary: 'Where to upload files shared here (then attach their ids to a message)', params: ChannelParams } }, async (req) => {
    const a = await access(req, req.params.channelId);
    return uploadTarget(tctx, a.channel, me(req)).catch(wrap);
  });

  app.get('/api/v1/team/channels/:channelId/files', { schema: { tags: ['team'], summary: 'Files shared in a conversation (newest first)', params: ChannelParams } }, async (req) => {
    const a = await access(req, req.params.channelId);
    const rows = await db
      .select({ id: teamMessages.id, authorId: teamMessages.authorId, attachments: teamMessages.attachments, createdAt: teamMessages.createdAt, name: users.displayName })
      .from(teamMessages)
      .leftJoin(users, eq(users.id, teamMessages.authorId))
      .where(and(eq(teamMessages.channelId, a.channel.id), isNull(teamMessages.deletedAt), sql`jsonb_array_length(${teamMessages.attachments}) > 0`))
      .orderBy(desc(teamMessages.createdAt))
      .limit(500);
    const live = await liveAttachments(db, rows.flatMap((r) => r.attachments.map((x) => x.itemId)));
    const target = a.channel.folderId ? await uploadTarget(tctx, a.channel, me(req)).catch(() => null) : null;
    return {
      folder: target ? { libraryId: target.libraryId, folderId: target.parentId } : null,
      items: rows.flatMap((r) => r.attachments.filter((x) => live.has(x.itemId)).map((x) => ({ ...x, messageId: r.id, sharedBy: r.name, sharedAt: r.createdAt }))),
    };
  });

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  app.get(
    '/api/v1/team/channels/:channelId/messages',
    { schema: { tags: ['team'], summary: 'Messages (newest last); page back with before', params: ChannelParams, querystring: Type.Object({ before: Type.Optional(Type.String({ format: 'date-time' })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }) } },
    async (req) => {
      const a = await access(req, req.params.channelId);
      return listMessages(db, a.channel.id, { before: req.query.before ? new Date(req.query.before) : undefined, limit: req.query.limit });
    },
  );

  const MessageParams = Type.Object({ channelId: Type.String({ format: 'uuid' }), messageId: Type.String({ format: 'uuid' }) });

  app.get('/api/v1/team/channels/:channelId/messages/:messageId/replies', { schema: { tags: ['team'], summary: 'A thread: the message and its replies', params: MessageParams } }, async (req) => {
    const a = await access(req, req.params.channelId);
    const root = await loadMessage(db, a.channel.id, req.params.messageId).catch(wrap);
    return { message: (await serialiseMessages(db, [root]))[0], replies: await listReplies(db, root.id) };
  });

  app.post(
    '/api/v1/team/channels/:channelId/messages',
    {
      schema: {
        tags: ['team'],
        summary: 'Post a message or a reply (markdown; mention people as <@user-id>; attach uploaded files by id)',
        params: ChannelParams,
        body: Type.Object({ body: Type.String({ maxLength: 28_000 }), parentId: Type.Optional(Type.String({ format: 'uuid' })), attachments: Type.Optional(Type.Array(Type.String({ format: 'uuid' }), { maxItems: 20 })) }),
      },
    },
    async (req, reply) => {
      const a = await access(req, req.params.channelId);
      if (a.channel.archivedAt) throw badRequest('This channel was deleted');
      const msg = await postMessage(tctx, a.channel, me(req), req.body).catch(wrap);
      await broadcast(a.channel, 'message:new', { message: msg, channel: { id: a.channel.id, kind: a.channel.kind, teamId: a.channel.teamId, name: a.channel.name } });
      reply.code(201);
      return { message: msg };
    },
  );

  app.patch('/api/v1/team/channels/:channelId/messages/:messageId', { schema: { tags: ['team'], summary: 'Edit your message', params: MessageParams, body: Type.Object({ body: Type.String({ maxLength: 28_000 }) }) } }, async (req) => {
    const a = await access(req, req.params.channelId);
    const msg = await loadMessage(db, a.channel.id, req.params.messageId).catch(wrap);
    const updated = await editMessage(tctx, a.channel, msg, me(req).id, req.body.body).catch(wrap);
    await broadcast(a.channel, 'message:updated', { message: updated });
    return { message: updated };
  });

  app.delete('/api/v1/team/channels/:channelId/messages/:messageId', { schema: { tags: ['team'], summary: 'Delete a message (yours; owners can delete any in their channels)', params: MessageParams } }, async (req) => {
    const a = await access(req, req.params.channelId);
    const msg = await loadMessage(db, a.channel.id, req.params.messageId).catch(wrap);
    const moderate = a.channel.kind !== 'dm' && a.channel.kind !== 'group' && a.canManage;
    const updated = await deleteMessage(tctx, msg, me(req).id, moderate).catch(wrap);
    await broadcast(a.channel, 'message:updated', { message: updated });
    return { message: updated };
  });

  app.put(
    '/api/v1/team/channels/:channelId/messages/:messageId/reactions',
    { schema: { tags: ['team'], summary: 'React to a message (on: true) or take a reaction back', params: MessageParams, body: Type.Object({ emoji: Type.String({ minLength: 1, maxLength: 16 }), on: Type.Boolean() }) } },
    async (req) => {
      const a = await access(req, req.params.channelId);
      const msg = await loadMessage(db, a.channel.id, req.params.messageId).catch(wrap);
      const updated = await react(tctx, msg, me(req).id, req.body.emoji, req.body.on).catch(wrap);
      await broadcast(a.channel, 'message:updated', { message: updated });
      return { message: updated };
    },
  );

  app.get('/api/v1/team/search', { schema: { tags: ['team'], summary: 'Search messages in your teams and chats', querystring: Type.Object({ q: Type.String({ minLength: 1, maxLength: 200 }) }) } }, async (req) => {
    const user = me(req);
    const ids: string[] = [];
    for (const { team } of await myTeams(db, user.id)) ids.push(...(await teamChannels(db, team, user.id)).map((c) => c.channel.id));
    ids.push(...(await db.select({ id: channelMembers.channelId }).from(channelMembers).innerJoin(channels, eq(channels.id, channelMembers.channelId)).where(and(eq(channelMembers.userId, user.id), inArray(channels.kind, ['dm', 'group'])))).map((r) => r.id));
    const found = await searchMessages(db, [...new Set(ids)], req.query.q);
    const names = new Map((await db.select({ id: channels.id, name: channels.name, kind: channels.kind, teamId: channels.teamId }).from(channels).where(inArray(channels.id, found.length ? [...new Set(found.map((m) => m.channelId))] : ['00000000-0000-0000-0000-000000000000']))).map((c) => [c.id, c]));
    return { items: found.map((m) => ({ ...m, channel: names.get(m.channelId) ?? null })) };
  });

  // ---------------------------------------------------------------------------
  // Presence
  // ---------------------------------------------------------------------------

  app.get('/api/v1/team/presence', { schema: { tags: ['team'], summary: 'Presence of people (Available, Busy, In a call, In a meeting, Away…)', querystring: Type.Object({ ids: Type.String({ maxLength: 20_000 }) }) } }, async (req) => {
    const ids = req.query.ids.split(',').filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 500);
    const people = ids.length ? await db.select({ id: users.id }).from(users).where(and(inArray(users.id, ids), eq(users.orgId, me(req).orgId))) : [];
    return { items: await computePresence(db, ctx.team.presence, people.map((p) => p.id)), labels: PRESENCE_LABELS };
  });

  app.put(
    '/api/v1/team/presence',
    {
      schema: {
        tags: ['team'],
        summary: 'Set your status (null: automatic), optionally until a time, and a status message',
        body: Type.Object({ status: Type.Union([Type.Literal('available'), Type.Literal('busy'), Type.Literal('dnd'), Type.Literal('away'), Type.Literal('offline'), Type.Null()]), until: Type.Optional(Type.Union([Type.String({ format: 'date-time' }), Type.Null()])), message: Type.Optional(Type.String({ maxLength: 280 })) }),
      },
    },
    async (req) => {
      const user = me(req);
      await setManualPresence(db, user.id, { status: req.body.status, until: req.body.until ? new Date(req.body.until) : null, message: req.body.message });
      const presence = (await computePresence(db, ctx.team.presence, [user.id]))[user.id]!;
      hub().toRoom(`org:${user.orgId}`, 'presence', { userId: user.id, ...presence });
      return { presence };
    },
  );

  // ---------------------------------------------------------------------------
  // Meetings and recordings
  // ---------------------------------------------------------------------------

  const serialiseMeeting = async (m: Meeting) => ({ id: m.id, code: m.code, title: m.title, channelId: m.channelId, startedAt: m.startedAt, endedAt: m.endedAt, url: `${ctx.config.publicUrl}/team/meet/${m.code}`, active: !!(await ctx.team.media.directory.nodeFor(m.id)) });

  app.post(
    '/api/v1/team/meetings',
    { schema: { tags: ['team'], summary: 'Start a meeting now (in a channel or chat, or on its own)', body: Type.Object({ channelId: Type.Optional(Type.String({ format: 'uuid' })), title: Type.Optional(Type.String({ maxLength: 200 })) }) } },
    async (req, reply) => {
      const user = me(req);
      let channel: Channel | null = null;
      if (req.body.channelId) channel = (await access(req, req.body.channelId)).channel;
      const title = req.body.title?.trim() || (channel ? (channel.kind === 'standard' || channel.kind === 'private' ? `Meeting in ${channel.name}` : 'Meeting') : `${user.displayName}’s meeting`);
      const [meeting] = await db.insert(meetings).values({ orgId: user.orgId, code: newMeetingCode(), channelId: channel?.id ?? null, title, createdBy: user.id }).returning();
      if (channel) {
        const msg = await postMessage(tctx, channel, user, { body: '', kind: 'meeting', meta: { meetingId: meeting!.id, code: meeting!.code, title } });
        await db.update(meetings).set({ messageId: msg.id }).where(eq(meetings.id, meeting!.id));
        await broadcast(channel, 'message:new', { message: msg, channel: { id: channel.id, kind: channel.kind, teamId: channel.teamId, name: channel.name } });
      }
      reply.code(201);
      return { meeting: await serialiseMeeting(meeting!) };
    },
  );

  app.get('/api/v1/team/meetings/:code', { schema: { tags: ['team'], summary: 'A meeting by its link code', params: Type.Object({ code: Type.String({ maxLength: 64 }) }) } }, async (req) => {
    const meeting = await meetingByCode(ctx, req.params.code, me(req).orgId);
    if (!meeting || meeting.orgId !== me(req).orgId) throw notFound('Meeting');
    if (meeting.channelId) await access(req, meeting.channelId);
    const settings = await teamSettings(ctx, meeting.orgId);
    const info = await ctx.team.media.info(meeting.id);
    return { meeting: await serialiseMeeting(meeting), participants: info?.peers.map((p) => ({ name: p.name, guest: p.guest })) ?? [], recordingAllowed: settings.recording, guestAccess: settings.guestAccess };
  });

  /** People outside the organisation: the meeting's title, and a guest pass to wait in its lobby. */
  app.get('/api/v1/team/guest/:code', { schema: { tags: ['team'], summary: 'A meeting, for a guest', params: Type.Object({ code: Type.String({ maxLength: 64 }) }) } }, async (req) => {
    const meeting = await meetingByCode(ctx, req.params.code);
    if (!meeting) throw notFound('Meeting');
    const settings = await teamSettings(ctx, meeting.orgId);
    const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, meeting.orgId)).limit(1);
    return { title: meeting.title, organisation: org?.name ?? '', guestAccess: settings.guestAccess };
  });

  app.post(
    '/api/v1/team/guest/:code',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } }, schema: { tags: ['team'], summary: 'Get a guest pass for a meeting (then wait to be admitted)', params: Type.Object({ code: Type.String({ maxLength: 64 }) }), body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 60 }) }) } },
    async (req) => {
      const meeting = await meetingByCode(ctx, req.params.code);
      if (!meeting) throw notFound('Meeting');
      if (!(await teamSettings(ctx, meeting.orgId)).guestAccess) throw forbidden('This organisation doesn’t allow guests in meetings');
      const name = req.body.name.trim().replace(/[\u0000-\u001f]/g, '');
      if (!name) throw badRequest('Enter your name');
      return { token: signToken(key(), { p: 'team-guest', m: meeting.id, n: name, g: randomBytes(8).toString('hex') }, 12 * 3600) };
    },
  );

  app.get('/api/v1/team/recordings/:id/url', { schema: { tags: ['team'], summary: 'A short-lived URL to play or download a recording', params: TeamParams } }, async (req) => {
    const [row] = await db.select({ rec: recordings, meeting: meetings }).from(recordings).innerJoin(meetings, eq(meetings.id, recordings.meetingId)).where(eq(recordings.id, req.params.id)).limit(1);
    if (!row || row.meeting.orgId !== me(req).orgId) throw notFound('Recording');
    // Whoever can read the conversation it was posted in, or who started it.
    if (row.meeting.channelId) await access(req, row.meeting.channelId);
    else if (row.rec.startedBy !== me(req).id && row.meeting.createdBy !== me(req).id) throw notFound('Recording');
    return { url: `/api/v1/team/media/${signToken(key(), { p: 'team-rec', r: row.rec.id }, 6 * 3600)}` };
  });

  app.get('/api/v1/team/media/:token', { schema: { tags: ['team'], summary: 'Recording content from a signed URL (supports Range)', params: Type.Object({ token: Type.String({ maxLength: 2000 }) }), querystring: Type.Object({ download: Type.Optional(Type.Boolean()) }) } }, async (req, reply) => {
    const claims = verifyToken<{ r: string }>(key(), req.params.token, 'team-rec');
    if (!claims) throw forbidden('This link has expired');
    const [rec] = await db.select().from(recordings).where(eq(recordings.id, claims.r)).limit(1);
    if (!rec) throw notFound('Recording');
    // Recordings are in storage ("blob:<sha256>"); older ones are files on forge_team_media.
    const sha = rec.path.startsWith('blob:') ? rec.path.slice(5) : null;
    const path = sha ? null : join(ctx.config.volumes.team.path, rec.path);
    const size = sha ? await ctx.team.recordings.size(sha).catch(() => 0) : (await stat(path!).catch(() => null))?.size;
    if (!size) throw notFound('Recording');
    const open = (range?: { start: number; end: number }) => (sha ? ctx.team.recordings.createReadStream(sha, range) : createReadStream(path!, range));
    reply.header('Accept-Ranges', 'bytes').header('Content-Type', 'video/webm').header('Cache-Control', 'private, max-age=3600');
    if (req.query.download) reply.header('Content-Disposition', `attachment; filename="recording-${rec.createdAt.toISOString().slice(0, 16).replace(/[:T]/g, '-')}.webm"`);
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size || start > end) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      return reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`).header('Content-Length', end - start + 1).send(open({ start, end }));
    }
    return reply.header('Content-Length', size).send(open());
  });

}
