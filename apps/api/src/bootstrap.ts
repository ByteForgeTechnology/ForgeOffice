import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { createTokenVerifier } from '@forge/auth';
import { connectDatabase } from '@forge/db';
import { EventBus, QUEUE_NAMES, createQueue, createRedis, startHeartbeat } from '@forge/events';
import { BlobStore } from '@forge/storage';
import { buildApp } from './app';
import type { AppConfig } from './config';
import type { AppContext, Queues } from './context';
import { loadSigningKeys } from './oidc/keys';
import { createProvider } from './oidc/provider';
import { attachRealtime } from './plugins/realtime';
import { deriveKeys, resolveMasterSecret, resolveSetupToken } from './secrets';
import { AuditService } from './services/audit';
import { getPrimaryOrg } from './services/directory';

/** Wire up every dependency, build the Fastify app and return start/stop handles. */
export async function bootstrap(config: AppConfig, logger: FastifyBaseLogger) {
  for (const v of Object.values(config.volumes)) await mkdir(v.path, { recursive: true, mode: v.key === 'certs' ? 0o700 : 0o750 });

  const secret = await resolveMasterSecret(config.volumes.certs.path, config.secret);
  const keys = deriveKeys(secret);
  const signing = await loadSigningKeys(config.volumes.certs.path);

  const dbHandle = await connectDatabase(config.databaseUrl);
  logger.info({ driver: dbHandle.driver }, 'running database migrations');
  await dbHandle.migrate(config.migrationsDir);

  const redis = config.redisUrl ? createRedis(config.redisUrl) : null;
  if (redis) redis.on('error', (err) => logger.warn({ err: err.message }, 'redis connection error'));
  else logger.warn('REDIS_URL not set: background queues, worker health and multi-replica real-time are disabled');
  const busSub = redis?.duplicate() ?? null;
  const bus = redis && busSub ? new EventBus(redis, busSub) : null;
  const queues = redis ? (Object.fromEntries(QUEUE_NAMES.map((n) => [n, createQueue(n, { url: config.redisUrl! })])) as unknown as Queues) : null;

  const assets = new BlobStore(join(config.volumes.drive.path, 'blobs'));
  await assets.init();

  const events = new EventEmitter();
  const org = await getPrimaryOrg(dbHandle.db);
  const setupToken = org?.setupCompletedAt ? null : await resolveSetupToken(config.volumes.certs.path, config.setupToken);

  const ctx: AppContext = {
    config,
    dbHandle,
    db: dbHandle.db,
    keys,
    signing,
    setupToken,
    assets,
    redis,
    bus,
    queues,
    events,
    audit: new AuditService(dbHandle.db, events, bus, logger),
    verifyAccessToken: createTokenVerifier({ issuer: config.issuer, audience: config.apiAudience, jwks: signing.publicJwks }),
  };

  const forge = createProvider(ctx, logger);
  const app = await buildApp(ctx, forge, { logger });
  let realtime: ReturnType<typeof attachRealtime> | null = null;
  let stopHeartbeat = () => {};

  return {
    ctx,
    app,
    forge,
    async start() {
      await app.listen({ host: config.host, port: config.port });
      realtime = attachRealtime(app.server, ctx, logger);
      if (redis) stopHeartbeat = startHeartbeat(redis, { service: 'api', version: config.version });
    },
    async stop() {
      stopHeartbeat();
      await realtime?.close().catch(() => {});
      await app.close().catch(() => {});
      if (queues) await Promise.all(Object.values(queues).map((q) => q.close())).catch(() => {});
      busSub?.disconnect();
      redis?.disconnect();
      await dbHandle.close().catch(() => {});
    },
  };
}
