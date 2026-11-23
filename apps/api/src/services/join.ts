import { gzipSync } from 'node:zlib';
import type { AppConfig } from '../config';

/**
 * The join code another server's installer asks for (build/install.sh → Custom → Join):
 * the settings every server of one ForgeOffice shares, as one line. Same format as
 * the installer's own join-code.txt: "FORGEJOIN1:" + base64(gzip("KEY=value\n"...)).
 */
export const JOIN_PREFIX = 'FORGEJOIN1:';

export interface JoinInfo {
  /** False when other servers can't join this install; `reason` says why. */
  available: boolean;
  reason: string | null;
  publicUrl: string;
  databaseHost: string | null;
  storageNodes: string[];
  replicas: number;
  release: string | null;
}

/** Names that only mean something inside one machine's Docker network (or the machine itself). */
const LOCAL_HOSTS = new Set(['db', 'postgres', 'redis', 'store', 'mail-store', 'localhost', '127.0.0.1', '::1', '[::1]']);
const isLocal = (host: string) => LOCAL_HOSTS.has(host.toLowerCase());

function database(config: AppConfig): { host: string; password: string } | null {
  try {
    const u = new URL(config.databaseUrl);
    if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return null;
    return { host: u.hostname, password: decodeURIComponent(u.password) };
  } catch {
    return null;
  }
}

export function joinInfo(config: AppConfig): JoinInfo {
  const db = database(config);
  const nodes = config.storage.nodes;
  const base = {
    publicUrl: config.publicUrl,
    databaseHost: db?.host ?? null,
    storageNodes: nodes,
    replicas: config.storage.replicas,
    release: config.image?.split(':')[1] ?? null,
  };
  let reason: string | null = null;
  if (!db) reason = 'ForgeOffice uses a built-in database here, which other servers can’t share.';
  else if (isLocal(db.host))
    reason = 'This ForgeOffice runs on one server (an express install): its database is only reachable inside it. To spread ForgeOffice over several servers, install it with the Custom option, starting a new ForgeOffice.';
  else if (!config.secret) reason = 'FORGE_SECRET isn’t set in this server’s .env, and every server must share it.';
  else if (!nodes.length) reason = 'No storage nodes are set up (FORGE_STORE_NODES), and other servers need them for files.';
  else if (nodes.some((n) => isLocal(new URL(n).hostname))) reason = 'The storage nodes are only reachable inside this server, so other servers can’t use them.';
  return { ...base, available: !reason, reason };
}

/** The join code itself. Holds the database password and the master secret: only for admins. */
export function joinCode(config: AppConfig): string {
  const info = joinInfo(config);
  const db = database(config);
  if (!info.available || !db || !config.secret) throw new Error(info.reason ?? 'Other servers can’t join this ForgeOffice');
  const settings: [string, string][] = [
    ['FORGE_PUBLIC_URL', config.publicUrl],
    ['FORGE_MAIL_HOSTNAME', config.mail.hostname],
    ['POSTGRES_PASSWORD', db.password],
    ['FORGE_SECRET', config.secret],
    ['FORGE_DB_HOST', db.host],
    ['FORGE_STORE_NODES', config.storage.nodes.join(',')],
    ['FORGE_STORE_REPLICAS', String(config.storage.replicas)],
    ...(config.image ? ([['FORGE_IMAGE', config.image]] as [string, string][]) : []),
  ];
  const text = settings.map(([k, v]) => `${k}=${v}\n`).join('');
  return JOIN_PREFIX + gzipSync(text, { level: 9 }).toString('base64');
}
