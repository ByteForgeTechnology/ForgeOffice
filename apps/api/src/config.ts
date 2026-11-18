import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVolumes, type ForgeVolume, type VolumeKey } from '@forge/storage';

export interface OidcClientConfig {
  client_id: string;
  client_name?: string;
  client_secret?: string;
  redirect_uris: string[];
  post_logout_redirect_uris?: string[];
  token_endpoint_auth_method?: 'none' | 'client_secret_basic' | 'client_secret_post';
  grant_types?: string[];
  /** First-party clients skip the consent screen. */
  'forge:first_party'?: boolean;
}

export interface AppConfig {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  /** Externally visible origin, e.g. https://office.example.com (no trailing slash). */
  publicUrl: string;
  issuer: string;
  apiAudience: string;
  databaseUrl: string;
  redisUrl: string | null;
  /** Installation master secret. Resolved at boot (env or persisted file). */
  secret: string | null;
  setupToken: string | null;
  trustProxy: boolean;
  logLevel: string;
  volumes: Record<VolumeKey, ForgeVolume>;
  migrationsDir: string;
  webDir: string;
  dockerSocket: string | null;
  composeProject: string;
  extraClients: OidcClientConfig[];
  version: string;
}

// Both src/config.ts and dist/main.js live 3 levels below the repo root, so
// the same relative URLs work in development and in the bundled build.
const ROOT = new URL('../../../', import.meta.url);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = (env.NODE_ENV ?? 'development') as AppConfig['env'];
  const dev = nodeEnv === 'development';
  const port = Number(env.PORT ?? 8080);
  // Development defaults need no external services: embedded PGlite under
  // ./.data and the Vite dev server (which proxies to this API) as public origin.
  const devRoot = fileURLToPath(new URL('.data', ROOT));
  const dataRoot = env.FORGE_DATA_ROOT ?? (dev ? devRoot : '/data');
  const publicUrl = (env.FORGE_PUBLIC_URL ?? (dev ? 'http://localhost:5173' : `http://localhost:${port}`)).replace(/\/+$/, '');
  let extraClients: OidcClientConfig[] = [];
  if (env.FORGE_OIDC_CLIENTS) {
    try {
      extraClients = JSON.parse(env.FORGE_OIDC_CLIENTS);
    } catch {
      throw new Error('FORGE_OIDC_CLIENTS must be a JSON array of OIDC client definitions');
    }
  }
  return {
    env: nodeEnv,
    host: env.HOST ?? '0.0.0.0',
    port,
    publicUrl,
    issuer: `${publicUrl}/oidc`,
    apiAudience: `${publicUrl}/api`,
    databaseUrl: env.DATABASE_URL ?? (dev ? `pglite://${join(dataRoot, 'pglite')}` : 'postgres://forge:forge@localhost:5432/forge'),
    redisUrl: env.REDIS_URL || null,
    secret: env.FORGE_SECRET || null,
    setupToken: env.FORGE_SETUP_TOKEN || null,
    trustProxy: env.FORGE_TRUST_PROXY ? env.FORGE_TRUST_PROXY === 'true' : nodeEnv === 'production',
    logLevel: env.LOG_LEVEL ?? (nodeEnv === 'production' ? 'info' : 'debug'),
    volumes: resolveVolumes({ ...env, FORGE_DATA_ROOT: dataRoot }),
    migrationsDir: env.FORGE_MIGRATIONS_DIR ?? fileURLToPath(new URL('packages/db/drizzle', ROOT)),
    webDir: env.FORGE_WEB_DIR ?? fileURLToPath(new URL('apps/web/dist', ROOT)),
    dockerSocket: env.FORGE_DOCKER_SOCKET || null,
    composeProject: env.COMPOSE_PROJECT_NAME ?? 'forgeoffice',
    extraClients,
    version: env.FORGE_VERSION ?? '0.1.0',
  };
}
