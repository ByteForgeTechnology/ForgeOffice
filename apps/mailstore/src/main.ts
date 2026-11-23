import { join } from 'node:path';
import { hostname } from 'node:os';
import { mailStoreToken, readMasterSecret } from '@forge/mail';
import { createRedis } from '@forge/events';
import { createStoreNode, localAddress, resolveVolumes, startNodeHeartbeat, type NamespaceDirs } from '@forge/storage';
import pino from 'pino';

/**
 * A ForgeOffice storage node ("store" container; formerly "mail-store").
 * Serves the namespaces whose volumes it mounts (FORGE_STORE_NAMESPACES,
 * default mail,drive,team) to the other services. Run one on every machine
 * with disks for ForgeOffice; each blob is kept on several of them.
 */
async function main() {
  const env = process.env;
  const log = pino({ level: env.LOG_LEVEL ?? 'info' });
  const volumes = resolveVolumes(env);
  const secret = await readMasterSecret({ certsDir: volumes.certs.path });
  if (!secret) throw new Error('The master secret is not available: set FORGE_SECRET (the same on every machine) or mount forge_certs');
  const wanted = (env.FORGE_STORE_NAMESPACES ?? 'mail,drive,team').split(',').map((s) => s.trim()).filter(Boolean);
  const all: Record<string, NamespaceDirs> = {
    // The same layout the services used on their own volumes, so existing data is served as it is.
    mail: { blobs: join(volumes.mail.path, 'blobs') },
    drive: { blobs: join(volumes.drive.path, 'blobs'), objects: { root: join(volumes.drive.path, '.previews'), suffix: '.webp' }, uploads: join(volumes.drive.path, '.uploads') },
    team: { blobs: join(volumes.team.path, 'blobs') },
  };
  const namespaces = Object.fromEntries(wanted.filter((ns) => all[ns]).map((ns) => [ns, all[ns]!]));
  if (!Object.keys(namespaces).length) throw new Error(`FORGE_STORE_NAMESPACES names nothing to serve (${wanted.join(', ')})`);
  const first = Object.keys(namespaces)[0] as 'mail' | 'drive' | 'team';
  const port = Number(env.PORT ?? 8096);
  const node = await createStoreNode({
    namespaces,
    token: mailStoreToken(secret),
    // The id lives with the data: the same disk is the same node, wherever it runs.
    idFile: join(volumes[first].path, '.forge-store-node'),
    maxBytes: Number(env.FORGE_STORE_MAX_BYTES ?? env.FORGE_MAIL_STORE_MAX_BYTES ?? 100 * 1024 ** 3),
    log,
  });
  // How the other services reach this node (another machine: its address and published port).
  const url = (env.FORGE_STORE_URL ?? `http://${localAddress()}:${port}`).replace(/\/+$/, '');
  const redis = env.REDIS_URL ? createRedis(env.REDIS_URL) : null;
  redis?.on('error', (err) => log.warn({ err: err.message }, 'redis connection error'));
  const stopBeat = redis ? startNodeHeartbeat(redis as never, node.info, url, (err) => log.warn({ err }, 'could not announce this storage node')) : () => {};
  node.server.listen(port, env.HOST ?? '0.0.0.0', () => log.info({ id: node.id, url, namespaces: Object.keys(namespaces), host: hostname() }, 'ForgeOffice storage node ready'));
  const shutdown = () => {
    stopBeat();
    node.server.close(() => {
      redis?.disconnect();
      process.exit(0);
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
