import { join } from 'node:path';
import pino from 'pino';
import { bootstrap } from './bootstrap';
import { loadConfig } from './config';

async function main() {
  const config = loadConfig();
  const pretty = config.env !== 'production' && (await import('pino-pretty').then(() => true).catch(() => false));
  const logger = pino({
    level: config.logLevel,
    redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    ...(pretty ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } } } : {}),
  });

  const server = await bootstrap(config, logger);
  await server.start();
  logger.info({ publicUrl: config.publicUrl, issuer: config.issuer }, 'ForgeOffice API ready');

  if (server.ctx.setupToken) {
    logger.warn(
      `\n\n  ForgeOffice is not set up yet.\n  Open ${config.publicUrl}/setup and enter this setup token:\n\n      ${server.ctx.setupToken}\n\n  (also stored in ${join(config.volumes.certs.path, 'setup-token')})\n`,
    );
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    await server.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
