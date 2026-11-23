import { access } from 'node:fs/promises';
import { PORTAL, WEB_APPS } from '../gateway';
import { runsAll } from '../services';
import { loadavg, totalmem, freemem } from 'node:os';
import { QUEUE_INFO, QUEUE_NAMES, SCHEDULE_LABELS, VOLUME_SCAN_KEY, listHeartbeats, withTimeout, type QueueName, type VolumeScan } from '@forge/events';
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
      name: runsAll(ctx.config.services) ? 'API & identity provider' : 'Directory service (sign-in, admin)',
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
    const beat = (key: string, name: string, services: string[]) => {
      const found = beats.filter((b) => services.includes(b.service));
      out.push({ key, name, state: found.length ? 'up' : 'down', detail: found.length ? `${found.length} instance(s)` : 'No heartbeat in the last 30 seconds', instances: found.map((w) => ({ instance: w.instance, lastSeen: w.lastSeen, startedAt: w.startedAt, version: w.version })) });
    };
    if (runsAll(ctx.config.services)) {
      const mailservers = beats.filter((b) => ['mailserver', 'smtp', 'imap'].includes(b.service));
      out.push({
        key: 'mailserver',
        name: 'Mail server (SMTP/IMAP)',
        state: ctx.config.mail.embed ? 'up' : mailservers.length ? 'up' : 'down',
        detail: ctx.config.mail.embed ? 'Embedded in the API process' : mailservers.length ? `${mailservers.length} instance(s)` : 'No mail server heartbeat in the last 30 seconds',
      });
    } else {
      // One container per service: each reports its own heartbeat.
      for (const [svc, name] of [['mail', 'Mail service (webmail back end)'], ['calendar', 'Calendar service (incl. CalDAV)'], ['contacts', 'Contacts service (incl. CardDAV)'], ['tasks', 'Tasks service']] as const)
        if (!ctx.config.services.has(svc)) beat(svc, name, [svc]);
      beat('smtp', 'SMTP (receive and submit mail)', ['smtp', 'mailserver']);
      beat('imap', 'IMAP (mail apps)', ['imap', 'mailserver']);
    }
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
  // Containers without Redis: mailbox storage and the web apps answer /healthz.
  if (!runsAll(ctx.config.services)) {
    const probe = async (key: string, name: string, url: string) => {
      try {
        const { ms, value } = await timed(() => fetch(url, { signal: AbortSignal.timeout(2_000) }));
        out.push({ key, name, state: value.ok ? 'up' : 'down', latencyMs: ms, ...(value.ok ? {} : { detail: `HTTP ${value.status}` }) });
      } catch (err) {
        out.push({ key, name, state: 'down', detail: (err as Error).message });
      }
    };
    await Promise.all([
      ...(ctx.config.mail.storeUrl ? [probe('mail-store', 'Mailbox storage (mail-store)', `${ctx.config.mail.storeUrl}/healthz`)] : []),
      probe('portal-web', 'Web: portal and sign-in', `http://${PORTAL.host}:${PORTAL.port}/healthz`),
      ...WEB_APPS.map((w) => probe(`${w.app}-web`, `Web: ${w.app}`, `http://${w.host}:${w.port}/healthz`)),
    ]);
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
      if (!ctx.queues) return { ...info, available: false, paused: false, counts: null, workers: null, schedules: [] };
      const queue = ctx.queues[name];
      try {
        const [counts, paused, workers, schedulers] = await withTimeout(
          Promise.all([
            queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'prioritized'),
            queue.isPaused(),
            // Workers connected to this queue (0: nothing will run).
            queue.getWorkersCount().catch(() => null),
            queue.getJobSchedulers(0, 99, true).catch(() => []),
          ]),
          2_000,
          `queue ${name}`,
        );
        const schedules = schedulers
          .map((s) => ({ id: s.key, label: SCHEDULE_LABELS[s.key] ?? s.name, next: s.next ?? null, pattern: s.pattern ?? null, every: s.every ? Number(s.every) : null }))
          .sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity));
        // Each recurring job waits as one delayed job until its next run: those are "scheduled", not delayed.
        const scheduled = Math.min(counts.delayed ?? 0, schedules.length);
        return { ...info, available: true, paused, workers, schedules, counts: { ...counts, delayed: (counts.delayed ?? 0) - scheduled, scheduled } };
      } catch (err) {
        return { ...info, available: false, paused: false, counts: null, workers: null, schedules: [], error: (err as Error).message };
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
