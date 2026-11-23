import { Type } from 'typebox';
import { PERMISSIONS, canGrant, isPermission } from '@forge/auth';
import { orm, roles, userRoles } from '@forge/db';
import type { AppContext } from '../../context';
import { badRequest, conflict, forbidden, isUniqueViolation, notFound } from '../../errors';
import { authenticate, requirePermission } from '../../plugins/auth';
import type { App } from '../../types';

const { and, asc, count, eq } = orm;
const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

export function adminRoleRoutes(app: App, ctx: AppContext) {
  const { db } = ctx;
  app.addHook('preHandler', authenticate(ctx));

  const validatePermissions = (granted: ReadonlySet<string>, perms: string[]) => {
    const unknown = perms.filter((p) => !isPermission(p));
    if (unknown.length) throw badRequest(`Unknown permissions: ${unknown.join(', ')}`);
    if (!canGrant(granted, perms)) throw forbidden('You cannot create a role with permissions you do not hold');
    return [...new Set(perms)];
  };

  const load = async (orgId: string, id: string) => {
    const [r] = await db.select().from(roles).where(and(eq(roles.id, id), eq(roles.orgId, orgId))).limit(1);
    if (!r) throw notFound('Role');
    return r;
  };

  app.get(
    '/api/v1/admin/roles',
    { preHandler: requirePermission(ctx, 'users:read'), schema: { tags: ['admin: roles'], summary: 'List roles and the permission catalogue' } },
    async (req) => {
      const rows = await db
        .select({ role: roles, userCount: count(userRoles.userId) })
        .from(roles)
        .leftJoin(userRoles, eq(userRoles.roleId, roles.id))
        .where(eq(roles.orgId, req.principal!.orgId))
        .groupBy(roles.id)
        .orderBy(asc(roles.builtin), asc(roles.name));
      return {
        items: rows.map(({ role, userCount }) => ({
          id: role.id,
          key: role.key,
          name: role.name,
          description: role.description,
          permissions: role.permissions,
          builtin: role.builtin,
          userCount,
        })),
        permissions: Object.entries(PERMISSIONS).map(([key, description]) => ({ key, description })),
      };
    },
  );

  const Body = Type.Object({
    key: Type.String({ pattern: '^[a-z][a-z0-9_]{1,40}$' }),
    name: Type.String({ minLength: 1, maxLength: 80 }),
    description: Type.Optional(Type.String({ maxLength: 500 })),
    permissions: Type.Array(Type.String(), { maxItems: 50 }),
  });

  app.post(
    '/api/v1/admin/roles',
    { preHandler: requirePermission(ctx, 'roles:manage'), schema: { tags: ['admin: roles'], summary: 'Create a custom role', body: Body } },
    async (req, reply) => {
      const p = req.principal!;
      const permissions = validatePermissions(p.permissions, req.body.permissions);
      try {
        const [role] = await db
          .insert(roles)
          .values({ orgId: p.orgId, key: req.body.key, name: req.body.name, description: req.body.description ?? '', permissions })
          .returning();
        await ctx.audit.fromRequest(req, { action: 'role.created', targetType: 'role', targetId: role!.id, targetLabel: role!.key, metadata: { permissions } });
        reply.code(201);
        return { role };
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('A role with that key already exists');
        throw err;
      }
    },
  );

  app.patch(
    '/api/v1/admin/roles/:id',
    {
      preHandler: requirePermission(ctx, 'roles:manage'),
      schema: { tags: ['admin: roles'], summary: 'Update a custom role', params: IdParams, body: Type.Partial(Type.Omit(Body, ['key'])) },
    },
    async (req) => {
      const p = req.principal!;
      const role = await load(p.orgId, req.params.id);
      if (role.builtin) throw conflict('Built-in roles cannot be changed');
      const permissions = req.body.permissions ? validatePermissions(p.permissions, req.body.permissions) : undefined;
      const [updated] = await db
        .update(roles)
        .set({ ...req.body, ...(permissions ? { permissions } : {}) })
        .where(eq(roles.id, role.id))
        .returning();
      await ctx.audit.fromRequest(req, { action: 'role.updated', targetType: 'role', targetId: role.id, targetLabel: role.key, metadata: { before: role.permissions, after: updated!.permissions } });
      return { role: updated };
    },
  );

  app.delete(
    '/api/v1/admin/roles/:id',
    { preHandler: requirePermission(ctx, 'roles:manage'), schema: { tags: ['admin: roles'], summary: 'Delete a custom role', params: IdParams } },
    async (req) => {
      const role = await load(req.principal!.orgId, req.params.id);
      if (role.builtin) throw conflict('Built-in roles cannot be deleted');
      await db.delete(roles).where(eq(roles.id, role.id));
      await ctx.audit.fromRequest(req, { action: 'role.deleted', targetType: 'role', targetId: role.id, targetLabel: role.key });
      return { ok: true };
    },
  );
}
