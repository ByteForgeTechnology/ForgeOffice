import { Type } from 'typebox';
import { domains, groupMembers, groups, orm, users, type Group } from '@forge/db';
import type { AppContext } from '../../context';
import { badRequest, conflict, isUniqueViolation, notFound } from '../../errors';
import { authenticate, requirePermission, type Principal } from '../../plugins/auth';
import { directoryCard } from '../../services/directory';
import type { App } from '../../types';

const { and, asc, count, eq, ilike, inArray, or } = orm;

const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });
const GroupType = Type.Union([Type.Literal('security'), Type.Literal('distribution')]);
const MemberRole = Type.Union([Type.Literal('owner'), Type.Literal('member')]);

function serializeGroup(g: Group, memberCount?: number) {
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    type: g.type,
    email: g.email,
    allowExternalSenders: g.allowExternalSenders,
    createdAt: g.createdAt.toISOString(),
    ...(memberCount !== undefined ? { memberCount } : {}),
  };
}

export function adminGroupRoutes(app: App, ctx: AppContext) {
  const { db } = ctx;
  app.addHook('preHandler', authenticate(ctx));

  const loadGroup = async (p: Principal, id: string) => {
    const [g] = await db.select().from(groups).where(and(eq(groups.id, id), eq(groups.orgId, p.orgId))).limit(1);
    if (!g) throw notFound('Group');
    return g;
  };

  /** Group addresses must sit on one of the organisation's domains and not clash with a user. */
  const validateEmail = async (p: Principal, email: string | null | undefined, type: 'security' | 'distribution') => {
    if (!email) {
      if (type === 'distribution') throw badRequest('Distribution lists need an email address');
      return null;
    }
    const normalised = email.trim().toLowerCase();
    const at = normalised.lastIndexOf('@');
    if (at < 1) throw badRequest('Invalid email address');
    const [domain] = await db
      .select()
      .from(domains)
      .where(and(eq(domains.orgId, p.orgId), eq(domains.name, normalised.slice(at + 1))))
      .limit(1);
    if (!domain) throw badRequest('The address must use one of your organisation’s domains');
    const [clash] = await db.select({ id: users.id }).from(users).where(eq(users.email, normalised)).limit(1);
    if (clash) throw conflict(`${normalised} is already used by a user`);
    return normalised;
  };

  app.get(
    '/api/v1/admin/groups',
    {
      preHandler: requirePermission(ctx, 'groups:read'),
      schema: {
        tags: ['admin: groups'],
        summary: 'List security groups and distribution lists',
        querystring: Type.Object({ q: Type.Optional(Type.String({ maxLength: 200 })), type: Type.Optional(GroupType) }),
      },
    },
    async (req) => {
      const { q, type } = req.query;
      const term = q?.trim() ? `%${q.trim()}%` : null;
      const rows = await db
        .select({ group: groups, memberCount: count(groupMembers.userId) })
        .from(groups)
        .leftJoin(groupMembers, eq(groupMembers.groupId, groups.id))
        .where(
          and(
            eq(groups.orgId, req.principal!.orgId),
            type ? eq(groups.type, type) : undefined,
            term ? or(ilike(groups.name, term), ilike(groups.email, term)) : undefined,
          ),
        )
        .groupBy(groups.id)
        .orderBy(asc(groups.name));
      return { items: rows.map((r) => serializeGroup(r.group, r.memberCount)) };
    },
  );

  app.post(
    '/api/v1/admin/groups',
    {
      preHandler: requirePermission(ctx, 'groups:manage'),
      schema: {
        tags: ['admin: groups'],
        summary: 'Create a group',
        body: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 120 }),
          description: Type.Optional(Type.String({ maxLength: 1000 })),
          type: GroupType,
          email: Type.Optional(Type.Union([Type.String({ maxLength: 320 }), Type.Null()])),
          allowExternalSenders: Type.Optional(Type.Boolean()),
          memberIds: Type.Optional(Type.Array(Type.String({ format: 'uuid' }), { maxItems: 1000 })),
        }),
      },
    },
    async (req, reply) => {
      const p = req.principal!;
      const b = req.body;
      const email = await validateEmail(p, b.email, b.type);
      let group: Group;
      try {
        [group] = (await db
          .insert(groups)
          .values({ orgId: p.orgId, name: b.name.trim(), description: b.description ?? '', type: b.type, email, allowExternalSenders: b.allowExternalSenders ?? false })
          .returning()) as [Group];
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('A group with that name or address already exists');
        throw err;
      }
      if (b.memberIds?.length) {
        const valid = await db.select({ id: users.id }).from(users).where(and(eq(users.orgId, p.orgId), inArray(users.id, b.memberIds)));
        if (valid.length) await db.insert(groupMembers).values(valid.map((u) => ({ groupId: group.id, userId: u.id })));
      }
      await ctx.audit.fromRequest(req, { action: 'group.created', targetType: 'group', targetId: group.id, targetLabel: group.name, metadata: { type: group.type } });
      reply.code(201);
      return { group: serializeGroup(group) };
    },
  );

  app.get(
    '/api/v1/admin/groups/:id',
    { preHandler: requirePermission(ctx, 'groups:read'), schema: { tags: ['admin: groups'], summary: 'Get a group with members', params: IdParams } },
    async (req) => {
      const g = await loadGroup(req.principal!, req.params.id);
      const members = await db
        .select({ user: users, role: groupMembers.role })
        .from(groupMembers)
        .innerJoin(users, eq(users.id, groupMembers.userId))
        .where(eq(groupMembers.groupId, g.id))
        .orderBy(asc(users.displayName));
      return { group: serializeGroup(g, members.length), members: members.map((m) => ({ ...directoryCard(m.user), status: m.user.status, role: m.role })) };
    },
  );

  app.patch(
    '/api/v1/admin/groups/:id',
    {
      preHandler: requirePermission(ctx, 'groups:manage'),
      schema: {
        tags: ['admin: groups'],
        summary: 'Update a group',
        params: IdParams,
        body: Type.Object({
          name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
          description: Type.Optional(Type.String({ maxLength: 1000 })),
          email: Type.Optional(Type.Union([Type.String({ maxLength: 320 }), Type.Null()])),
          allowExternalSenders: Type.Optional(Type.Boolean()),
        }),
      },
    },
    async (req) => {
      const p = req.principal!;
      const g = await loadGroup(p, req.params.id);
      const { email, name, ...rest } = req.body;
      const set: Partial<Group> = { ...rest, ...(name ? { name: name.trim() } : {}) };
      if (email !== undefined && email !== g.email) set.email = await validateEmail(p, email, g.type);
      try {
        const [updated] = await db.update(groups).set(set).where(eq(groups.id, g.id)).returning();
        await ctx.audit.fromRequest(req, { action: 'group.updated', targetType: 'group', targetId: g.id, targetLabel: updated!.name, metadata: { fields: Object.keys(req.body) } });
        return { group: serializeGroup(updated!) };
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('A group with that name or address already exists');
        throw err;
      }
    },
  );

  app.delete(
    '/api/v1/admin/groups/:id',
    { preHandler: requirePermission(ctx, 'groups:manage'), schema: { tags: ['admin: groups'], summary: 'Delete a group', params: IdParams } },
    async (req) => {
      const g = await loadGroup(req.principal!, req.params.id);
      await db.delete(groups).where(eq(groups.id, g.id));
      await ctx.audit.fromRequest(req, { action: 'group.deleted', targetType: 'group', targetId: g.id, targetLabel: g.name });
      return { ok: true };
    },
  );

  app.post(
    '/api/v1/admin/groups/:id/members',
    {
      preHandler: requirePermission(ctx, 'groups:manage'),
      schema: {
        tags: ['admin: groups'],
        summary: 'Add members (or change their role)',
        params: IdParams,
        body: Type.Object({ userIds: Type.Array(Type.String({ format: 'uuid' }), { minItems: 1, maxItems: 1000 }), role: Type.Optional(MemberRole) }),
      },
    },
    async (req) => {
      const p = req.principal!;
      const g = await loadGroup(p, req.params.id);
      const role = req.body.role ?? 'member';
      const valid = await db.select({ id: users.id, email: users.email }).from(users).where(and(eq(users.orgId, p.orgId), inArray(users.id, req.body.userIds)));
      if (!valid.length) throw badRequest('No valid users given');
      await db
        .insert(groupMembers)
        .values(valid.map((u) => ({ groupId: g.id, userId: u.id, role })))
        .onConflictDoUpdate({ target: [groupMembers.groupId, groupMembers.userId], set: { role } });
      await ctx.audit.fromRequest(req, { action: 'group.members_added', targetType: 'group', targetId: g.id, targetLabel: g.name, metadata: { members: valid.map((u) => u.email), role } });
      return { added: valid.length };
    },
  );

  app.delete(
    '/api/v1/admin/groups/:id/members/:userId',
    {
      preHandler: requirePermission(ctx, 'groups:manage'),
      schema: { tags: ['admin: groups'], summary: 'Remove a member', params: Type.Object({ id: Type.String({ format: 'uuid' }), userId: Type.String({ format: 'uuid' }) }) },
    },
    async (req) => {
      const g = await loadGroup(req.principal!, req.params.id);
      const removed = await db
        .delete(groupMembers)
        .where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.userId, req.params.userId)))
        .returning();
      if (!removed.length) throw notFound('Membership');
      await ctx.audit.fromRequest(req, { action: 'group.member_removed', targetType: 'group', targetId: g.id, targetLabel: g.name, metadata: { userId: req.params.userId } });
      return { ok: true };
    },
  );
}
