import { randomInt } from 'node:crypto';
import { listSessions } from '../sessions';
import { revokeSessions } from '../../services/sessions';
import { Type } from 'typebox';
import { GLOBAL_ADMIN, canGrant, checkPasswordPolicy, hashPassword, resolvePermissions } from '@forge/auth';
import { groupMembers, groups, orm, roles, userRoles, users, type User } from '@forge/db';
import type { AppContext } from '../../context';
import { badRequest, conflict, forbidden, notFound } from '../../errors';
import { revokeAccount } from '../../oidc/adapter';
import { authenticate, requirePermission, type Principal } from '../../plugins/auth';
import { CONTACT_FIELDS, cleanContact, countActiveGlobalAdmins, createUser, effectiveQuota, getPrimaryOrg, serializeUser, userRoleKeys } from '../../services/directory';
import type { App } from '../../types';

const { and, asc, count, desc, eq, ilike, inArray, ne, or } = orm;

const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });
const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(t: T) => Type.Union([t, Type.Null()]);
const contactField = (max = 200) => Type.Optional(Nullable(Type.String({ maxLength: max })));
const ContactBody = {
  company: contactField(),
  officeLocation: contactField(),
  workPhone: contactField(50),
  mobilePhone: contactField(50),
  website: contactField(300),
  streetAddress: contactField(300),
  city: contactField(100),
  region: contactField(100),
  postalCode: contactField(20),
  country: contactField(100),
  pronouns: contactField(50),
};

/** Human-friendly temporary password satisfying the policy (4 groups of 4). */
export function generateTemporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const groupsOf = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join(''));
  return groupsOf.join('-');
}

