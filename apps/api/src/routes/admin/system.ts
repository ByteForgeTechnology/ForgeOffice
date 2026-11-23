import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from 'typebox';
import { backups, forgetNode, orm, replicaStats, underReplicated as underReplicated_ } from '@forge/db';
import { DRAINING_SET } from '@forge/storage';
import { QUEUE_NAMES, type QueueName } from '@forge/events';
import type { AppContext } from '../../context';
import { HttpError, conflict, notFound } from '../../errors';
import { authenticate, requirePermission } from '../../plugins/auth';
import { systemOverview } from '../../services/system';
import { joinCode, joinInfo } from '../../services/join';
import type { App } from '../../types';

const { desc, eq, inArray } = orm;

const QueueParams = Type.Object({ name: Type.Unsafe<QueueName>(Type.String({ enum: QUEUE_NAMES })) });
const JobState = Type.Union(['waiting', 'active', 'completed', 'failed', 'delayed', 'prioritized'].map((s) => Type.Literal(s)));

export function adminSystemRoutes(app: App, ctx: AppContext) {
  const { db } = ctx;
  app.addHook('preHandler', authenticate(ctx));

  const queue = <Q extends QueueName>(name: Q): NonNullable<AppContext['queues']>[Q] => {
    if (!ctx.queues) throw new HttpError(503, 'Queues are unavailable because Redis is not configured', 'redis_unavailable');
    return ctx.queues[name];
  };

  app.get(
    '/api/v1/admin/system/overview',
    { preHandler: requirePermission(ctx, 'system:read'), schema: { tags: ['admin: system'], summary: 'Service health, volume usage, queue counts and containers' } },
    async () => systemOverview(ctx),
  );

  app.get(
    '/api/v1/admin/system/queues/:name/jobs',
    {
      preHandler: requirePermission(ctx, 'system:read'),
      schema: {
        tags: ['admin: system'],
        summary: 'List jobs in a queue by state',
        params: QueueParams,
        querystring: Type.Object({ state: JobState, start: Type.Integer({ minimum: 0, default: 0 }), limit: Type.Integer({ minimum: 1, maximum: 100, default: 25 }) }),
      },
    },
    async (req) => {
      const q = queue(req.params.name);
      const { state, start, limit } = req.query;
      const jobs = await q.getJobs([state as 'failed'], start, start + limit - 1, false);
      return {
        // A recurring job's next run waits as a delayed job; the schedule lists those, so leave them out here.
        items: jobs.filter((j) => j && !(state === 'delayed' && String(j.id).startsWith('repeat:'))).map((j) => ({
          id: j.id,
          name: j.name,
          data: j.data,
          attemptsMade: j.attemptsMade,
          failedReason: j.failedReason || null,
          stacktrace: j.stacktrace?.slice(-1) ?? [],
          progress: j.progress,
          timestamp: j.timestamp,
          processedOn: j.processedOn ?? null,
          finishedOn: j.finishedOn ?? null,
          returnvalue: j.returnvalue ?? null,
        })),
      };
    },
  );

  const queueAction = (path: string, summary: string, fn: (name: QueueName, body: { grace?: number; state?: string; jobId?: string }) => Promise<unknown>) =>
    app.post(
      `/api/v1/admin/system/queues/:name/${path}`,
      {
        preHandler: requirePermission(ctx, 'system:manage'),
        schema: {
          tags: ['admin: system'],
          summary,
          params: QueueParams,
          body: Type.Optional(
            Type.Object({
              grace: Type.Optional(Type.Integer({ minimum: 0 })),
              state: Type.Optional(Type.Union([Type.Literal('completed'), Type.Literal('failed')])),
              jobId: Type.Optional(Type.String({ maxLength: 200 })),
            }),
          ),
        },
      },
      async (req) => {
        const result = await fn(req.params.name, req.body ?? {});
        await ctx.audit.fromRequest(req, { action: `queue.${path.replace(/\//g, '_')}`, targetType: 'queue', targetId: req.params.name, targetLabel: req.params.name, metadata: req.body ?? {} });
        return { ok: true, result: result ?? null };
      },
    );

  queueAction('pause', 'Pause a queue', (n) => queue(n).pause());
  queueAction('resume', 'Resume a queue', (n) => queue(n).resume());
  queueAction('retry-failed', 'Retry all failed jobs', (n) => queue(n).retryJobs({ state: 'failed' }));
  queueAction('clean', 'Remove completed or failed jobs older than `grace` ms', async (n, b) =>
    (await queue(n).clean(b.grace ?? 0, 1000, (b.state as 'completed' | 'failed') ?? 'completed')).length,
  );
  queueAction('retry-job', 'Retry a single failed job', async (n, b) => {
    const job = b.jobId ? await queue(n).getJob(b.jobId) : null;
    if (!job) throw notFound('Job');
    await job.retry();
  });
  queueAction('remove-job', 'Remove a single job', async (n, b) => {
    const job = b.jobId ? await queue(n).getJob(b.jobId) : null;
    if (!job) throw notFound('Job');
    await job.remove();
  });

  // ---------------------------------------------------------------------------
  // Backups
  // ---------------------------------------------------------------------------

  const serializeBackup = (b: typeof backups.$inferSelect) => ({
    ...b,
    createdAt: b.createdAt.toISOString(),
    startedAt: b.startedAt?.toISOString() ?? null,
    finishedAt: b.finishedAt?.toISOString() ?? null,
  });

  app.get(
    '/api/v1/admin/system/backups',
    { preHandler: requirePermission(ctx, 'system:read'), schema: { tags: ['admin: system'], summary: 'Backup history' } },
    async () => ({
      items: (await db.select().from(backups).orderBy(desc(backups.createdAt)).limit(100)).map(serializeBackup),
      location: ctx.config.volumes.backups.path,
    }),
  );

  app.post(
    '/api/v1/admin/system/backups',
    { preHandler: requirePermission(ctx, 'system:manage'), schema: { tags: ['admin: system'], summary: 'Start a backup now' } },
    async (req, reply) => {
      const q = queue('backups');
      const running = await db.select({ id: backups.id }).from(backups).where(inArray(backups.status, ['queued', 'running'])).limit(1);
      if (running.length) throw conflict('A backup is already queued or running');
      const [backup] = await db.insert(backups).values({ trigger: 'manual', requestedBy: req.principal!.user.id }).returning();
      try {
        await q.add('create-backup', { backupId: backup!.id, trigger: 'manual' }, { jobId: `backup-${backup!.id}`, attempts: 1 });
      } catch (err) {
        await db.update(backups).set({ status: 'failed', error: `Could not enqueue: ${(err as Error).message}`, finishedAt: new Date() }).where(eq(backups.id, backup!.id));
        throw new HttpError(503, 'Could not enqueue the backup job', 'queue_unavailable');
      }
      await ctx.audit.fromRequest(req, { action: 'backup.requested', targetType: 'backup', targetId: backup!.id });
      reply.code(202);
      return { backup: serializeBackup(backup!) };
    },
  );

  app.delete(
    '/api/v1/admin/system/backups/:id',
    {
      preHandler: requirePermission(ctx, 'system:manage'),
      schema: { tags: ['admin: system'], summary: 'Delete a backup and its files', params: Type.Object({ id: Type.String({ format: 'uuid' }) }) },
    },
    async (req) => {
      const [b] = await db.select().from(backups).where(eq(backups.id, req.params.id)).limit(1);
      if (!b) throw notFound('Backup');
      if (b.status === 'queued' || b.status === 'running') throw conflict('This backup is still in progress');
      if (b.name && /^[\w.-]+$/.test(b.name)) await rm(join(ctx.config.volumes.backups.path, b.name), { recursive: true, force: true });
      await db.delete(backups).where(eq(backups.id, b.id));
      await ctx.audit.fromRequest(req, { action: 'backup.deleted', targetType: 'backup', targetId: b.id, targetLabel: b.name ?? undefined });
      return { ok: true };
    },
  );

  // ---------------------------------------------------------------------------
  // Cluster: storage nodes and media servers (several machines)
  // ---------------------------------------------------------------------------

  app.get('/api/v1/admin/system/cluster', { preHandler: requirePermission(ctx, 'system:read'), schema: { tags: ['admin: system'], summary: 'Storage nodes, copies of files, and media servers' } }, async () => {
    const storage = ctx.storage;
    const nodes = storage.registry ? await storage.registry.nodes() : [];
    const live = new Set(nodes.map((n) => n.id));
    const stats = storage.cluster ? await replicaStats(ctx.db) : [];
    // Nodes the index still lists but that aren't announcing themselves: down, or gone for good.
    const missing = [...new Set(stats.map((s) => s.nodeId))].filter((id) => !live.has(id));
    const replicas = ctx.config.storage.replicas;
    const want = Math.min(replicas, nodes.filter((n) => !n.draining).length);
    let underReplicated = 0;
    if (storage.cluster && want > 0) for (const ns of ['mail', 'drive', 'team']) underReplicated += (await underReplicated_(ctx.db, ns, nodes.filter((n) => !n.draining && n.namespaces.includes(ns)).map((n) => n.id), want, 10_000)).length;
    return {
      storage: {
        mode: storage.mode,
        replicas,
        underReplicated,
        nodes: [
          ...nodes.map((n) => ({ id: n.id, url: n.url, online: true, draining: n.draining, namespaces: n.namespaces, freeBytes: n.freeBytes, totalBytes: n.totalBytes, blobs: Object.fromEntries(stats.filter((s) => s.nodeId === n.id).map((s) => [s.namespace, s.blobs])) })),
          ...missing.map((id) => ({ id, url: null, online: false, draining: false, namespaces: [], freeBytes: 0, totalBytes: 0, blobs: Object.fromEntries(stats.filter((s) => s.nodeId === id).map((s) => [s.namespace, s.blobs])) })),
        ],
      },
      media: (await ctx.team.media.directory.nodes()).map((n) => ({ id: n.id, address: n.address, meetings: n.meetings.length, people: n.peers, seenAt: n.seenAt })),
      // Whether another server can join, and with what (the code itself is fetched separately).
      join: joinInfo(ctx.config),
    };
  });

  // The installer's join code: database password and master secret, so system:manage only, and audited.
  app.post(
    '/api/v1/admin/system/join-code',
    { preHandler: requirePermission(ctx, 'system:manage'), schema: { tags: ['admin: system'], summary: 'The join code another server’s installer needs (holds the database password and master secret)' } },
    async (req, reply) => {
      const info = joinInfo(ctx.config);
      if (!info.available) throw new HttpError(409, info.reason ?? 'Other servers can’t join this ForgeOffice', 'join_unavailable');
      const code = joinCode(ctx.config);
      await ctx.audit.fromRequest(req, { action: 'system.join_code_viewed', targetType: 'system', targetLabel: info.publicUrl });
      reply.header('cache-control', 'no-store');
      return { code };
    },
  );

  app.put(
    '/api/v1/admin/system/storage/:id',
    { preHandler: requirePermission(ctx, 'system:manage'), schema: { tags: ['admin: system'], summary: 'Retire a storage node (its files are copied elsewhere, then removed from it) or bring it back', params: Type.Object({ id: Type.String({ pattern: '^[a-z0-9-]{4,64}$' }) }), body: Type.Object({ draining: Type.Boolean() }) } },
    async (req) => {
      if (!ctx.redis) throw new HttpError(400, 'Storage nodes need Redis', 'no_redis');
      if (req.body.draining) await ctx.redis.sadd(DRAINING_SET, req.params.id);
      else await ctx.redis.srem(DRAINING_SET, req.params.id);
      await ctx.audit.fromRequest(req, { action: req.body.draining ? 'storage.node_retiring' : 'storage.node_restored', targetType: 'storage_node', targetId: req.params.id, targetLabel: req.params.id });
      return { ok: true };
    },
  );

  app.delete('/api/v1/admin/system/storage/:id', { preHandler: requirePermission(ctx, 'system:manage'), schema: { tags: ['admin: system'], summary: 'Forget a storage node that is gone for good (its copies are made again from the others)', params: Type.Object({ id: Type.String({ pattern: '^[a-z0-9-]{4,64}$' }) }) } }, async (req) => {
    const nodes = ctx.storage.registry ? await ctx.storage.registry.nodes() : [];
    if (nodes.some((n) => n.id === req.params.id)) throw conflict('That node is still running: retire it first, then stop it');
    await forgetNode(ctx.db, req.params.id);
    await ctx.redis?.srem(DRAINING_SET, req.params.id);
    await ctx.audit.fromRequest(req, { action: 'storage.node_forgotten', targetType: 'storage_node', targetId: req.params.id, targetLabel: req.params.id });
    return { ok: true };
  });
}
