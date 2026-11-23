import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database } from '@forge/db';
import type { EventBus, TypedQueue } from '@forge/events';
import { deriveKey } from '@forge/auth';
import { BlobStore, RemoteBlobStore, type ContentStore } from '@forge/storage';
import type { MailConfig, MailContext, MailLogger } from './context';
import { InlineScheduler, QueueScheduler } from './scheduler';
import { startImapServers } from './server/imap';
import { startSmtpServers } from './server/smtp';
import { loadTlsCredentials } from './tls';

export interface MailRuntimeOptions {
  db: Database;
  /** Local mailbox storage (development and tests). Ignored when `storeUrl` is set. */
  mailDir: string;
  /** The mail-store service, e.g. http://mail-store:8096 (production: the only container mounting mailbox storage). */
  storeUrl?: string | null;
  /** Mailbox storage chosen by the caller (setupStorage: local, or the storage cluster). Wins over storeUrl. */
  blobs?: ContentStore | null;
  bus: EventBus | null;
  events?: EventEmitter;
  deliveryQueue: TypedQueue<'mail-delivery'> | null;
  config: MailConfig;
  log: MailLogger;
}

/** Bearer token every service presents to the mail-store service (derived from the master secret). */
export const mailStoreToken = (masterSecret: string) => deriveKey(masterSecret, 'mail-store-service').toString('base64url');

/** The master secret: given explicitly, FORGE_SECRET, or the file the directory service creates in forge_certs. */
export async function readMasterSecret(config: Pick<MailConfig, 'masterSecret' | 'certsDir'>): Promise<string | null> {
  if (config.masterSecret) return config.masterSecret;
  if (process.env.FORGE_SECRET) return process.env.FORGE_SECRET;
  try {
    return (await readFile(join(config.certsDir, 'forge-secret'), 'utf8')).trim();
  } catch {
    return null;
  }
}

/** Build the shared mail context (used by the API, worker and mail server). */
export async function createMailContext(opts: MailRuntimeOptions): Promise<MailContext> {
  let blobs: ContentStore;
  if (opts.blobs) {
    blobs = opts.blobs;
  } else if (opts.storeUrl) {
    const secret = await readMasterSecret(opts.config);
    if (!secret) throw new Error('FORGE_MAIL_STORE_URL is set but the master secret (FORGE_SECRET or forge_certs/forge-secret) is not available');
    blobs = new RemoteBlobStore(opts.storeUrl, mailStoreToken(secret));
  } else {
    const local = new BlobStore(join(opts.mailDir, 'blobs'));
    await local.init();
    blobs = local;
  }
  const ctx: MailContext = {
    db: opts.db,
    blobs,
    bus: opts.bus,
    events: opts.events ?? new EventEmitter(),
    config: opts.config,
    log: opts.log,
    scheduler: null as unknown as MailContext['scheduler'],
  };
  ctx.scheduler = opts.deliveryQueue ? new QueueScheduler(opts.deliveryQueue) : new InlineScheduler(() => ctx);
  return ctx;
}

export interface ProtocolPorts {
  host?: string;
  smtp?: number;
  submission?: number;
  submissions?: number;
  imap?: number;
  imaps?: number;
}

export interface ProtocolOptions {
  ports: ProtocolPorts;
  allowInsecureAuth: boolean;
  maxMessageBytes: number;
}

/** Start SMTP (25/587/465) and IMAP (143/993) listeners. */
export async function startMailProtocols(ctx: MailContext, opts: ProtocolOptions) {
  const tls = await loadTlsCredentials(ctx.config.certsDir, ctx.config.hostname);
  if (tls.selfSigned) ctx.log.warn({ hostname: ctx.config.hostname }, 'using a self-signed TLS certificate for SMTP/IMAP; install one in forge_certs/tls');
  const smtp = await startSmtpServers({ ctx, tls, allowInsecureAuth: opts.allowInsecureAuth, maxMessageBytes: opts.maxMessageBytes }, opts.ports);
  const imap = await startImapServers({ ctx, tls, allowInsecureAuth: opts.allowInsecureAuth }, opts.ports);
  return {
    ports: { ...smtp.ports, ...imap.ports },
    async close() {
      await Promise.all([smtp.close(), imap.close()]);
    },
  };
}
