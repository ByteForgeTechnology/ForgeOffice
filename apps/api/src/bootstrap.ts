import { EventEmitter } from 'node:events';
import { loadSessionPolicy, startSessionPolicyRefresh } from './services/sessions';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { createTokenVerifier } from '@forge/auth';
import { connectDatabase, replicaIndex, startSharedFileSync } from '@forge/db';
import { EventBus, QUEUE_NAMES, createQueue, createRedis, startHeartbeat } from '@forge/events';
import { setupStorage } from '@forge/storage';
import { createMailContext, ensureDkimKey, mailStoreToken, startMailProtocols } from '@forge/mail';
import { domains } from '@forge/db';
import { buildApp } from './app';
import { processVersion, scanVersion, type DriveContext } from '@forge/drive';
import { runsAll } from './services';
import type { AppConfig } from './config';
import type { AppContext, Queues } from './context';
import { loadSigningKeys } from './oidc/keys';
import { createProvider } from './oidc/provider';
import { attachRealtime } from './plugins/realtime';
import { attachTeamRealtime } from './plugins/team-realtime';
import { MediaClient, MediaNode, MediaServer, memoryBus, memoryDirectory, memoryPresenceStore, recordingTempDir, redisBus, redisDirectory, redisPresenceStore } from '@forge/team';
import { Emitter } from '@socket.io/redis-emitter';
import { hostname } from 'node:os';
import { createMeetingHost } from './services/media-host';
import { deriveKeys, resolveMasterSecret, resolveSetupToken, shareKeys } from './secrets';
import { AuditService } from './services/audit';
import { getPrimaryOrg } from './services/directory';

