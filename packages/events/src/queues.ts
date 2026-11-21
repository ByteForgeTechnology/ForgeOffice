import { Queue, Worker, type JobsOptions, type Processor, type WorkerOptions } from 'bullmq';

/**
 * Every BullMQ queue in ForgeOffice with its job payloads. Phase 1 processes
 * `backups` and `maintenance`; the rest are declared now so producers and the
 * admin dashboard share one source of truth as later phases add workers.
 */
export interface QueueJobs {
  backups: {
    /** `backupId` is set for manual runs; scheduled runs create their own record. */
    'create-backup': { backupId?: string; trigger: 'manual' | 'scheduled' };
  };
  maintenance: {
    'purge-deleted-users': Record<string, never>;
    'purge-expired-oidc': Record<string, never>;
    'scan-volumes': Record<string, never>;
    'prune-audit-log': { olderThanDays: number };
    'prune-backups': { keep: number };
    /** ForgeDrive: empty recycle bins past the retention period, drop abandoned uploads. */
    'purge-drive-trash': Record<string, never>;
    'cleanup-drive-uploads': Record<string, never>;
  };
  'mail-delivery': {
    deliver: { outboundId: string };
  };
  'virus-scan': {
    /** Scan a ForgeDrive file version with ClamAV. */
    scan: { itemId: string; versionId: string };
  };
  thumbnails: {
    /** WebP thumbnail and text extraction (search) for a ForgeDrive file version. */
    generate: { itemId: string; versionId: string };
  };
}

export type QueueName = keyof QueueJobs;
export type JobName<Q extends QueueName> = Extract<keyof QueueJobs[Q], string>;
export type JobData<Q extends QueueName, N extends JobName<Q> = JobName<Q>> = QueueJobs[Q][N];

export const QUEUE_NAMES: QueueName[] = ['backups', 'maintenance', 'mail-delivery', 'virus-scan', 'thumbnails'];

export const QUEUE_INFO: Record<QueueName, { label: string; phase: number; description: string }> = {
  backups: { label: 'Backups', phase: 1, description: 'Database dumps and volume tarballs into forge_backups' },
  maintenance: { label: 'Maintenance', phase: 1, description: 'Purges, retention and volume usage scans' },
  'mail-delivery': { label: 'Mail delivery', phase: 2, description: 'Outbound SMTP delivery with retries' },
  'virus-scan': { label: 'Virus scanning', phase: 3, description: 'ClamAV scanning of uploaded blobs' },
  thumbnails: { label: 'Thumbnails', phase: 3, description: 'Preview and thumbnail generation' },
};

export const QUEUE_PREFIX = 'forge';

export interface RedisConnectionOptions {
  url: string;
}

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
  removeOnFail: { age: 30 * 24 * 3600 },
};

export type TypedQueue<Q extends QueueName> = Queue<JobData<Q>, unknown, JobName<Q>>;

export function createQueue<Q extends QueueName>(name: Q, conn: RedisConnectionOptions): TypedQueue<Q> {
  return new Queue(name, {
    connection: { url: conn.url, maxRetriesPerRequest: null },
    prefix: QUEUE_PREFIX,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  }) as TypedQueue<Q>;
}

export function createWorker<Q extends QueueName>(
  name: Q,
  processor: Processor<JobData<Q>, unknown, JobName<Q>>,
  conn: RedisConnectionOptions,
  opts: Omit<WorkerOptions, 'connection' | 'prefix'> = {},
): Worker<JobData<Q>, unknown, JobName<Q>> {
  return new Worker(name, processor, {
    ...opts,
    connection: { url: conn.url, maxRetriesPerRequest: null },
    prefix: QUEUE_PREFIX,
  });
}
