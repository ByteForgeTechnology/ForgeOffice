import { describe, expect, it } from 'vitest';
import { QUEUE_NAMES } from '@forge/events';
import { queueOverview } from '../src/services/system';

/** A stand-in for a BullMQ queue with the answers Redis would give. */
const fakeQueue = (o: { delayed?: number; workers?: number; schedulers?: { key: string; name: string; next?: number; pattern?: string; every?: number }[]; fail?: boolean }) => ({
  getJobCounts: async () => {
    if (o.fail) throw new Error('Connection is closed.');
    return { waiting: 2, active: 0, completed: 5, failed: 1, delayed: o.delayed ?? 0, prioritized: 0 };
  },
  isPaused: async () => false,
  getWorkersCount: async () => o.workers ?? 1,
  getJobSchedulers: async () => o.schedulers ?? [],
});

describe('job queue overview', () => {
  it('separates recurring jobs from delays, reports workers, labels schedules', async () => {
    const now = Date.now();
    const queues = Object.fromEntries(QUEUE_NAMES.map((n) => [n, fakeQueue({})])) as Record<string, ReturnType<typeof fakeQueue>>;
    queues.maintenance = fakeQueue({
      delayed: 3,
      schedulers: [
        { key: 'purge-drive-trash', name: 'purge-drive-trash', next: now + 3_600_000, pattern: '15 4 * * *' },
        { key: 'star-notifications', name: 'star-notifications', next: now + 60_000, every: 120_000 },
      ],
    });
    queues['mail-delivery'] = fakeQueue({ workers: 0 });
    queues.thumbnails = fakeQueue({ fail: true });
    const out = await queueOverview({ queues } as never);
    const m = out.find((q) => q.name === 'maintenance')!;
    // 3 delayed jobs, 2 of them the schedules' next runs: 1 genuinely delayed.
    expect(m.counts).toMatchObject({ delayed: 1, scheduled: 2, waiting: 2, completed: 5 });
    expect(m.schedules.map((s) => s.label)).toEqual(['Email changes to starred items', 'Empty recycle bins (retention)']);
    expect(m.schedules[0]).toMatchObject({ every: 120_000, pattern: null });
    expect(out.find((q) => q.name === 'mail-delivery')!.workers).toBe(0);
    expect(out.find((q) => q.name === 'thumbnails')).toMatchObject({ available: false, counts: null, error: 'Connection is closed.' });
    expect(out.find((q) => q.name === 'virus-scan')).toMatchObject({ label: 'Virus scanning', available: true, workers: 1 });
    expect('phase' in m).toBe(false);
  });
});
