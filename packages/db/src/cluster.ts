import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from './client';
import { blobReplicas, sharedFiles } from './schema';

// ---------------------------------------------------------------------------
// Replica index for the storage cluster (@forge/storage ClusterStore)
// ---------------------------------------------------------------------------

export function replicaIndex(db: Database) {
  return {
    async locations(ns: string, sha256: string) {
      return (await db.select({ id: blobReplicas.nodeId }).from(blobReplicas).where(and(eq(blobReplicas.namespace, ns), eq(blobReplicas.sha256, sha256)))).map((r) => r.id);
    },
    async add(ns: string, sha256: string, nodeId: string) {
      await db.insert(blobReplicas).values({ namespace: ns, sha256, nodeId }).onConflictDoNothing();
    },
    async remove(ns: string, sha256: string, nodeId?: string) {
      await db.delete(blobReplicas).where(and(eq(blobReplicas.namespace, ns), eq(blobReplicas.sha256, sha256), nodeId ? eq(blobReplicas.nodeId, nodeId) : undefined));
    },
  };
}

/** Blobs with fewer than `want` copies on the given (live, not retiring) nodes. */
export async function underReplicated(db: Database, ns: string, goodNodes: string[], want: number, limit = 500) {
  const rows = await db
    .select({
      sha256: blobReplicas.sha256,
      nodes: sql<string[]>`array_agg(${blobReplicas.nodeId})`,
      good: sql<number>`count(*) filter (where ${goodNodes.length ? inArray(blobReplicas.nodeId, goodNodes) : sql`false`})::int`,
    })
    .from(blobReplicas)
    .where(eq(blobReplicas.namespace, ns))
    .groupBy(blobReplicas.sha256)
    .having(sql`count(*) filter (where ${goodNodes.length ? inArray(blobReplicas.nodeId, goodNodes) : sql`false`}) < ${want}`)
    .limit(limit);
  return rows;
}

/** Blobs a node holds (to move them off a node being retired). */
export async function blobsOnNode(db: Database, ns: string, nodeId: string, limit = 500) {
  return (await db.select({ sha256: blobReplicas.sha256 }).from(blobReplicas).where(and(eq(blobReplicas.namespace, ns), eq(blobReplicas.nodeId, nodeId))).orderBy(asc(blobReplicas.sha256)).limit(limit)).map((r) => r.sha256);
}

/** Copies per node and namespace (admin overview). */
export async function replicaStats(db: Database) {
  return db
    .select({ nodeId: blobReplicas.nodeId, namespace: blobReplicas.namespace, blobs: sql<number>`count(*)::int` })
    .from(blobReplicas)
    .groupBy(blobReplicas.nodeId, blobReplicas.namespace);
}

export async function forgetNode(db: Database, nodeId: string) {
  await db.delete(blobReplicas).where(eq(blobReplicas.nodeId, nodeId));
}


// ---------------------------------------------------------------------------
// Shared keys and certificates across machines
// ---------------------------------------------------------------------------

const FINGERPRINT = '__fingerprint';
const DELETED = '__deleted__';
/** Files in the certs directory every machine needs. The master secret itself never goes in the database. */
const SHARED = [/^oidc\/jwks\.json$/, /^dkim\/[^/]+\.key$/, /^tls\/(fullchain|privkey)\.pem$/, /^tls\/self-signed\/[^/]+$/, /^setup-token$/];
export const isSharedFile = (rel: string) => SHARED.some((re) => re.test(rel));

const keyFor = (secret: string) => Buffer.from(hkdfSync('sha256', secret, 'forge-shared-files', 'aes-256-gcm', 32));

function encrypt(secret: string, data: Buffer) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFor(secret), iv);
  const body = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

