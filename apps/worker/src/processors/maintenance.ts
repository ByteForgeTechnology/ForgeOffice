import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { auditLog, oidcPayloads, orm, users, type Database } from '@forge/db';
import { VOLUME_SCAN_KEY, type JobData, type JobName, type VolumeScan } from '@forge/events';
import { directorySize } from '@forge/storage';
import type { WorkerConfig } from '../config';
import { pruneBackups } from './backup';

const { and, eq, lt } = orm;

export function createMaintenanceProcessor(db: Database, redis: Redis, config: WorkerConfig) {
  return async (job: Job<JobData<'maintenance'>, unknown, JobName<'maintenance'>>) => {
    switch (job.name) {
      case 'purge-deleted-users': {
        const cutoff = new Date(Date.now() - config.deletedUserRetentionDays * 86_400_000);
        const purged = await db
          .delete(users)
          .where(and(eq(users.status, 'deleted'), lt(users.deletedAt, cutoff)))
          .returning({ id: users.id, email: users.email, orgId: users.orgId });
        for (const u of purged) {
          await db.insert(auditLog).values({ action: 'user.purged', orgId: u.orgId, actorLabel: 'system', targetType: 'user', targetId: u.id, targetLabel: u.email });
        }
        return { purged: purged.length };
      }
      case 'purge-expired-oidc': {
        const rows = await db.delete(oidcPayloads).where(lt(oidcPayloads.expiresAt, new Date())).returning({ id: oidcPayloads.id });
        return { purged: rows.length };
      }
      case 'scan-volumes': {
        const scan: VolumeScan = { scannedAt: new Date().toISOString(), volumes: {} };
        for (const v of Object.values(config.volumes)) scan.volumes[v.key] = await directorySize(v.path);
        await redis.set(VOLUME_SCAN_KEY, JSON.stringify(scan));
        return scan;
      }
      case 'prune-audit-log': {
        const days = (job.data as JobData<'maintenance', 'prune-audit-log'>).olderThanDays;
        const rows = await db
          .delete(auditLog)
          .where(lt(auditLog.createdAt, new Date(Date.now() - days * 86_400_000)))
          .returning({ id: auditLog.id });
        return { pruned: rows.length };
      }
      case 'prune-backups':
        return { pruned: await pruneBackups(db, config, (job.data as JobData<'maintenance', 'prune-backups'>).keep) };
      default:
        throw new Error(`Unknown maintenance job ${job.name satisfies never}`);
    }
  };
}
