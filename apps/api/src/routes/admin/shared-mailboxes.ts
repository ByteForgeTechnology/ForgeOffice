import { randomBytes } from 'node:crypto';
import { Type, type Static } from 'typebox';
import { groups, mailboxPermissions, messages, orm, users, type User } from '@forge/db';
import { ensureMailboxes } from '@forge/mail';
import type { AppContext } from '../../context';
import { badRequest, conflict, notFound } from '../../errors';
import { revokeAccount } from '../../oidc/adapter';
import { authenticate, requirePermission } from '../../plugins/auth';
import { createUser, getPrimaryOrg } from '../../services/directory';
import type { App } from '../../types';

const { and, asc, count, eq, inArray, ne } = orm;
const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

const Grant = Type.Object({
  principalType: Type.Union([Type.Literal('user'), Type.Literal('group')]),
  principalId: Type.String({ format: 'uuid' }),
  access: Type.Union([Type.Literal('none'), Type.Literal('read'), Type.Literal('full')]),
  sendAs: Type.Boolean(),
  sendOnBehalf: Type.Boolean(),
});

export function adminSharedMailboxRoutes(app: App, ctx: AppContext) {
  const { db } = ctx;
  app.addHook('preHandler', authenticate(ctx));

  const load = async (orgId: string, id: string): Promise<User> => {
    const [u] = await db.select().from(users).where(and(eq(users.id, id), eq(users.orgId, orgId), eq(users.kind, 'shared'))).limit(1);
    if (!u) throw notFound('Shared mailbox');
    return u;
  };

  const grantsFor = async (ownerId: string) => {
    const rows = await db.select().from(mailboxPermissions).where(eq(mailboxPermissions.ownerId, ownerId)).orderBy(asc(mailboxPermissions.createdAt));
    const userIds = rows.filter((r) => r.principalType === 'user').map((r) => r.principalId);
    const groupIds = rows.filter((r) => r.principalType === 'group').map((r) => r.principalId);
    const people = userIds.length ? await db.select({ id: users.id, name: users.displayName, email: users.email }).from(users).where(inArray(users.id, userIds)) : [];
    const teams = groupIds.length ? await db.select({ id: groups.id, name: groups.name, email: groups.email }).from(groups).where(inArray(groups.id, groupIds)) : [];
    return rows.map((r) => {
      const who = r.principalType === 'user' ? people.find((p) => p.id === r.principalId) : teams.find((g) => g.id === r.principalId);
      return { principalType: r.principalType, principalId: r.principalId, name: who?.name ?? 'Unknown', email: who?.email ?? null, access: r.access, sendAs: r.sendAs, sendOnBehalf: r.sendOnBehalf };
    });
  };

  const serialize = (u: User, extra: Record<string, unknown> = {}) => ({
    id: u.id,
    displayName: u.displayName,
    email: u.email,
    status: u.status,
    quotaBytes: u.quotaBytes,
    usedBytes: u.usedBytes,
    createdAt: u.createdAt.toISOString(),
    ...extra,
  });

  app.get('/api/v1/admin/shared-mailboxes', { preHandler: requirePermission(ctx, 'users:read'), schema: { tags: ['admin: mail'], summary: 'Shared mailboxes' } }, async (req) => {
    const rows = await db
      .select({ user: users, grants: count(mailboxPermissions.id) })
      .from(users)
      .leftJoin(mailboxPermissions, eq(mailboxPermissions.ownerId, users.id))
      .where(and(eq(users.orgId, req.principal!.orgId), eq(users.kind, 'shared'), ne(users.status, 'deleted')))
      .groupBy(users.id)
      .orderBy(asc(users.displayName));
    return { items: rows.map((r) => serialize(r.user, { grantCount: r.grants })) };
  });

  app.post(
    '/api/v1/admin/shared-mailboxes',
    {
      preHandler: requirePermission(ctx, 'users:manage'),
      schema: {
        tags: ['admin: mail'],
        summary: 'Create a shared mailbox',
        body: Type.Object({
          displayName: Type.String({ minLength: 1, maxLength: 200 }),
          username: Type.String({ minLength: 1, maxLength: 64 }),
          domainId: Type.Optional(Type.String({ format: 'uuid' })),
          grants: Type.Array(Grant, { maxItems: 200, default: [] }),
        }),
      },
    },
    async (req, reply) => {
      const p = req.principal!;
      // No one signs in as a shared mailbox: the password is random and never revealed.
      const user = await createUser(db, {
        orgId: p.orgId,
        username: req.body.username,
        domainId: req.body.domainId,
        displayName: req.body.displayName,
        password: `${randomBytes(24).toString('base64url')}Aa1!`,
        kind: 'shared',
      });
      await ensureMailboxes(ctx.mail, user.id);
      if (req.body.grants.length) await replaceGrants(user.id, req.body.grants as Static<typeof Grant>[]);
      await ctx.audit.fromRequest(req, { action: 'shared_mailbox.created', targetType: 'user', targetId: user.id, targetLabel: user.email, metadata: { grants: req.body.grants.length } });
      reply.code(201);
      return { mailbox: serialize(user) };
    },
  );

  app.get('/api/v1/admin/shared-mailboxes/:id', { preHandler: requirePermission(ctx, 'users:read'), schema: { tags: ['admin: mail'], summary: 'A shared mailbox and who can access it', params: IdParams } }, async (req) => {
    const u = await load(req.principal!.orgId, req.params.id);
    const [stats] = await db.select({ n: count() }).from(messages).where(eq(messages.userId, u.id));
    const org = await getPrimaryOrg(db);
    return { mailbox: serialize(u, { messageCount: stats?.n ?? 0, effectiveQuotaBytes: u.quotaBytes ?? org?.defaultQuotaBytes ?? null }), grants: await grantsFor(u.id) };
  });

  app.patch(
    '/api/v1/admin/shared-mailboxes/:id',
    {
      preHandler: requirePermission(ctx, 'users:manage'),
      schema: {
        tags: ['admin: mail'],
        summary: 'Rename or change the quota of a shared mailbox',
        params: IdParams,
        body: Type.Object({ displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), quotaBytes: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])) }),
      },
    },
    async (req) => {
      const u = await load(req.principal!.orgId, req.params.id);
      const [updated] = await db.update(users).set(req.body).where(eq(users.id, u.id)).returning();
      await ctx.audit.fromRequest(req, { action: 'shared_mailbox.updated', targetType: 'user', targetId: u.id, targetLabel: u.email, metadata: { fields: Object.keys(req.body) } });
      return { mailbox: serialize(updated!) };
    },
  );

  const replaceGrants = async (ownerId: string, grants: Static<typeof Grant>[]) => {
    const userIds = grants.filter((g) => g.principalType === 'user').map((g) => g.principalId);
    const groupIds = grants.filter((g) => g.principalType === 'group').map((g) => g.principalId);
    if (userIds.length) {
      const found = await db.select({ id: users.id, kind: users.kind }).from(users).where(inArray(users.id, userIds));
      if (found.length !== new Set(userIds).size || found.some((f) => f.kind === 'shared')) throw badRequest('Access can only be granted to people or groups');
      if (userIds.includes(ownerId)) throw badRequest('A mailbox cannot be granted access to itself');
    }
    if (groupIds.length) {
      const found = await db.select({ id: groups.id }).from(groups).where(inArray(groups.id, groupIds));
      if (found.length !== new Set(groupIds).size) throw badRequest('One or more groups do not exist');
    }
    const keys = grants.map((g) => `${g.principalType}:${g.principalId}`);
    if (new Set(keys).size !== keys.length) throw conflict('Each person or group can only be listed once');
    await db.transaction(async (tx) => {
      await tx.delete(mailboxPermissions).where(eq(mailboxPermissions.ownerId, ownerId));
      if (grants.length) await tx.insert(mailboxPermissions).values(grants.map((g) => ({ ...g, ownerId })));
    });
  };

  app.put(
    '/api/v1/admin/shared-mailboxes/:id/permissions',
    {
      preHandler: requirePermission(ctx, 'users:manage'),
      schema: { tags: ['admin: mail'], summary: 'Replace who can access a shared mailbox', params: IdParams, body: Type.Object({ grants: Type.Array(Grant, { maxItems: 200 }) }) },
    },
    async (req) => {
      const u = await load(req.principal!.orgId, req.params.id);
      const before = await grantsFor(u.id);
      await replaceGrants(u.id, req.body.grants as Static<typeof Grant>[]);
      const after = await grantsFor(u.id);
      await ctx.audit.fromRequest(req, {
        action: 'shared_mailbox.permissions_changed',
        targetType: 'user',
        targetId: u.id,
        targetLabel: u.email,
        metadata: {
          before: before.map((g) => `${g.name}: ${g.access}${g.sendAs ? '+send-as' : ''}${g.sendOnBehalf ? '+on-behalf' : ''}`),
          after: after.map((g) => `${g.name}: ${g.access}${g.sendAs ? '+send-as' : ''}${g.sendOnBehalf ? '+on-behalf' : ''}`),
        },
      });
      return { grants: after };
    },
  );

  app.delete('/api/v1/admin/shared-mailboxes/:id', { preHandler: requirePermission(ctx, 'users:manage'), schema: { tags: ['admin: mail'], summary: 'Delete a shared mailbox (purged after the retention period)', params: IdParams } }, async (req) => {
    const u = await load(req.principal!.orgId, req.params.id);
    await db.update(users).set({ status: 'deleted', deletedAt: new Date() }).where(eq(users.id, u.id));
    await db.delete(mailboxPermissions).where(eq(mailboxPermissions.ownerId, u.id));
    await revokeAccount(db, u.id);
    await ctx.audit.fromRequest(req, { action: 'shared_mailbox.deleted', targetType: 'user', targetId: u.id, targetLabel: u.email });
    return { ok: true };
  });

}
