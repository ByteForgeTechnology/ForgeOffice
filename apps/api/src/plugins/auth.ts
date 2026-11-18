import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { bearerToken, hasPermission, resolvePermissions, type Permission } from '@forge/auth';
import { orm, roles, userRoles, users, type User } from '@forge/db';
import type { AppContext } from '../context';
import { forbidden, unauthorized } from '../errors';

const { eq } = orm;

export interface Principal {
  user: User;
  orgId: string;
  permissions: Set<Permission>;
  roleKeys: string[];
  clientId?: string;
  scopes: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export async function loadPrincipalData(ctx: AppContext, userId: string) {
  const [user] = await ctx.db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return null;
  const assigned = await ctx.db
    .select({ key: roles.key, permissions: roles.permissions })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(userRoles.userId, userId));
  return { user, roleKeys: assigned.map((r) => r.key), permissions: resolvePermissions(assigned) };
}

/**
 * Validate the bearer JWT access token, then load the user fresh from the
 * database so suspensions and role changes take effect immediately.
 */
export function authenticate(ctx: AppContext): preHandlerAsyncHookHandler {
  return async function authenticateHook(req: FastifyRequest) {
    if (req.principal) return;
    const token = bearerToken(req.headers.authorization);
    if (!token) throw unauthorized();
    let claims;
    try {
      claims = await ctx.verifyAccessToken(token);
    } catch {
      throw unauthorized('Invalid or expired access token');
    }
    const data = await loadPrincipalData(ctx, claims.sub);
    if (!data || data.user.status !== 'active' || data.user.kind === 'shared') throw unauthorized('Account is not active');
    req.principal = {
      user: data.user,
      orgId: data.user.orgId,
      permissions: data.permissions,
      roleKeys: data.roleKeys,
      clientId: claims.client_id,
      scopes: typeof claims.scope === 'string' ? claims.scope.split(' ') : [],
    };
  };
}

/** Require every listed permission; denials are written to the audit log. */
export function requirePermission(ctx: AppContext, ...required: Permission[]): preHandlerAsyncHookHandler {
  return async function permissionHook(req: FastifyRequest, _reply: FastifyReply) {
    const p = req.principal;
    if (!p) throw unauthorized();
    if (!hasPermission(p.permissions, required)) {
      await ctx.audit.fromRequest(req, {
        action: 'access.denied',
        outcome: 'failure',
        metadata: { method: req.method, route: req.routeOptions.url, required },
      });
      throw forbidden();
    }
  };
}
