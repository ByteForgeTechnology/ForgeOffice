import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { hasPermission } from '@forge/auth';
import type { AppContext } from '../context';
import { systemOverview } from '../services/system';
import { loadPrincipalData } from './auth';

interface SocketData {
  userId: string;
  orgId: string;
}

const OVERVIEW_INTERVAL_MS = 5_000;

/**
 * Socket.IO server for live updates. Rooms:
 *   user:<id>     notifications for one user
 *   system        admins watching service health (system:read)
 *   audit:<org>   admins watching the live audit feed (audit:read)
 * With Redis configured the @socket.io/redis-adapter fans events out across
 * every API replica.
 */
export function attachRealtime(server: HttpServer, ctx: AppContext, log: { warn: (o: unknown, m?: string) => void }) {
  const io = new Server<Record<string, never>, Record<string, (...args: unknown[]) => void>, Record<string, never>, SocketData>(server, {
    path: '/socket.io',
    serveClient: false,
  });

  const cleanups: (() => void)[] = [];
  if (ctx.redis) {
    const pub = ctx.redis.duplicate();
    const sub = ctx.redis.duplicate();
    io.adapter(createAdapter(pub, sub, { key: 'forge:socket.io' }));
    cleanups.push(() => {
      pub.disconnect();
      sub.disconnect();
    });
  }

  io.use(async (socket, next) => {
    try {
      const token = (socket.handshake.auth as { token?: unknown })?.token;
      if (typeof token !== 'string') return next(new Error('unauthorized'));
      const claims = await ctx.verifyAccessToken(token);
      const data = await loadPrincipalData(ctx, claims.sub);
      if (!data || data.user.status !== 'active') return next(new Error('unauthorized'));
      socket.data = { userId: data.user.id, orgId: data.user.orgId };
      void socket.join(`user:${data.user.id}`);
      if (hasPermission(data.permissions, 'system:read')) void socket.join('system');
      if (hasPermission(data.permissions, 'audit:read')) void socket.join(`audit:${data.user.orgId}`);
      // Disconnect when the access token expires; the client reconnects with a fresh one.
      if (claims.exp) {
        const timer = setTimeout(() => socket.disconnect(true), Math.max(0, claims.exp * 1000 - Date.now()));
        socket.once('disconnect', () => clearTimeout(timer));
      }
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket: Socket) => {
    if (socket.rooms.has('system')) {
      systemOverview(ctx)
        .then((o) => socket.emit('system:overview', o))
        .catch(() => {});
    }
  });

  // Each replica pushes overviews only to its own local subscribers.
  let busy = false;
  const ticker = setInterval(async () => {
    if (busy || !io.of('/').adapter.rooms.get('system')?.size) return;
    busy = true;
    try {
      io.local.to('system').emit('system:overview', await systemOverview(ctx));
    } catch (err) {
      log.warn({ err }, 'failed to compute system overview');
    } finally {
      busy = false;
    }
  }, OVERVIEW_INTERVAL_MS);
  ticker.unref();

  const onAudit = (e: { orgId: string | null }) => {
    if (e.orgId) io.to(`audit:${e.orgId}`).emit('audit:created', e);
  };
  ctx.events.on('audit.created', onAudit);

  if (ctx.bus) {
    void ctx.bus.on('backup.updated', (e) => io.local.to('system').emit('backup:updated', e)).catch(() => {});
    void ctx.bus.on('notify.user', (e) => io.local.to(`user:${e.userId}`).emit('notification', e)).catch(() => {});
  }

  return {
    io,
    async close() {
      clearInterval(ticker);
      ctx.events.off('audit.created', onAudit);
      await io.close();
      cleanups.forEach((c) => c());
    },
  };
}