function decrypt(secret: string, value: string) {
  const raw = Buffer.from(value, 'base64');
  const d = createDecipheriv('aes-256-gcm', keyFor(secret), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
}

export class SecretMismatchError extends Error {
  constructor() {
    super('This machine’s master secret is different from the one the rest of ForgeOffice uses. Set FORGE_SECRET to the same value on every machine.');
    this.name = 'SecretMismatchError';
  }
}

/** Record (or check) a fingerprint of the master secret, so a machine with a different one stops early. */
export async function checkSecretFingerprint(db: Database, secret: string) {
  const fp = createHmac('sha256', secret).update('forge-secret-fingerprint').digest('base64url');
  await db.insert(sharedFiles).values({ path: FINGERPRINT, value: fp }).onConflictDoNothing();
  const [row] = await db.select().from(sharedFiles).where(eq(sharedFiles.path, FINGERPRINT)).limit(1);
  if (row && row.value !== fp) throw new SecretMismatchError();
}

async function localShared(certsDir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && isSharedFile(relative(certsDir, p))) out.push(relative(certsDir, p));
    }
  };
  for (const top of ['oidc', 'dkim', 'tls']) await walk(join(certsDir, top));
  if (await stat(join(certsDir, 'setup-token')).then(() => true, () => false)) out.push('setup-token');
  return out;
}

/**
 * Make this machine's certs directory and the database agree:
 *   - files in the database are written here (the database wins, so every
 *     machine ends up with the same keys even if two made one at once),
 *   - files only here are added to the database,
 *   - files removed from the cluster (the setup token, once used) are removed here.
 * Returns the paths written locally.
 */
export async function syncSharedFiles(db: Database, secret: string, certsDir: string): Promise<string[]> {
  await checkSecretFingerprint(db, secret);
  const written: string[] = [];
  const pull = async () => {
    const rows = (await db.select().from(sharedFiles)).filter((r) => r.path !== FINGERPRINT && isSharedFile(r.path));
    for (const r of rows) {
      const path = join(certsDir, r.path);
      if (r.value === DELETED) {
        await rm(path, { force: true });
        continue;
      }
      let data: Buffer;
      try {
        data = decrypt(secret, r.value);
      } catch {
        continue; // written with another secret: the fingerprint check stops that case earlier
      }
      const local = await readFile(path).catch(() => null);
      if (local && local.equals(data)) continue;
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, data, { mode: 0o600 });
      written.push(r.path);
    }
    return new Set(rows.map((r) => r.path));
  };
  const known = await pull();
  let pushed = false;
  for (const rel of await localShared(certsDir)) {
    if (known.has(rel)) continue;
    const data = await readFile(join(certsDir, rel));
    await db.insert(sharedFiles).values({ path: rel, value: encrypt(secret, data) }).onConflictDoNothing();
    pushed = true;
  }
  // Another machine may have added the same file at the same moment: take whichever won.
  if (pushed) await pull();
  return written;
}

/** Replace a shared file everywhere (e.g. a renewed certificate), or remove it with null. */
export async function setSharedFile(db: Database, secret: string, certsDir: string, rel: string, data: Buffer | null) {
  if (!isSharedFile(rel)) throw new Error(`${rel} is not a shared file`);
  const value = data ? encrypt(secret, data) : DELETED;
  await db.insert(sharedFiles).values({ path: rel, value }).onConflictDoUpdate({ target: sharedFiles.path, set: { value, updatedAt: new Date() } });
  const path = join(certsDir, rel);
  if (data) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, data, { mode: 0o600 });
  } else await rm(path, { force: true });
}

/** Keep pulling every few minutes (DKIM keys for new domains, renewed certificates). */
export function startSharedFileSync(db: Database, secret: string, certsDir: string, log: { warn: (o: unknown, m?: string) => void }, everyMs = 120_000) {
  const t = setInterval(() => void syncSharedFiles(db, secret, certsDir).catch((err) => log.warn({ err }, 'could not sync shared keys')), everyMs);
  t.unref();
  return () => clearInterval(t);
}

/** Remove a shared file everywhere (machines delete their copy on their next sync). */
export async function removeSharedFile(db: Database, certsDir: string, rel: string) {
  await db.insert(sharedFiles).values({ path: rel, value: DELETED }).onConflictDoUpdate({ target: sharedFiles.path, set: { value: DELETED, updatedAt: new Date() } });
  await rm(join(certsDir, rel), { force: true });
}
