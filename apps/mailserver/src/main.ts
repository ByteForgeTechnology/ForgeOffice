import { connectDatabase } from '@forge/db';
import { EventBus, createQueue, createRedis, startHeartbeat } from '@forge/events';
import { createMailContext, startMailProtocols } from '@forge/mail';
import { resolveVolumes } from '@forge/storage';
import pino from 'pino';

const env = process.env;
const port = (name: string, def: number) => (env[name] === 'off' ? undefined : Number(env[name] ?? def));

/** Standalone SMTP + IMAP server (the "mail" container). */
async function main() {
  const log = pino({ level: env.LOG_LEVEL ?? 'info' });
  const volumes = resolveVolumes(env);
  const publicUrl = (env.FORGE_PUBLIC_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
  const hostname = env.FORGE_MAIL_HOSTNAME ?? new URL(publicUrl).hostname;
  const dbHandle = await connectDatabase(env.DATABASE_URL ?? 'postgres://forge:forge@localhost:5432/forge', { max: 10 });
  const redis = env.REDIS_URL ? createRedis(env.REDIS_URL) : null;
  if (!redis) log.warn('REDIS_URL not set: outbound mail is delivered in-process and IMAP IDLE only sees local changes');
  const sub = redis?.duplicate() ?? null;
  const bus = redis && sub ? new EventBus(redis, sub) : null;
  const deliveryQueue = env.REDIS_URL ? createQueue('mail-delivery', { url: env.REDIS_URL }) : null;

  const ctx = await createMailContext({
    db: dbHandle.db,
    mailDir: volumes.mail.path,
    bus,
    deliveryQueue,
    log,
    config: {
      hostname,
      publicUrl,
      certsDir: volumes.certs.path,
      relayUrl: env.FORGE_SMTP_RELAY || null,
      disableAuthChecks: env.FORGE_MAIL_DISABLE_AUTH_CHECKS === 'true',
    },
  });
  const protocols = await startMailProtocols(ctx, {
    ports: {
      smtp: port('FORGE_SMTP_PORT', 25),
      submission: port('FORGE_SUBMISSION_PORT', 587),
      submissions: port('FORGE_SUBMISSIONS_PORT', 465),
      imap: port('FORGE_IMAP_PORT', 143),
      imaps: port('FORGE_IMAPS_PORT', 993),
    },
    allowInsecureAuth: env.FORGE_MAIL_ALLOW_INSECURE_AUTH === 'true',
    maxMessageBytes: Number(env.FORGE_MAIL_MAX_BYTES ?? 35 * 1024 * 1024),
  });
  const stopHeartbeat = redis ? startHeartbeat(redis, { service: 'mailserver', version: env.FORGE_VERSION ?? '0.2.0' }) : () => {};
  log.info({ hostname, ports: protocols.ports }, 'ForgeMail SMTP/IMAP server ready');

  const shutdown = async () => {
    stopHeartbeat();
    await protocols.close();
    await deliveryQueue?.close();
    sub?.disconnect();
    redis?.disconnect();
    await dbHandle.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
