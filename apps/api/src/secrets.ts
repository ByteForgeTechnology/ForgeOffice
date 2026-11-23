import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { deriveKey, randomToken } from '@forge/auth';
import { smarthostKey } from '@forge/mail';
import { syncSharedFiles, type Database } from '@forge/db';

async function readOrCreate(path: string, create: () => string): Promise<string> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const value = create();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // 'wx' so two replicas booting at once cannot both win.
  try {
    await writeFile(path, value + '\n', { mode: 0o600, flag: 'wx' });
    return value;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return (await readFile(path, 'utf8')).trim();
    throw err;
  }
}

/**
 * The master secret derives cookie-signing and MFA-encryption keys. It comes
 * from FORGE_SECRET or is generated once and persisted in the certs volume.
 */
export async function resolveMasterSecret(certsDir: string, fromEnv: string | null): Promise<string> {
  if (fromEnv) {
    if (fromEnv.length < 32) throw new Error('FORGE_SECRET must be at least 32 characters');
    return fromEnv;
  }
  return readOrCreate(join(certsDir, 'forge-secret'), () => randomToken(48));
}

export interface DerivedKeys {
  cookieKeys: string[];
  totpKey: Buffer;
  shareLinkKey: Buffer;
  /** Encrypts OAuth client secrets of registered applications. */
  oauthSecretKey: Buffer;
  /** Encrypts the SMTP smarthost password (shared with the worker and mail server). */
  smtpRelayKey: Buffer;
}

export function deriveKeys(secret: string): DerivedKeys {
  return {
    cookieKeys: [deriveKey(secret, 'oidc-cookies').toString('base64url')],
    totpKey: deriveKey(secret, 'totp-secrets'),
    shareLinkKey: deriveKey(secret, 'share-links'),
    oauthSecretKey: deriveKey(secret, 'oauth-client-secrets'),
    smtpRelayKey: smarthostKey(secret),
  };
}

const SETUP_TOKEN_FILE = 'setup-token';

/** One-time token that must be presented to run the first-run setup wizard. */
export async function resolveSetupToken(certsDir: string, fromEnv: string | null): Promise<string> {
  if (fromEnv) return fromEnv;
  return readOrCreate(join(certsDir, SETUP_TOKEN_FILE), () => randomToken(18));
}

export async function discardSetupToken(certsDir: string): Promise<void> {
  await rm(join(certsDir, SETUP_TOKEN_FILE), { force: true });
}

/**
 * Bring this machine's keys and certificates in line with the rest of the
 * installation (see syncSharedFiles). On a machine that starts before the
 * directory service has created the database tables, wait for them.
 */
export async function shareKeys(db: Database, secret: string, certsDir: string, log: { info: (o: unknown, m?: string) => void }) {
  for (let attempt = 0; ; attempt++) {
    try {
      const written = await syncSharedFiles(db, secret, certsDir);
      if (written.length) log.info({ files: written }, 'copied shared keys and certificates to this machine');
      return;
    } catch (err) {
      const missing = (err as { code?: string }).code === '42P01' || /shared_files.*does not exist|relation .* does not exist/i.test((err as Error).message);
      if (!missing || attempt > 90) throw err;
      if (attempt === 0) log.info({}, 'waiting for the directory service to create the database tables');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
