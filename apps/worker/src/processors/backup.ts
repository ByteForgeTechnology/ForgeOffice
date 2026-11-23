import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { StorageSetup } from '@forge/storage';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Job } from 'bullmq';
import { auditLog, backups, orm, type BackupManifest, type Database } from '@forge/db';
import type { EventBus, JobData } from '@forge/events';
import type { VolumeKey } from '@forge/storage';
import type { WorkerConfig } from '../config';

const { and, desc, eq, notInArray } = orm;

/** Volumes captured in every backup (the backups volume itself is excluded). */
const BACKUP_VOLUMES: VolumeKey[] = ['mail', 'drive', 'team', 'certs'];

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = {}, okCodes = [0]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
    child.on('error', (err) => reject(new Error(`${cmd} could not be started: ${err.message}`)));
    child.on('close', (code) => (okCodes.includes(code ?? -1) ? resolve() : reject(new Error(`${cmd} exited with ${code}: ${stderr.trim()}`))));
  });
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Pass credentials to pg_dump through libpq env vars so they never appear in argv. */
function pgEnv(url: string): NodeJS.ProcessEnv {
  const u = new URL(url);
  return {
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: u.pathname.replace(/^\//, ''),
    ...(u.searchParams.get('sslmode') ? { PGSSLMODE: u.searchParams.get('sslmode')! } : {}),
  };
}

function backupName(date = new Date()): string {
  return `forge-${date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}`;
}

export function createBackupProcessor(db: Database, config: WorkerConfig, bus: EventBus, log: { info: (o: unknown, m?: string) => void }, storage?: StorageSetup) {
  const publish = (backupId: string, status: string) => bus.publish('backup.updated', { backupId, status }).catch(() => {});

  return async (job: Job<JobData<'backups', 'create-backup'>>) => {
    let backupId = job.data.backupId;
    if (!backupId) {
      const [row] = await db.insert(backups).values({ trigger: job.data.trigger }).returning();
      backupId = row!.id;
    }
    const name = backupName();
    const root = config.volumes.backups.path;
    const partial = join(root, `${name}.partial`);
    const final = join(root, name);
    await db.update(backups).set({ status: 'running', startedAt: new Date(), name }).where(eq(backups.id, backupId));
    await publish(backupId, 'running');

    try {
      await mkdir(partial, { recursive: true, mode: 0o700 });
      const manifest: BackupManifest = { version: 1, createdAt: new Date().toISOString(), artifacts: [] };
      const steps = 1 + BACKUP_VOLUMES.length;
      let done = 0;

      if (config.databaseUrl.startsWith('postgres')) {
        const file = join(partial, 'database.pgdump');
        await run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--file=${file}`], pgEnv(config.databaseUrl));
        manifest.artifacts.push({ name: 'database.pgdump', kind: 'database', source: 'postgresql', bytes: (await stat(file)).size, sha256: await sha256File(file) });
      }
      await job.updateProgress(Math.round((++done / steps) * 100));

      for (const key of BACKUP_VOLUMES) {
        const volume = config.volumes[key];
        // On storage nodes: each node sends an archive of its share (its copies).
        const ns = key as 'mail' | 'drive' | 'team';
        if (storage?.cluster && storage.registry && ns in storage.cluster) {
          for (const node of (await storage.registry.nodes()).filter((n) => n.namespaces.includes(ns))) {
            const name = `${key}-${node.id}.tar.gz`;
            const file = join(partial, name);
            await pipeline(await storage.cluster[ns].snapshot(node), createWriteStream(file, { mode: 0o600 }));
            manifest.artifacts.push({ name, kind: 'volume', source: `${volume.volume} on ${node.id}`, bytes: (await stat(file)).size, sha256: await sha256File(file) });
          }
          await job.updateProgress(Math.round((++done / steps) * 100));
          continue;
        }
        const file = join(partial, `${key}.tar.gz`);
        await mkdir(volume.path, { recursive: true }); // an unused volume yields an empty archive
        // GNU tar exits 1 when files change during the read; the archive is still valid.
        await run('tar', ['--create', '--gzip', `--file=${file}`, `--directory=${volume.path}`, '--exclude=./blobs/.tmp', '.'], {}, [0, 1]);
        manifest.artifacts.push({ name: `${key}.tar.gz`, kind: 'volume', source: volume.volume, bytes: (await stat(file)).size, sha256: await sha256File(file) });
        await job.updateProgress(Math.round((++done / steps) * 100));
      }

      await writeFile(join(partial, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
      // Rename only once complete so a backup directory without the suffix is always whole.
      await rename(partial, final);
      const sizeBytes = manifest.artifacts.reduce((n, a) => n + a.bytes, 0);
      await db.update(backups).set({ status: 'completed', finishedAt: new Date(), sizeBytes, manifest }).where(eq(backups.id, backupId));
      await db.insert(auditLog).values({ action: 'backup.completed', actorLabel: 'system', targetType: 'backup', targetId: backupId, targetLabel: name, metadata: { sizeBytes, trigger: job.data.trigger } });
      await publish(backupId, 'completed');
      log.info({ backupId, name, sizeBytes }, 'backup completed');
      return { name, sizeBytes };
    } catch (err) {
      await rm(partial, { recursive: true, force: true });
      const message = (err as Error).message;
      await db.update(backups).set({ status: 'failed', finishedAt: new Date(), error: message }).where(eq(backups.id, backupId));
      await db.insert(auditLog).values({ action: 'backup.failed', outcome: 'failure', actorLabel: 'system', targetType: 'backup', targetId: backupId, targetLabel: name, metadata: { error: message } });
      await publish(backupId, 'failed');
      throw err;
    }
  };
}

/** Keep the newest `keep` completed backups; delete older ones and stray partial directories. */
export async function pruneBackups(db: Database, config: WorkerConfig, keep: number): Promise<number> {
  const keepRows = await db
    .select({ id: backups.id })
    .from(backups)
    .where(eq(backups.status, 'completed'))
    .orderBy(desc(backups.createdAt))
    .limit(keep);
  const stale = await db
    .select()
    .from(backups)
    .where(and(eq(backups.status, 'completed'), keepRows.length ? notInArray(backups.id, keepRows.map((r) => r.id)) : undefined));
  for (const b of stale) {
    if (b.name && /^[\w.-]+$/.test(b.name)) await rm(join(config.volumes.backups.path, b.name), { recursive: true, force: true });
    await db.delete(backups).where(eq(backups.id, b.id));
  }
  for (const entry of await readdir(config.volumes.backups.path).catch(() => [] as string[])) {
    if (entry.endsWith('.partial')) {
      const s = await stat(join(config.volumes.backups.path, entry));
      if (Date.now() - s.mtimeMs > 24 * 3600_000) await rm(join(config.volumes.backups.path, entry), { recursive: true, force: true });
    }
  }
  return stale.length;
}
