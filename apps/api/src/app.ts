import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyBaseLogger, type FastifyReply } from 'fastify';
import helmet from '@fastify/helmet';
import middie from '@fastify/middie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { AppContext } from './context';
import { HttpError, isUniqueViolation } from './errors';
import { interactionRoutes } from './oidc/interactions';
import type { ForgeProvider } from './oidc/provider';
import { adminAuditRoutes } from './routes/admin/audit';
import { adminDomainRoutes } from './routes/admin/domains';
import { adminGroupRoutes } from './routes/admin/groups';
import { adminOrgRoutes } from './routes/admin/org';
import { adminRoleRoutes } from './routes/admin/roles';
import { adminSystemRoutes } from './routes/admin/system';
import { adminUserRoutes } from './routes/admin/users';
import { directoryRoutes } from './routes/directory';
import { meRoutes } from './routes/me';
import { publicRoutes } from './routes/public';
import { adminMailRoutes } from './routes/admin/mail';
import { adminSharedMailboxRoutes } from './routes/admin/shared-mailboxes';
import { adminTransportRuleRoutes } from './routes/admin/transport-rules';
import { adminSenderListRoutes } from './routes/admin/sender-lists';
import { adminAppRoutes } from './routes/admin/apps';
import { connectedAppRoutes } from './routes/connected-apps';
import { sessionRoutes } from './routes/sessions';
import { adminSignatureRoutes, signatureImageRoutes } from './routes/admin/signatures';
import { calendarRoutes } from './routes/calendar';
import { taskRoutes } from './routes/tasks';
import { contactRoutes } from './routes/contacts';
import { davRoutes } from './routes/dav';
import { mailRoutes } from './routes/mail';
import { driveRoutes } from './routes/drive';
import { drivePublicRoutes } from './routes/drive-public';
import { siteRoutes } from './routes/sites';
import { adminDriveRoutes } from './routes/admin/drive';
import { DriveAccessError, DriveError, LockedError } from '@forge/drive';
import type { App } from './types';
import { initSharing } from './services/sharing';
import { SERVICE_NAMES, type ServiceName } from './services';
import { FeatureDisabledError, featureEnabled, type Feature } from '@forge/db';

type Registrar = (app: App, ctx: AppContext) => void;

/** Route groups of each service. */
const SERVICE_ROUTES: Record<ServiceName, Registrar[]> = {
  directory: [publicRoutes, meRoutes, directoryRoutes, adminUserRoutes, adminGroupRoutes, adminDomainRoutes, adminRoleRoutes, adminOrgRoutes, adminAuditRoutes, adminSystemRoutes, adminAppRoutes, connectedAppRoutes, sessionRoutes],
  mail: [mailRoutes, adminMailRoutes, adminSharedMailboxRoutes, adminTransportRuleRoutes, adminSenderListRoutes, adminSignatureRoutes, signatureImageRoutes],
  calendar: [calendarRoutes, davRoutes],
  contacts: [contactRoutes, davRoutes],
  tasks: [taskRoutes],
  drive: [driveRoutes, drivePublicRoutes, siteRoutes, adminDriveRoutes],
};

/** Route groups that belong to an optional product (Admin → Organisation → Features). DAV checks per collection. */
const ROUTE_FEATURES = new Map<Registrar, Feature>([
  [mailRoutes, 'mail'],
  [adminSharedMailboxRoutes, 'mail'],
  [adminTransportRuleRoutes, 'mail'],
  [adminSenderListRoutes, 'mail'],
  [adminSignatureRoutes, 'mail'],
  [signatureImageRoutes, 'mail'],
  [calendarRoutes, 'calendar'],
  [contactRoutes, 'contacts'],
  [taskRoutes, 'tasks'],
  [driveRoutes, 'drive'],
  [drivePublicRoutes, 'drive'],
  [siteRoutes, 'drive'],
  [adminDriveRoutes, 'drive'],
]);

declare module 'fastify' {
  interface FastifyInstance {
    /** "METHOD /url" → the service that serves it. */
    routeOwners: Map<string, ServiceName>;
  }
}

