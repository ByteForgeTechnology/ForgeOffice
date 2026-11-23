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
    'star-notifications': Record<string, never>;
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

export const QUEUE_INFO: Record<QueueName, { label: string; description: string }> = {
  backups: { label: 'Backups', description: 'Database dumps and volume archives into forge_backups' },
  maintenance: { label: 'Maintenance', description: 'Retention and clean-up, disk usage scans, starred-item emails' },
  'mail-delivery': { label: 'Mail delivery', description: 'Outgoing mail, with retries' },
  'virus-scan': { label: 'Virus scanning', description: 'ClamAV scans of new Drive files' },
  thumbnails: { label: 'Thumbnails', description: 'Drive thumbnails, previews and text for search' },
};

/** What each recurring job does, as people read it (by scheduler id). */
export const SCHEDULE_LABELS: Record<string, string> = {
  'nightly-backup': 'Scheduled backup',
  'purge-expired-oidc': 'Remove expired sign-in records',
  'scan-volumes': 'Measure disk usage',
  'purge-deleted-users': 'Permanently remove deleted users',
  'prune-audit-log': 'Trim the audit log',
  'purge-drive-trash': 'Empty recycle bins (retention)',
  'cleanup-drive-uploads': 'Clear abandoned uploads',
  'star-notifications': 'Email changes to starred items',
  'prune-backups': 'Delete old backups',
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
