import { access } from 'node:fs/promises';
import { loadavg, totalmem, freemem } from 'node:os';
import { QUEUE_INFO, QUEUE_NAMES, VOLUME_SCAN_KEY, listHeartbeats, withTimeout, type QueueName, type VolumeScan } from '@forge/events';
import { diskUsage } from '@forge/storage';
import type { AppContext } from '../context';
import { listComposeContainers, type ContainerInfo } from './docker';

export type ServiceState = 'up' | 'down' | 'degraded' | 'disabled';

export interface ServiceHealth {
  key: string;
  name: string;
  state: ServiceState;
  latencyMs?: number;
  detail?: string;
  instances?: { instance: string; lastSeen: string; startedAt: string; version: string }[];
}

const startedAt = new Date();

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t = performance.now();
  const value = await fn();
  return { ms: Math.round((performance.now() - t) * 10) / 10, value };
}

export async function serviceHealth(ctx: AppContext): Promise<ServiceHealth[]> {
  const mem = process.memoryUsage();
  const out: ServiceHealth[] = [
    {
      key: 'api',
      name: 'API & identity provider',
      state: 'up',
      detail: `Node ${process.version} · uptime ${Math.round(process.uptime())}s · RSS ${Math.round(mem.rss / 1048576)} MiB`,
    },
  ];

  try {
    const { ms } = await timed(() => withTimeout(ctx.dbHandle.ping(), 2_000, 'database ping'));
    out.push({ key: 'database', name: `Database (${ctx.dbHandle.driver === 'pglite' ? 'PGlite' : 'PostgreSQL'})`, state: ms > 500 ? 'degraded' : 'up', latencyMs: ms });
  } catch (err) {
    out.push({ key: 'database', name: 'Database', state: 'down', detail: (err as Error).message });
  }

  if (!ctx.redis) {
    out.push({ key: 'redis', name: 'Redis', state: 'disabled', detail: 'REDIS_URL is not set; queues and real-time fan-out are unavailable' });
    out.push({ key: 'worker', name: 'Background worker', state: 'disabled', detail: 'Requires Redis' });
    return out;
  }
  const redis = ctx.redis;
  try {
    const { ms } = await timed(() => withTimeout(redis.ping(), 2_000, 'redis ping'));
    out.push({ key: 'redis', name: 'Redis', state: ms > 200 ? 'degraded' : 'up', latencyMs: ms });
    const beats = await withTimeout(listHeartbeats(redis), 2_000, 'heartbeat scan');
    const workers = beats.filter((b) => b.service === 'worker');
    out.push({
      key: 'worker',
      name: 'Background worker',
      state: workers.length ? 'up' : 'down',
      detail: workers.length ? `${workers.length} instance(s)` : 'No worker heartbeat in the last 30 seconds',
      instances: workers.map((w) => ({ instance: w.instance, lastSeen: w.lastSeen, startedAt: w.startedAt, version: w.version })),
    });
  } catch (err) {
    out.push({ key: 'redis', name: 'Redis', state: 'down', detail: (err as Error).message });
    out.push({ key: 'worker', name: 'Background worker', state: 'down', detail: 'Unknown (Redis unreachable)' });
  }
  return out;
}

export async function volumeUsage(ctx: AppContext) {
  let scan: VolumeScan | null = null;
  if (ctx.redis) {
    try {
      const raw = await withTimeout(ctx.redis.get(VOLUME_SCAN_KEY), 1_000, 'volume scan read');
      scan = raw ? (JSON.parse(raw) as VolumeScan) : null;
    } catch {
      scan = null;
    }
  }
  return {
    scannedAt: scan?.scannedAt ?? null,
    volumes: await Promise.all(
      Object.values(ctx.config.volumes).map(async (v) => {
        const base = { key: v.key, volume: v.volume, description: v.description, path: v.path, scanned: scan?.volumes[v.key] ?? null };
        try {
          await access(v.path);
          return { ...base, mounted: true, disk: await diskUsage(v.path) };
        } catch (err) {
          return { ...base, mounted: false, disk: null, error: (err as NodeJS.ErrnoException).code ?? 'unavailable' };
        }
      }),
    ),
  };
}

export async function queueOverview(ctx: AppContext) {
  return Promise.all(
    QUEUE_NAMES.map(async (name: QueueName) => {
      const info = { name, ...QUEUE_INFO[name] };
      if (!ctx.queues) return { ...info, available: false, paused: false, counts: null };
      const queue = ctx.queues[name];
      try {
        const [counts, paused] = await withTimeout(
          Promise.all([queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'prioritized'), queue.isPaused()]),
          2_000,
          `queue ${name}`,
        );
        return { ...info, available: true, paused, counts };
      } catch (err) {
        return { ...info, available: false, paused: false, counts: null, error: (err as Error).message };
      }
    }),
  );
}

export async function containerOverview(ctx: AppContext): Promise<{ enabled: boolean; items: ContainerInfo[]; error?: string }> {
  if (!ctx.config.dockerSocket) return { enabled: false, items: [] };
  try {
    return { enabled: true, items: await listComposeContainers(ctx.config.dockerSocket, ctx.config.composeProject) };
  } catch (err) {
    return { enabled: true, items: [], error: (err as Error).message };
  }
}

export async function systemOverview(ctx: AppContext) {
  const [services, volumes, queues, containers] = await Promise.all([serviceHealth(ctx), volumeUsage(ctx), queueOverview(ctx), containerOverview(ctx)]);
  return {
    generatedAt: new Date().toISOString(),
    version: ctx.config.version,
    startedAt: startedAt.toISOString(),
    host: { loadavg: loadavg(), totalMemBytes: totalmem(), freeMemBytes: freemem() },
    services,
    volumes,
    queues,
    containers,
  };
}

export type SystemOverview = Awaited<ReturnType<typeof systemOverview>>;