/** Wire up every dependency, build the Fastify app and return start/stop handles. */
export async function bootstrap(config: AppConfig, logger: FastifyBaseLogger) {
  const directory = config.services.has('directory');
  const split = !runsAll(config.services);
  // In a split install each container mounts only the volumes it needs.
  for (const v of Object.values(config.volumes)) await mkdir(v.path, { recursive: true, mode: v.key === 'certs' ? 0o700 : 0o750 }).catch((err) => {
    if (!split) throw err;
  });
  logger.info({ services: [...config.services] }, 'starting ForgeOffice services');

  const secret = await resolveMasterSecret(config.volumes.certs.path, config.secret);
  const keys = deriveKeys(secret);

  const dbHandle = await connectDatabase(config.databaseUrl);
  // The directory service owns the schema (several may start at once: migrations take a lock).
  if (config.migrate) {
    logger.info({ driver: dbHandle.driver }, 'running database migrations');
    await dbHandle.migrate(config.migrationsDir);
  }
  // Keys and certificates every machine shares (signing keys, DKIM, TLS), kept in the database.
  const certsDir = config.volumes.certs.path;
  await shareKeys(dbHandle.db, secret, certsDir, logger);
  await loadSigningKeys(certsDir); // creates them if no machine has yet
  await shareKeys(dbHandle.db, secret, certsDir, logger); // if two machines made keys at once, both now use the first
  const signing = await loadSigningKeys(certsDir);
  const stopKeySync = startSharedFileSync(dbHandle.db, secret, certsDir, logger);

  const redis = config.redisUrl ? createRedis(config.redisUrl) : null;
  if (redis) redis.on('error', (err) => logger.warn({ err: err.message }, 'redis connection error'));
  else logger.warn('REDIS_URL not set: background queues, worker health and multi-replica real-time are disabled');
  const busSub = redis?.duplicate() ?? null;
  const bus = redis && busSub ? new EventBus(redis, busSub) : null;
  const queues = redis ? (Object.fromEntries(QUEUE_NAMES.map((n) => [n, createQueue(n, { url: config.redisUrl! })])) as unknown as Queues) : null;

  // Storage: this machine's volumes, or the storage cluster (FORGE_STORE_NODES).
  const storageEnv = { FORGE_STORE_NODES: config.storage.nodes.join(','), FORGE_STORE_REPLICAS: String(config.storage.replicas), FORGE_MAIL_STORE_URL: config.mail.storeUrl ?? undefined, FORGE_STORE_CLUSTER: process.env.FORGE_STORE_CLUSTER };
  const storage = await setupStorage({ env: storageEnv, volumes: config.volumes, token: mailStoreToken(secret), redis: redis as never, index: replicaIndex(dbHandle.db), log: logger });
  if (storage.mode !== 'local') logger.info({ mode: storage.mode, nodes: (await storage.registry?.nodes())?.length ?? 0 }, 'using storage nodes');
  const assets = storage.drive.blobs;

  const mediaDirectory = redis ? redisDirectory(redis) : memoryDirectory();
  const events = new EventEmitter();
  const org = await getPrimaryOrg(dbHandle.db);
  const setupToken = org?.setupCompletedAt || !directory ? null : await resolveSetupToken(certsDir, config.setupToken);
  if (setupToken) await shareKeys(dbHandle.db, secret, certsDir, logger);

  const mail = await createMailContext({
    db: dbHandle.db,
    mailDir: config.volumes.mail.path,
    storeUrl: config.mail.storeUrl,
    blobs: storage.mail,
    bus,
    events,
    deliveryQueue: queues?.['mail-delivery'] ?? null,
    log: logger,
    config: {
      hostname: config.mail.hostname,
      publicUrl: config.publicUrl,
      certsDir: config.volumes.certs.path,
      relayUrl: config.mail.relayUrl,
      masterSecret: secret,
      disableAuthChecks: config.mail.disableAuthChecks,
    },
  });
  // Every domain gets a DKIM key so outbound mail is signed from day one.
  if (config.services.has('mail')) for (const d of await dbHandle.db.select().from(domains)) await ensureDkimKey(mail, d).catch((err) => logger.warn({ err, domain: d.name }, 'could not create DKIM key'));

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
    mail,
    drive: {
      db: dbHandle.db,
      blobs: storage.drive.blobs,
      previews: storage.drive.previews,
      uploads: storage.drive.uploads,
      log: logger,
      redis: redis as unknown as DriveContext['redis'],
      clamav: config.drive.clamav,
      // New file versions: virus scan, then thumbnail and text extraction (worker, or in-process without Redis).
      onVersionStored: async (job) => {
        if (queues) return void (await queues['virus-scan'].add('scan', job));
        void (async () => {
          const verdict = await scanVersion(ctx.drive, job).catch((err) => (logger.warn({ err }, 'virus scan failed'), 'error'));
          if (verdict !== 'infected') await processVersion(ctx.drive, job);
        })().catch((err) => logger.warn({ err }, 'file processing failed'));
      },
    },
    storage,
    team: {
      presence: redis ? redisPresenceStore(redis as never) : memoryPresenceStore(),
      // Meetings: through Redis to any media server; in memory in a single process.
      media: new MediaClient(redis ? redisBus(redis, redis.duplicate()) : memoryBus(), mediaDirectory),
      recordings: storage.team,
      // With Redis, events reach sockets on any team service; the team service's own Socket.IO replaces this when it runs here.
      hub: redis ? emitterHub(redis) : { toUsers: () => {}, toRoom: () => {} },
    },
  };
  // A media server in this process (the media service, or everything in one process).
  const mediaNode = config.services.has('media')
    ? new MediaNode(
        process.env.FORGE_MEDIA_NODE_ID ?? `media-${hostname()}`,
        new MediaServer(config.team.rtc, logger),
        redis ? redisBus(redis, redis.duplicate()) : ctx.team.media.bus,
        mediaDirectory,
        createMeetingHost(ctx, logger),
        { address: config.team.rtc.announcedIp, recordingDir: recordingTempDir(config.volumes.team.path), ffmpegPath: config.team.ffmpegPath },
      )
    : null;

  await loadSessionPolicy(dbHandle.db);
  startSessionPolicyRefresh(dbHandle.db, logger);
  const forge = directory ? createProvider(ctx, logger) : null;
  const app = await buildApp(ctx, forge, { logger });
  let realtime: ReturnType<typeof attachRealtime> | null = null;
  let teamRealtime: ReturnType<typeof attachTeamRealtime> | null = null;
  let protocols: Awaited<ReturnType<typeof startMailProtocols>> | null = null;
  let stopHeartbeat = () => {};

  return {
    ctx,
    app,
    forge,
    async start() {
      await app.listen({ host: config.host, port: config.port });
      if (directory) realtime = attachRealtime(app.server, ctx, logger);
      if (config.services.has('team')) {
        teamRealtime = attachTeamRealtime(app.server, ctx, logger);
        await ctx.team.media.start();
      }
      await mediaNode?.start();
      if (redis) stopHeartbeat = startHeartbeat(redis, { service: split ? [...config.services].join('+') : 'api', version: config.version });
      if (config.mail.embed) {
        protocols = await startMailProtocols(mail, {
          ports: { ...config.mail.ports, host: config.host },
          allowInsecureAuth: config.mail.allowInsecureAuth,
          maxMessageBytes: 35 * 1024 * 1024,
        });
        logger.info({ ports: protocols.ports }, 'embedded SMTP/IMAP listeners started');
      }
    },
    async stop() {
      stopHeartbeat();
      stopKeySync();
      await protocols?.close().catch(() => {});
      await realtime?.close().catch(() => {});
      await teamRealtime?.close().catch(() => {});
      await mediaNode?.stop().catch(() => {});
      await ctx.team.media.stop().catch(() => {});
      await app.close().catch(() => {});
      if (queues) await Promise.all(Object.values(queues).map((q) => q.close())).catch(() => {});
      busSub?.disconnect();
      redis?.disconnect();
      await dbHandle.close().catch(() => {});
    },
  };
}

/** Socket events through Redis (to sockets connected to any team service). */
function emitterHub(redis: import('ioredis').Redis) {
  const emitter = new Emitter(redis, { key: 'forge:team-socket' });
  return {
    toUsers: (ids: string[], event: string, payload: unknown) => {
      if (ids.length) emitter.to([...new Set(ids)].map((id) => `user:${id}`)).emit(event, payload);
    },
    toRoom: (room: string, event: string, payload: unknown) => void emitter.to(room).emit(event, payload),
  };
}