export async function buildApp(ctx: AppContext, forge: ForgeProvider | null, opts: { logger?: FastifyBaseLogger } = {}) {
  const { config } = ctx;
  const app = Fastify({
    ...(opts.logger ? { loggerInstance: opts.logger } : { logger: false }),
    trustProxy: config.trustProxy,
    bodyLimit: 256 * 1024,
    // Signed tokens (download URLs, sharing links) travel in the path.
    maxParamLength: 4096,
  }).withTypeProvider<TypeBoxTypeProvider>() as unknown as App;

  app.decorateRequest('principal', null);

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        // Euro-Office's editor loader (api.js) when Office editing is set up.
        scriptSrc: ["'self'", ...(config.drive.officeUrl ? [new URL(config.drive.officeUrl).origin] : [])],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        // The Office editor (Euro-Office) is embedded and posted to when configured.
        frameSrc: ["'self'", 'blob:', ...(config.drive.officeUrl ? [new URL(config.drive.officeUrl).origin] : [])],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'", ...(config.drive.officeUrl ? [new URL(config.drive.officeUrl).origin] : [])],
        frameAncestors: ["'none'"],
      },
    },
    hsts: config.publicUrl.startsWith('https://') ? undefined : false,
  });
  await app.register(rateLimit, { global: false });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'ForgeOffice API', version: config.version, description: 'Phase 1: identity, directory and administration.' },
      servers: [{ url: config.publicUrl }],
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
      security: [{ bearer: [] }],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs', staticCSP: true });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown; code?: string }, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
    }
    if (err.validation) {
      return reply.code(400).send({ error: 'validation_error', message: err.message });
    }
    if (err instanceof DriveError || err instanceof DriveAccessError) return reply.code(err.status).send({ error: err instanceof DriveError ? err.code : err.status === 404 ? 'not_found' : 'forbidden', message: err.message });
    if (err instanceof LockedError) return reply.code(423).send({ error: 'locked', message: err.message });
    if (err.name === 'BlobTooLargeError') return reply.code(413).send({ error: 'too_large', message: err.message });
    if (err instanceof FeatureDisabledError) return reply.code(403).send({ error: 'feature_disabled', feature: err.feature, message: err.message });
    if (err.name === 'TransportRejectedError') return reply.code(400).send({ error: 'rejected_by_policy', message: `Your message was not sent: ${err.message}` });
    if (isUniqueViolation(err)) return reply.code(409).send({ error: 'conflict', message: 'That value is already in use' });
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.code ?? 'error', message: err.message });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error', message: 'Something went wrong' });
  });

  // --- OIDC provider (Koa app) mounted under /oidc: the directory service -------
  if (forge && config.services.has('directory')) {
    await app.register(middie);
    app.use('/oidc', forge.provider.callback());
  }

  // --- Health probes ---------------------------------------------------------
  app.get('/healthz', { schema: { hide: true } }, async () => ({ status: 'ok' }));
  app.get('/readyz', { schema: { hide: true } }, async (_req, reply) => {
    try {
      await ctx.dbHandle.ping();
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  // --- SPA -------------------------------------------------------------------
  const hasWeb = existsSync(join(config.webDir, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, { root: config.webDir, wildcard: false, index: false, maxAge: '1h', immutable: false });
  }
  const serveSpa = (reply: FastifyReply) => {
    if (!hasWeb) {
      return reply
        .code(503)
        .type('text/plain')
        .send('The ForgeOffice web client has not been built. Run `pnpm --filter @forge/web build`, or use the Vite dev server.');
    }
    return reply.header('Cache-Control', 'no-store').sendFile('index.html');
  };

  // --- Routes ----------------------------------------------------------------
  // Each service registers only its own routes; routeOwners records which
  // service serves which route (the gateway configuration is generated from it).
  const has = (s: ServiceName) => config.services.has(s);
  const routeOwners = new Map<string, ServiceName>();
  app.decorate('routeOwners', routeOwners);
  const scoped = (service: ServiceName, register: (app: App, ctx: AppContext) => void) =>
    app.register(async (instance) => {
      instance.addHook('onRoute', (r) => {
        for (const m of [r.method].flat()) routeOwners.set(`${m} ${r.url}`, service);
      });
      // Products an administrator has switched off answer 403 (data is kept).
      const feature = ROUTE_FEATURES.get(register);
      if (feature)
        instance.addHook('onRequest', async () => {
          if (!(await featureEnabled(ctx.db, feature))) throw new FeatureDisabledError(feature);
        });
      register(instance as unknown as App, ctx);
    });

  initSharing(ctx.db);
  if (has('directory') && forge) {
    interactionRoutes(app, ctx, forge, serveSpa);
    for (const r of ['/interaction/:uid', '/oidc/*']) routeOwners.set(`GET ${r}`, 'directory');
  }
  const registered = new Set<Registrar>();
  for (const service of SERVICE_NAMES) {
    if (!has(service)) continue;
    for (const register of SERVICE_ROUTES[service]) {
      // CalDAV and CardDAV share one handler: register it once when both services run here.
      if (registered.has(register)) continue;
      registered.add(register);
      await scoped(service, register);
    }
  }

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0]!;
    const wantsHtml = req.method === 'GET' && (req.headers.accept ?? '').includes('text/html');
    // Only the directory service renders web pages (the sign-in screens); in a split install the web containers serve the apps.
    if (config.services.has('directory') && wantsHtml && !path.startsWith('/api/') && !path.startsWith('/oidc/') && !path.startsWith('/dav') && !/\.[a-z0-9]+$/i.test(path)) return serveSpa(reply);
    return reply.code(404).send({ error: 'not_found', message: `No route for ${req.method} ${path}` });
  });

  return app;
}
