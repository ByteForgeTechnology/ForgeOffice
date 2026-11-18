import { resolveVolumes } from '@forge/storage';

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env) {
  if (!env.REDIS_URL) throw new Error('REDIS_URL is required for the worker');
  const databaseUrl = env.DATABASE_URL ?? 'postgres://forge:forge@localhost:5432/forge';
  return {
    env: env.NODE_ENV ?? 'development',
    logLevel: env.LOG_LEVEL ?? 'info',
    databaseUrl,
    redisUrl: env.REDIS_URL,
    volumes: resolveVolumes(env),
    version: env.FORGE_VERSION ?? '0.1.0',
    /** Cron for automatic backups ("off" disables). */
    backupSchedule: env.FORGE_BACKUP_SCHEDULE ?? '0 2 * * *',
    backupRetention: Number(env.FORGE_BACKUP_RETENTION ?? 7),
    auditRetentionDays: Number(env.FORGE_AUDIT_RETENTION_DAYS ?? 365),
    deletedUserRetentionDays: Number(env.FORGE_DELETED_USER_RETENTION_DAYS ?? 30),
    timezone: env.TZ ?? 'UTC',
  };
}

export type WorkerConfig = ReturnType<typeof loadWorkerConfig>;
