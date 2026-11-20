import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { bearerToken, hasPermission, resolvePermissions, type Permission } from '@forge/auth';
import { orm, roles, userRoles, users, type User } from '@forge/db';
import type { AppContext } from '../context';
import { forbidden, unauthorized } from '../errors';
import { findSession, sessionProblem, touchSession } from '../services/sessions';

const { eq } = orm;

export interface Principal {
  user: User;
  orgId: string;
  permissions: Set<Permission>;
  roleKeys: string[];
  clientId?: string;
  scopes: string[];
  /** The sign-in session (browser or device) the request comes from. */
  sessionId?: string;
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
    // Access tokens name their sign-in session: a signed-out, timed-out or idle session stops working at once.
    if (typeof claims.sid === 'string') {
      const session = await findSession(ctx.db, claims.sid);
      if (session && session.userId === claims.sub) {
        const problem = sessionProblem(session);
        if (problem) throw unauthorized(problem === 'idle' ? 'Signed out after a period of inactivity' : problem === 'expired' ? 'Your session has ended. Please sign in again.' : 'This device has been signed out');
        await touchSession(ctx.db, session);
      }
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
      sessionId: typeof claims.sid === 'string' ? claims.sid : undefined,
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
