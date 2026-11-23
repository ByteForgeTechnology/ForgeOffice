import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { auditLog, messages, oidcPayloads, orm, organizations, transportRuleHits, userSessions, users, type Database } from '@forge/db';
import { cleanupUploads, purgeExpired, release, runStarNotifications, type DriveContext } from '@forge/drive';
import { expungeMessages, sendSystemNotice, type MailContext } from '@forge/mail';
import { VOLUME_SCAN_KEY, type JobData, type JobName, type VolumeScan } from '@forge/events';
import { directorySize } from '@forge/storage';
import type { WorkerConfig } from '../config';
import { pruneBackups } from './backup';
import { repairStorage } from './storage';
import type { StorageSetup } from '@forge/storage';

const { and, eq, lt } = orm;

export function createMaintenanceProcessor(db: Database, redis: Redis, config: WorkerConfig, mail: MailContext, drive: DriveContext, storage?: StorageSetup) {
  return async (job: Job<JobData<'maintenance'>, unknown, JobName<'maintenance'>>) => {
    switch (job.name) {
      case 'purge-deleted-users': {
        const cutoff = new Date(Date.now() - config.deletedUserRetentionDays * 86_400_000);
        const doomed = await db.select({ id: users.id }).from(users).where(and(eq(users.status, 'deleted'), lt(users.deletedAt, cutoff)));
        // Release stored mail first; deleting the user row alone would orphan the blobs.
        for (const u of doomed) {
          // Their profile picture's blob, too.
          const [row] = await db.select({ sha: users.avatarSha }).from(users).where(eq(users.id, u.id)).limit(1);
          if (row?.sha) await release(drive, row.sha).catch(() => {});
          const ids = await db.select({ id: messages.id }).from(messages).where(eq(messages.userId, u.id));
          for (let i = 0; i < ids.length; i += 500) await expungeMessages(mail, u.id, ids.slice(i, i + 500).map((m) => m.id));
        }
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
        // The transport-rule match log is a short-lived trace: keep 30 days.
        await db.delete(transportRuleHits).where(lt(transportRuleHits.createdAt, new Date(Date.now() - 30 * 86_400_000)));
        // Session records: kept a while after sign-out or last use (longest session is 90 days).
        await db.delete(userSessions).where(lt(userSessions.lastSeenAt, new Date(Date.now() - 120 * 86_400_000)));
        return { pruned: rows.length };
      }
      case 'purge-drive-trash': {
        // Each organisation's recycle-bin retention (Admin → ForgeDrive).
        let purged = 0;
        for (const org of await db.select({ id: organizations.id, s: organizations.driveSettings }).from(organizations)) purged += await purgeExpired(drive, org.s?.trashDays ?? 93, org.id);
        return { purged };
      }
      case 'storage-repair':
        // Copies on enough storage nodes; adopting older data; emptying retiring nodes.
        return storage ? repairStorage(db, redis, storage, { info: (o, m) => void job.log(`${m ?? ''} ${JSON.stringify(o)}`), warn: (o, m) => void job.log(`${m ?? ''} ${JSON.stringify(o)}`) }) : { skipped: true };
      case 'star-notifications':
        // Changes to starred documents and list items, batched per person.
        return runStarNotifications(db, { publicUrl: config.publicUrl, send: (email) => sendSystemNotice(mail, email).then(() => undefined), log: job.log ? { warn: (o, m) => void job.log(`${m ?? ''} ${JSON.stringify(o)}`) } : undefined });
      case 'cleanup-drive-uploads':
        return { removed: await cleanupUploads(drive) };
      case 'prune-backups':
        return { pruned: await pruneBackups(db, config, (job.data as JobData<'maintenance', 'prune-backups'>).keep) };
      default:
        throw new Error(`Unknown maintenance job ${job.name satisfies never}`);
    }
  };
}