export function adminUserRoutes(app: App, ctx: AppContext) {
  const { db } = ctx;
  app.addHook('preHandler', authenticate(ctx));

  const loadTarget = async (p: Principal, id: string): Promise<User> => {
    const [user] = await db.select().from(users).where(and(eq(users.id, id), eq(users.orgId, p.orgId))).limit(1);
    if (!user) throw notFound('User');
    return user;
  };

  /** Actors may only manage users whose privileges they fully hold themselves. */
  const assertCanManage = async (p: Principal, target: User) => {
    if (target.id === p.user.id) return;
    const targetRoles = await db
      .select({ permissions: roles.permissions })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, target.id));
    if (!canGrant(p.permissions, resolvePermissions(targetRoles))) {
      throw forbidden('You cannot manage a user who has more privileges than you');
    }
  };

  const assertNotLastAdmin = async (target: User) => {
    const keys = await userRoleKeys(db, target.id);
    if (keys.includes(GLOBAL_ADMIN) && target.status === 'active' && (await countActiveGlobalAdmins(db, target.orgId)) <= 1) {
      throw conflict('This is the last active global administrator. Assign the role to someone else first.');
    }
  };

  const publish = (orgId: string, userId: string, change: 'created' | 'updated' | 'suspended' | 'unsuspended' | 'deleted' | 'restored' | 'roles') =>
    ctx.bus?.publish('user.updated', { orgId, userId, change }).catch(() => {});

  app.get(
    '/api/v1/admin/users',
    {
      preHandler: requirePermission(ctx, 'users:read'),
      schema: {
        tags: ['admin: users'],
        summary: 'List and search users',
        querystring: Type.Object({
          q: Type.Optional(Type.String({ maxLength: 200 })),
          status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('suspended'), Type.Literal('deleted'), Type.Literal('all')])),
          limit: Type.Integer({ minimum: 1, maximum: 200, default: 50 }),
          offset: Type.Integer({ minimum: 0, default: 0 }),
          sort: Type.Union([Type.Literal('name'), Type.Literal('created'), Type.Literal('lastLogin')], { default: 'name' }),
        }),
      },
    },
    async (req) => {
      const { q, status, limit, offset, sort } = req.query;
      const term = q?.trim() ? `%${q.trim().replace(/[\\%_]/g, (c) => '\\' + c)}%` : null;
      const where = and(
        eq(users.orgId, req.principal!.orgId),
        eq(users.kind, 'person'),
        status && status !== 'all' ? eq(users.status, status) : ne(users.status, 'deleted'),
        term ? or(ilike(users.displayName, term), ilike(users.email, term), ilike(users.department, term), ilike(users.jobTitle, term)) : undefined,
      );
      const order = sort === 'created' ? desc(users.createdAt) : sort === 'lastLogin' ? desc(users.lastLoginAt) : asc(users.displayName);
      const [rows, [total]] = await Promise.all([
        db.select().from(users).where(where).orderBy(order).limit(limit).offset(offset),
        db.select({ n: count() }).from(users).where(where),
      ]);
      const roleRows = rows.length
        ? await db
            .select({ userId: userRoles.userId, key: roles.key })
            .from(userRoles)
            .innerJoin(roles, eq(roles.id, userRoles.roleId))
            .where(inArray(userRoles.userId, rows.map((r) => r.id)))
        : [];
      return {
        items: rows.map((u) => serializeUser(u, { roles: roleRows.filter((r) => r.userId === u.id).map((r) => r.key) })),
        total: total?.n ?? 0,
      };
    },
  );

  app.post(
    '/api/v1/admin/users',
    {
      preHandler: requirePermission(ctx, 'users:manage'),
      schema: {
        tags: ['admin: users'],
        summary: 'Create a user',
        body: Type.Object({
          username: Type.String({ minLength: 1, maxLength: 64 }),
          domainId: Type.Optional(Type.String({ format: 'uuid' })),
          displayName: Type.String({ minLength: 1, maxLength: 200 }),
          givenName: Type.Optional(Type.String({ maxLength: 100 })),
          familyName: Type.Optional(Type.String({ maxLength: 100 })),
          jobTitle: Type.Optional(Type.String({ maxLength: 200 })),
          department: Type.Optional(Type.String({ maxLength: 200 })),
          ...ContactBody,
          password: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
          mustChangePassword: Type.Optional(Type.Boolean()),
          mfaRequired: Type.Optional(Type.Boolean()),
          quotaBytes: Type.Optional(Nullable(Type.Integer({ minimum: 0 }))),
          roles: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
          groupIds: Type.Optional(Type.Array(Type.String({ format: 'uuid' }), { maxItems: 100 })),
        }),
      },
    },
    async (req, reply) => {
      const p = req.principal!;
      const b = req.body;
      if (b.roles?.length) {
        if (!p.permissions.has('roles:manage')) throw forbidden('Assigning roles requires the roles:manage permission');
        const wanted = await db.select().from(roles).where(and(eq(roles.orgId, p.orgId), inArray(roles.key, b.roles)));
        if (!canGrant(p.permissions, resolvePermissions(wanted))) throw forbidden('You cannot grant permissions you do not hold');
      }
      const temporary = b.password ? null : generateTemporaryPassword();
      const user = await createUser(db, {
        orgId: p.orgId,
        username: b.username,
        domainId: b.domainId,
        displayName: b.displayName,
        givenName: b.givenName,
        familyName: b.familyName,
        jobTitle: b.jobTitle,
        department: b.department,
        ...cleanContact(b),
        password: b.password ?? temporary!,
        mustChangePassword: temporary ? true : (b.mustChangePassword ?? true),
        mfaRequired: b.mfaRequired,
        quotaBytes: b.quotaBytes,
        roleKeys: b.roles,
      });
      if (b.groupIds?.length) {
        const valid = await db.select({ id: groups.id }).from(groups).where(and(eq(groups.orgId, p.orgId), inArray(groups.id, b.groupIds)));
        if (valid.length) await db.insert(groupMembers).values(valid.map((g) => ({ groupId: g.id, userId: user.id }))).onConflictDoNothing();
      }
      await ctx.audit.fromRequest(req, {
        action: 'user.created',
        targetType: 'user',
        targetId: user.id,
        targetLabel: user.email,
        metadata: { roles: b.roles ?? [], groups: b.groupIds?.length ?? 0, mfaRequired: !!b.mfaRequired },
      });
      void publish(p.orgId, user.id, 'created');
      reply.code(201);
      return { user: serializeUser(user, { roles: b.roles ?? [] }), temporaryPassword: temporary };
    },
  );

  app.get(
    '/api/v1/admin/users/:id',
    { preHandler: requirePermission(ctx, 'users:read'), schema: { tags: ['admin: users'], summary: 'Get a user', params: IdParams } },
    async (req) => {
      const user = await loadTarget(req.principal!, req.params.id);
      const memberOf = await db
        .select({ id: groups.id, name: groups.name, type: groups.type, role: groupMembers.role })
        .from(groupMembers)
        .innerJoin(groups, eq(groups.id, groupMembers.groupId))
        .where(eq(groupMembers.userId, user.id))
        .orderBy(asc(groups.name));
      const org = await getPrimaryOrg(db);
      return {
        user: serializeUser(user, { roles: await userRoleKeys(db, user.id) }),
        effectiveQuotaBytes: org ? effectiveQuota(user, org) : null,
        groups: memberOf,
      };
    },
  );

  app.patch(
    '/api/v1/admin/users/:id',
    {
      preHandler: requirePermission(ctx, 'users:manage'),
      schema: {
        tags: ['admin: users'],
        summary: 'Update a user',
        params: IdParams,
        body: Type.Object({
          displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
          givenName: Type.Optional(Nullable(Type.String({ maxLength: 100 }))),
          familyName: Type.Optional(Nullable(Type.String({ maxLength: 100 }))),
          jobTitle: Type.Optional(Nullable(Type.String({ maxLength: 200 }))),
          department: Type.Optional(Nullable(Type.String({ maxLength: 200 }))),
          ...ContactBody,
          mfaRequired: Type.Optional(Type.Boolean()),
          quotaBytes: Type.Optional(Nullable(Type.Integer({ minimum: 0 }))),
        }),
      },
    },
    async (req) => {
      const p = req.principal!;
      const target = await loadTarget(p, req.params.id);
      await assertCanManage(p, target);
      const { displayName, ...rest } = req.body;
      const contact = cleanContact(rest);
      for (const k of CONTACT_FIELDS) delete (rest as Record<string, unknown>)[k];
      const [user] = await db
        .update(users)
        .set({ ...rest, ...contact, ...(displayName ? { displayName: displayName.trim() } : {}) })
        .where(eq(users.id, target.id))
        .returning();
      await ctx.audit.fromRequest(req, { action: 'user.updated', targetType: 'user', targetId: target.id, targetLabel: target.email, metadata: { fields: Object.keys(req.body) } });
      void publish(p.orgId, target.id, 'updated');
      return { user: serializeUser(user!, { roles: await userRoleKeys(db, target.id) }) };
    },
  );

  app.get(
    '/api/v1/admin/users/:id/sessions',
    { preHandler: requirePermission(ctx, 'users:read'), schema: { tags: ['admin: users'], summary: 'Browsers and devices the user is signed in on', params: IdParams } },
    async (req) => {
      const target = await loadTarget(req.principal!, req.params.id);
      return { items: await listSessions(db, target.id) };
    },
  );

  app.post(
    '/api/v1/admin/users/:id/sessions/revoke',
    { preHandler: requirePermission(ctx, 'users:manage'), schema: { tags: ['admin: users'], summary: 'Sign the user out of every browser and device', params: IdParams } },
    async (req) => {
      const p = req.principal!;
      const target = await loadTarget(p, req.params.id);
      await assertCanManage(p, target);
      const n = await revokeSessions(db, target.id);
      await ctx.audit.fromRequest(req, { action: 'auth.sessions_revoked', targetType: 'user', targetId: target.id, targetLabel: target.email, metadata: { sessions: n, byAdmin: true } });
      return { signedOut: n };
    },
  );

  const lifecycle = (
    path: string,
    summary: string,
    handler: (target: User, p: Principal) => Promise<{ set: Partial<User>; action: string; change: Parameters<typeof publish>[2]; revoke?: boolean }>,
  ) =>
    app.post(
      `/api/v1/admin/users/:id/${path}`,
      { preHandler: requirePermission(ctx, 'users:manage'), schema: { tags: ['admin: users'], summary, params: IdParams } },
      async (req) => {
        const p = req.principal!;
        const target = await loadTarget(p, req.params.id);
        if (target.id === p.user.id) throw conflict('You cannot change the status of your own account');
        await assertCanManage(p, target);
        const { set, action, change, revoke } = await handler(target, p);
        const [user] = await db.update(users).set(set).where(eq(users.id, target.id)).returning();
        if (revoke) await revokeAccount(db, target.id);
        await ctx.audit.fromRequest(req, { action, targetType: 'user', targetId: target.id, targetLabel: target.email });
        void publish(p.orgId, target.id, change);
        return { user: serializeUser(user!, { roles: await userRoleKeys(db, target.id) }) };
      },
    );

  lifecycle('suspend', 'Suspend a user and end their sessions', async (t) => {
    if (t.status !== 'active') throw conflict('Only active users can be suspended');
    await assertNotLastAdmin(t);
    return { set: { status: 'suspended', suspendedAt: new Date() }, action: 'user.suspended', change: 'suspended', revoke: true };
  });

  lifecycle('unsuspend', 'Re-activate a suspended user', async (t) => {
    if (t.status !== 'suspended') throw conflict('User is not suspended');
    return { set: { status: 'active', suspendedAt: null }, action: 'user.unsuspended', change: 'unsuspended' };
  });

  lifecycle('restore', 'Restore a deleted user (within the retention window)', async (t) => {
    if (t.status !== 'deleted') throw conflict('User is not deleted');
    return { set: { status: 'active', deletedAt: null, suspendedAt: null }, action: 'user.restored', change: 'restored' };
  });

  lifecycle('unlock', 'Clear a failed-sign-in lockout', async () => ({
    set: { lockedUntil: null, failedLoginCount: 0 },
    action: 'user.unlocked',
    change: 'updated',
  }));

  app.delete(
    '/api/v1/admin/users/:id',
    {
      preHandler: requirePermission(ctx, 'users:manage'),
      schema: { tags: ['admin: users'], summary: 'Soft-delete a user (purged after 30 days)', params: IdParams },
    },
    async (req) => {
      const p = req.principal!;
      const target = await loadTarget(p, req.params.id);
      if (target.id === p.user.id) throw conflict('You cannot delete your own account');
      if (target.status === 'deleted') throw conflict('User is already deleted');
      await assertCanManage(p, target);
      await assertNotLastAdmin(target);
      await db.update(users).set({ status: 'deleted', deletedAt: new Date() }).where(eq(users.id, target.id));
      await revokeAccount(db, target.id);
      await ctx.audit.fromRequest(req, { action: 'user.deleted', targetType: 'user', targetId: target.id, targetLabel: target.email });
      void publish(p.orgId, target.id, 'deleted');
      return { ok: true };
    },
  );

  app.post(
    '/api/v1/admin/users/:id/reset-password',
    {
      preHandler: requirePermission(ctx, 'users:credentials'),
      schema: {
        tags: ['admin: users'],
        summary: 'Reset a password (generates a temporary one when none is given)',
        params: IdParams,
        body: Type.Object({
          password: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
          mustChangePassword: Type.Boolean({ default: true }),
        }),
      },
    },
    async (req) => {
      const p = req.principal!;
      const target = await loadTarget(p, req.params.id);
      if (target.id === p.user.id) throw conflict('Use account settings to change your own password');
      await assertCanManage(p, target);
      const temporary = req.body.password ? null : generateTemporaryPassword();
      const password = req.body.password ?? temporary!;
      const problems = checkPasswordPolicy(password, undefined, [target.username]);
      if (problems.length) throw badRequest('Password does not meet the policy', { password: problems });
      await db
        .update(users)
        .set({
          passwordHash: await hashPassword(password),
          mustChangePassword: temporary ? true : req.body.mustChangePassword,
          passwordChangedAt: new Date(),
          failedLoginCount: 0,
          lockedUntil: null,
        })
        .where(eq(users.id, target.id));
      await revokeAccount(db, target.id);
      await ctx.audit.fromRequest(req, { action: 'user.password_reset', targetType: 'user', targetId: target.id, targetLabel: target.email });
      return { temporaryPassword: temporary };
    },
  );

  app.post(
    '/api/v1/admin/users/:id/reset-mfa',
    {
      preHandler: requirePermission(ctx, 'users:credentials'),
      schema: { tags: ['admin: users'], summary: 'Remove a user’s authenticator so they re-enrol at next sign-in', params: IdParams },
    },
    async (req) => {
      const p = req.principal!;
      const target = await loadTarget(p, req.params.id);
      if (target.id === p.user.id) throw conflict('Use account settings to manage your own MFA');
      await assertCanManage(p, target);
      await db.update(users).set({ totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null, recoveryCodes: [] }).where(eq(users.id, target.id));
      await revokeAccount(db, target.id);
      await ctx.audit.fromRequest(req, { action: 'user.mfa_reset', targetType: 'user', targetId: target.id, targetLabel: target.email });
      return { ok: true };
    },
  );

  app.put(
    '/api/v1/admin/users/:id/roles',
    {
      preHandler: requirePermission(ctx, 'roles:manage'),
      schema: {
        tags: ['admin: users'],
        summary: 'Replace a user’s role assignments',
        params: IdParams,
        body: Type.Object({ roles: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 20 }) }),
      },
    },
    async (req) => {
      const p = req.principal!;
      const target = await loadTarget(p, req.params.id);
      if (target.kind === 'shared') throw badRequest('Shared mailboxes cannot hold admin roles');
      await assertCanManage(p, target);
      const wanted = [...new Set(req.body.roles)];
      const found = wanted.length ? await db.select().from(roles).where(and(eq(roles.orgId, p.orgId), inArray(roles.key, wanted))) : [];
      if (found.length !== wanted.length) throw badRequest('One or more roles do not exist');
      if (!canGrant(p.permissions, resolvePermissions(found))) throw forbidden('You cannot grant permissions you do not hold');

      const before = await userRoleKeys(db, target.id);
      if (before.includes(GLOBAL_ADMIN) && !wanted.includes(GLOBAL_ADMIN)) {
        if (target.id === p.user.id) throw conflict('You cannot remove the global administrator role from yourself');
        await assertNotLastAdmin(target);
      }
      await db.transaction(async (tx) => {
        await tx.delete(userRoles).where(eq(userRoles.userId, target.id));
        if (found.length) await tx.insert(userRoles).values(found.map((r) => ({ userId: target.id, roleId: r.id })));
      });
      await ctx.audit.fromRequest(req, {
        action: 'user.roles_changed',
        targetType: 'user',
        targetId: target.id,
        targetLabel: target.email,
        metadata: { before, after: wanted },
      });
      void publish(p.orgId, target.id, 'roles');
      return { roles: wanted };
    },
  );

}
