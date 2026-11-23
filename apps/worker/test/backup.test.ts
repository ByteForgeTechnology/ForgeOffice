import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { backups, connectDatabase, orm, type DatabaseHandle } from '@forge/db';
import type { EventBus } from '@forge/events';
import { loadWorkerConfig } from '../src/config';
import { createBackupProcessor, pruneBackups } from '../src/processors/backup';

let root: string;
let handle: DatabaseHandle;
const events: { backupId: string; status: string }[] = [];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'forge-worker-'));
  handle = await connectDatabase('pglite://memory');
  await handle.migrate(fileURLToPath(new URL('../../../packages/db/drizzle', import.meta.url)));
  await mkdir(join(root, 'drive/blobs/ab/cd'), { recursive: true });
  await writeFile(join(root, 'drive/blobs/ab/cd/file'), 'hello');
  await mkdir(join(root, 'backups'), { recursive: true });
});

afterAll(async () => {
  await handle.close();
  await rm(root, { recursive: true, force: true });
});

it('writes volume tarballs and a manifest, then marks the backup complete', async () => {
  const config = loadWorkerConfig({ REDIS_URL: 'redis://unused', DATABASE_URL: 'pglite://memory', FORGE_DATA_ROOT: root });
  const bus = { publish: async (_: string, e: { backupId: string; status: string }) => void events.push(e) } as unknown as EventBus;
  const process = createBackupProcessor(handle.db, config, bus, { info: () => {} });
  const [row] = await handle.db.insert(backups).values({ trigger: 'manual' }).returning();
  const job = { data: { backupId: row!.id, trigger: 'manual' }, updateProgress: async () => {} } as never;

  const result = (await process(job)) as { name: string };
  const dir = join(root, 'backups', result.name);
  expect((await readdir(dir)).sort()).toEqual(['certs.tar.gz', 'drive.tar.gz', 'mail.tar.gz', 'manifest.json', 'team.tar.gz']);
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  for (const a of manifest.artifacts) expect(a.sha256).toMatch(/^[a-f0-9]{64}$/);
  const [saved] = await handle.db.select().from(backups).where(orm.eq(backups.id, row!.id));
  expect(saved!.status).toBe('completed');
  expect(events.map((e) => e.status)).toEqual(['running', 'completed']);

  expect(await pruneBackups(handle.db, config, 0)).toBe(1);
  expect(await readdir(join(root, 'backups'))).toEqual([]);
});
