import { spawnSync } from 'node:child_process';
import { Type } from 'typebox';
import { purge } from '@forge/drive';
import { DEFAULT_TEAM_SETTINGS, channels, driveItems, driveLibraries, groupMembers, groups, meetings, orm, organizations, teams, users } from '@forge/db';
import type { AppContext } from '../../context';
import { notFound } from '../../errors';
import { authenticate, requirePermission } from '../../plugins/auth';
import type { App } from '../../types';
import { teamSettings } from '../team';

const { and, asc, eq, inArray, isNull, sql } = orm;

let ffmpegVersion: string | null | undefined;
const ffmpegStatus = (path: string) => {
  if (ffmpegVersion === undefined) {
    const r = spawnSync(path, ['-version'], { encoding: 'utf8', timeout: 5000 });
    ffmpegVersion = r.status === 0 ? (r.stdout.split('\n')[0] ?? 'ffmpeg') : null;
  }
  return ffmpegVersion;
};

/** Admin → ForgeTeam: meeting and team policies, every team, live meetings. */
export function adminTeamRoutes(app: App, ctx: AppContext) {
  const { db } = ctx;
  app.addHook('preHandler', authenticate(ctx));

  app.get('/api/v1/admin/team/settings', { preHandler: requirePermission(ctx, 'org:read'), schema: { tags: ['admin: team'], summary: 'ForgeTeam policies and meeting server status' } }, async (req) => {
    const rtc = ctx.config.team.rtc;
    return {
      settings: await teamSettings(ctx, req.principal!.orgId),
      status: {
        media: { announcedIp: rtc.announcedIp, ports: rtc.port ? `${rtc.port}` : `${rtc.minPort}–${rtc.maxPort}`, workers: rtc.workers, liveMeetings: (await ctx.team.media.live()).length },
        // Media servers running now (each hosts whole meetings).
        nodes: (await ctx.team.media.directory.nodes()).map((n) => ({ id: n.id, address: n.address, meetings: n.meetings.length, people: n.peers })),
        recording: ffmpegStatus(ctx.config.team.ffmpegPath),
      },
    };
  });

  app.put(
    '/api/v1/admin/team/settings',
    {
      preHandler: requirePermission(ctx, 'org:manage'),
      schema: {
        tags: ['admin: team'],
        summary: 'Set ForgeTeam policies',
        body: Type.Object({ guestAccess: Type.Boolean(), recording: Type.Boolean(), createTeams: Type.Union([Type.Literal('everyone'), Type.Literal('admins')]), maxParticipants: Type.Integer({ minimum: 2, maximum: 500 }) }),
      },
    },
    async (req) => {
      const before = await teamSettings(ctx, req.principal!.orgId);
      const settings = { ...DEFAULT_TEAM_SETTINGS, ...req.body };
      await db.update(organizations).set({ teamSettings: settings }).where(eq(organizations.id, req.principal!.orgId));
      await ctx.audit.fromRequest(req, { action: 'team.settings_updated', targetType: 'organization', targetId: req.principal!.orgId, metadata: { before, after: settings } });
      return { settings };
    },
  );

  app.get('/api/v1/admin/team/teams', { preHandler: requirePermission(ctx, 'groups:read'), schema: { tags: ['admin: team'], summary: 'Every team (not its messages)' } }, async (req) => {
    const rows = await db
      .select({
        id: teams.id,
        name: teams.name,
        description: teams.description,
        color: teams.color,
        visibility: teams.visibility,
        groupId: teams.groupId,
        archivedAt: teams.archivedAt,
        createdAt: teams.createdAt,
        // Correlated sub-queries: columns spelled out with their tables (Drizzle leaves them unqualified here).
        members: sql<number>`(select count(*)::int from group_members gm where gm.group_id = "teams"."group_id")`,
        channels: sql<number>`(select count(*)::int from channels c where c.team_id = "teams"."id" and c.archived_at is null)`,
        lastActivity: sql<Date | null>`(select max(c.last_message_at) from channels c where c.team_id = "teams"."id")`,
      })
      .from(teams)
      .where(eq(teams.orgId, req.principal!.orgId))
      .orderBy(asc(teams.name));
    const owners = rows.length
      ? await db
          .select({ groupId: groupMembers.groupId, name: users.displayName })
          .from(groupMembers)
          .innerJoin(users, eq(users.id, groupMembers.userId))
          .where(and(inArray(groupMembers.groupId, rows.map((r) => r.groupId)), eq(groupMembers.role, 'owner')))
      : [];
    return { items: rows.map((r) => ({ ...r, owners: owners.filter((o) => o.groupId === r.groupId).map((o) => o.name) })) };
  });

  const Params = Type.Object({ id: Type.String({ format: 'uuid' }) });
  const teamInOrg = async (orgId: string, id: string) => {
    const [team] = await db.select().from(teams).where(and(eq(teams.id, id), eq(teams.orgId, orgId))).limit(1);
    if (!team) throw notFound('Team');
    return team;
  };

  app.patch('/api/v1/admin/team/teams/:id', { preHandler: requirePermission(ctx, 'groups:manage'), schema: { tags: ['admin: team'], summary: 'Archive or restore a team', params: Params, body: Type.Object({ archived: Type.Boolean() }) } }, async (req) => {
    const team = await teamInOrg(req.principal!.orgId, req.params.id);
    await db.update(teams).set({ archivedAt: req.body.archived ? (team.archivedAt ?? new Date()) : null }).where(eq(teams.id, team.id));
    await ctx.audit.fromRequest(req, { action: req.body.archived ? 'team.archived' : 'team.restored', targetType: 'team', targetId: team.id, targetLabel: team.name });
    return { ok: true };
  });

  app.delete('/api/v1/admin/team/teams/:id', { preHandler: requirePermission(ctx, 'groups:manage'), schema: { tags: ['admin: team'], summary: 'Delete a team for good: its channels, messages, files and group', params: Params } }, async (req) => {
    const team = await teamInOrg(req.principal!.orgId, req.params.id);
    const [lib] = await db.select().from(driveLibraries).where(and(eq(driveLibraries.kind, 'group'), eq(driveLibraries.groupId, team.groupId))).limit(1);
    if (lib) {
      const roots = await db.select().from(driveItems).where(and(eq(driveItems.libraryId, lib.id), isNull(driveItems.parentId)));
      for (const r of roots) await purge(ctx.drive, r);
      await db.delete(driveLibraries).where(eq(driveLibraries.id, lib.id));
    }
    // The group goes too (its channels and messages with it).
    await db.delete(groups).where(eq(groups.id, team.groupId));
    await ctx.audit.fromRequest(req, { action: 'team.deleted', targetType: 'team', targetId: team.id, targetLabel: team.name });
    return { ok: true };
  });

  app.get('/api/v1/admin/team/meetings', { preHandler: requirePermission(ctx, 'org:read'), schema: { tags: ['admin: team'], summary: 'Meetings happening now' } }, async (req) => {
    const live = await ctx.team.media.live();
    const ids = live.map((m) => m.id);
    const rows = ids.length ? await db.select().from(meetings).where(and(inArray(meetings.id, ids), eq(meetings.orgId, req.principal!.orgId))) : [];
    return {
      items: rows.map((m) => {
        const l = live.find((x) => x.id === m.id)!;
        return { id: m.id, title: m.title, startedAt: m.startedAt, participants: l.peers, guests: l.guests, server: l.node };
      }),
    };
  });
}
