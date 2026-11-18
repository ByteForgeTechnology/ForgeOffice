import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type { Database } from '@forge/db';
import type { EventBus, TypedQueue } from '@forge/events';
import { BlobStore } from '@forge/storage';
import type { MailConfig, MailContext, MailLogger } from './context';
import { InlineScheduler, QueueScheduler } from './scheduler';
import { startImapServers } from './server/imap';
import { startSmtpServers } from './server/smtp';
import { loadTlsCredentials } from './tls';

export interface MailRuntimeOptions {
  db: Database;
  mailDir: string;
  bus: EventBus | null;
  events?: EventEmitter;
  deliveryQueue: TypedQueue<'mail-delivery'> | null;
  config: MailConfig;
  log: MailLogger;
}

/** Build the shared mail context (used by the API, worker and mail server). */
export async function createMailContext(opts: MailRuntimeOptions): Promise<MailContext> {
  const blobs = new BlobStore(join(opts.mailDir, 'blobs'));
  await blobs.init();
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
