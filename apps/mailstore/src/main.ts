import { join } from 'node:path';
import { mailStoreToken, readMasterSecret } from '@forge/mail';
import { BlobStore, createMailStoreServer, resolveVolumes } from '@forge/storage';
import pino from 'pino';


/** The "mail-store" container: owns the mailbox volume and serves it to the other mail services. */
async function main() {
  const env = process.env;
  const log = pino({ level: env.LOG_LEVEL ?? 'info' });
  const volumes = resolveVolumes(env);
  const secret = await readMasterSecret({ certsDir: volumes.certs.path });
  if (!secret) throw new Error('The master secret is not available: set FORGE_SECRET or mount forge_certs (the directory service creates it on first start)');
  const root = join(volumes.mail.path, 'blobs');
  await new BlobStore(root).init();
  const port = Number(env.PORT ?? 8096);
  const server = createMailStoreServer({ root, token: mailStoreToken(secret), maxBytes: Number(env.FORGE_MAIL_STORE_MAX_BYTES ?? 200 * 1024 * 1024), log });
  server.listen(port, env.HOST ?? '0.0.0.0', () => log.info({ port, root }, 'ForgeMail mail-store ready'));
  const shutdown = () => server.close(() => process.exit(0));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
