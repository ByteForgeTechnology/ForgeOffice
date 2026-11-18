import type { Queue } from 'bullmq';
import pino from 'pino';
import { connectDatabase } from '@forge/db';
import { EventBus, createQueue, createRedis, createWorker, startHeartbeat } from '@forge/events';
import { loadWorkerConfig } from './config';
import { createBackupProcessor } from './processors/backup';
import { createMaintenanceProcessor } from './processors/maintenance';
import { createMailDeliveryProcessor } from './processors/mail';
import { createMailContext } from '@forge/mail';

async function main() {
  const config = loadWorkerConfig();
  const log = pino({ level: config.logLevel });
  const conn = { url: config.redisUrl };

  const dbHandle = await connectDatabase(config.databaseUrl, { max: 4 });
  if (dbHandle.driver !== 'postgres') log.warn('worker is running against PGlite; database dumps are skipped');
  const redis = createRedis(config.redisUrl);
  redis.on('error', (err) => log.warn({ err: err.message }, 'redis connection error'));
  const bus = new EventBus(redis, redis.duplicate());

  // Register repeatable jobs (idempotent: upsert by scheduler id).
  const maintenance = createQueue('maintenance', conn);
  const backupsQueue = createQueue('backups', conn);
  const tz = config.timezone;
  await maintenance.upsertJobScheduler('purge-expired-oidc', { pattern: '17 * * * *', tz }, { name: 'purge-expired-oidc', data: {} });
  await maintenance.upsertJobScheduler('scan-volumes', { every: 15 * 60_000 }, { name: 'scan-volumes', data: {} });
  await maintenance.upsertJobScheduler('purge-deleted-users', { pattern: '30 3 * * *', tz }, { name: 'purge-deleted-users', data: {} });
  await maintenance.upsertJobScheduler('prune-audit-log', { pattern: '45 3 * * *', tz }, { name: 'prune-audit-log', data: { olderThanDays: config.auditRetentionDays } });
  await maintenance.upsertJobScheduler('prune-backups', { pattern: '0 4 * * *', tz }, { name: 'prune-backups', data: { keep: config.backupRetention } });
  // BullMQ types scheduler ids as job names; this id intentionally differs.
  const backupScheduler = backupsQueue as unknown as Queue;
  if (config.backupSchedule !== 'off') {
    await backupScheduler.upsertJobScheduler('nightly-backup', { pattern: config.backupSchedule, tz }, { name: 'create-backup', data: { trigger: 'scheduled' }, opts: { attempts: 1 } });
  } else {
    await backupScheduler.removeJobScheduler('nightly-backup');
  }
  // Populate volume usage straight away rather than waiting 15 minutes.
  await maintenance.add('scan-volumes', {}, { jobId: `scan-volumes-boot-${Date.now()}` });

  const mailCtx = await createMailContext({
    db: dbHandle.db,
    mailDir: config.volumes.mail.path,
    bus,
    deliveryQueue: createQueue('mail-delivery', conn),
    log,
    config: {
      hostname: config.mailHostname,
      publicUrl: config.publicUrl,
      certsDir: config.volumes.certs.path,
      relayUrl: config.smtpRelay,
      disableAuthChecks: true,
    },
  });

  const workers = [
    createWorker('mail-delivery', createMailDeliveryProcessor(mailCtx), conn, { concurrency: 8 }),
    createWorker('backups', createBackupProcessor(dbHandle.db, config, bus, log), conn, { concurrency: 1, lockDuration: 10 * 60_000 }),
    createWorker('maintenance', createMaintenanceProcessor(dbHandle.db, redis, config, mailCtx), conn, { concurrency: 2 }),
  ];
  for (const w of workers) {
    w.on('failed', (job, err) => log.error({ queue: w.name, job: job?.name, id: job?.id, err: err.message }, 'job failed'));
    w.on('completed', (job) => log.info({ queue: w.name, job: job.name, id: job.id }, 'job completed'));
    w.on('error', (err) => log.error({ queue: w.name, err: err.message }, 'worker error'));
  }
  const stopHeartbeat = startHeartbeat(redis, { service: 'worker', version: config.version, queues: workers.map((w) => w.name) });
  log.info({ queues: workers.map((w) => w.name) }, 'ForgeOffice worker ready');

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down worker');
    stopHeartbeat();
    await Promise.all(workers.map((w) => w.close()));
    await Promise.all([maintenance.close(), backupsQueue.close()]);
    redis.disconnect();
    await dbHandle.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
