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
import type { App } from './types';

export async function buildApp(ctx: AppContext, forge: ForgeProvider, opts: { logger?: FastifyBaseLogger } = {}) {
  const { config } = ctx;
  const app = Fastify({
    ...(opts.logger ? { loggerInstance: opts.logger } : { logger: false }),
    trustProxy: config.trustProxy,
    bodyLimit: 256 * 1024,
  }).withTypeProvider<TypeBoxTypeProvider>() as unknown as App;

  app.decorateRequest('principal', null);

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
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
    if (isUniqueViolation(err)) return reply.code(409).send({ error: 'conflict', message: 'That value is already in use' });
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.code ?? 'error', message: err.message });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error', message: 'Something went wrong' });
  });

  // --- OIDC provider (Koa app) mounted under /oidc --------------------------
  await app.register(middie);
  app.use('/oidc', forge.provider.callback());

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
  const scoped = (register: (app: App, ctx: AppContext) => void) =>
    app.register(async (instance) => register(instance as unknown as App, ctx));

  interactionRoutes(app, ctx, forge, serveSpa);
  await scoped(publicRoutes);
  await scoped(meRoutes);
  await scoped(directoryRoutes);
  await scoped(adminUserRoutes);
  await scoped(adminGroupRoutes);
  await scoped(adminDomainRoutes);
  await scoped(adminRoleRoutes);
  await scoped(adminOrgRoutes);
  await scoped(adminAuditRoutes);
  await scoped(adminSystemRoutes);

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0]!;
    const wantsHtml = req.method === 'GET' && (req.headers.accept ?? '').includes('text/html');
    if (wantsHtml && !path.startsWith('/api/') && !path.startsWith('/oidc/') && !/\.[a-z0-9]+$/i.test(path)) return serveSpa(reply);
    return reply.code(404).send({ error: 'not_found', message: `No route for ${req.method} ${path}` });
  });

  return app;
}
