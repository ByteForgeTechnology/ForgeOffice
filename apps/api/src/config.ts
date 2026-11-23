import { join } from 'node:path';
import { parseServices, type ServiceName } from './services';
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
  /** Which back-end services this process runs (FORGE_SERVICES; default all). */
  services: Set<ServiceName>;
  /** Apply database migrations at start-up (FORGE_MIGRATE; default: when running the directory service). */
  migrate: boolean;
  drive: {
    /** ClamAV daemon for virus scanning (FORGE_CLAMAV=host:port); null = off. */
    clamav: { host: string; port: number } | null;
    /** A WOPI Office editor (Euro-Office, or Collabora Online) as browsers reach it (FORGE_OFFICE_URL). */
    officeUrl: string | null;
    /** Where this service reaches the editor itself (FORGE_OFFICE_INTERNAL_URL; default officeUrl). */
    officeInternalUrl: string | null;
    /**
     * How the editor is integrated (FORGE_OFFICE_PROTOCOL): "docs" = the
     * ONLYOFFICE Docs API that Euro-Office speaks natively (real-time
     * co-editing; the default), "wopi" = WOPI (Collabora Online).
     */
    officeProtocol: 'docs' | 'wopi';
    /** Secret shared with the document server (FORGE_OFFICE_JWT_SECRET = its JWT_SECRET). */
    officeJwtSecret: string | null;
    /** Where the editor reaches the drive service's WOPI endpoints (FORGE_WOPI_URL; default the public URL). */
    wopiUrl: string;
  };
  team: {
    /** Meeting media (WebRTC) ports: FORGE_RTC_MIN_PORT–FORGE_RTC_MAX_PORT, UDP and TCP. */
    rtc: { listenIp: string; announcedIp: string | null; minPort: number; maxPort: number; workers: number };
    ffmpegPath: string;
  };
  mail: {
    /** The mail-store service (FORGE_MAIL_STORE_URL); unset = local mailbox storage. */
    storeUrl: string | null;
    hostname: string;
    relayUrl: string | null;
    /** Run SMTP/IMAP inside the API process (development / single-container). */
    embed: boolean;
    ports: { smtp?: number; submission?: number; submissions?: number; imap?: number; imaps?: number };
    allowInsecureAuth: boolean;
    disableAuthChecks: boolean;
  };
}

// Both src/config.ts and dist/main.js live 3 levels below the repo root, so
// the same relative URLs work in development and in the bundled build.
const ROOT = new URL('../../../', import.meta.url);

function optionalPort(value: string | undefined, fallback: number | undefined): number | undefined {
  if (value === 'off') return undefined;
  return value !== undefined ? Number(value) : fallback;
}

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
    // The all-in-one web build; the directory service uses the portal build (sign-in pages).
    webDir: env.FORGE_WEB_DIR ?? fileURLToPath(new URL('apps/web/dist/all', ROOT)),
    dockerSocket: env.FORGE_DOCKER_SOCKET || null,
    composeProject: env.COMPOSE_PROJECT_NAME ?? 'forgeoffice',
    extraClients,
    version: env.FORGE_VERSION ?? '0.2.0',
    services: parseServices(env.FORGE_SERVICES),
    drive: {
      clamav: env.FORGE_CLAMAV ? { host: env.FORGE_CLAMAV.split(':')[0]!, port: Number(env.FORGE_CLAMAV.split(':')[1] ?? 3310) } : null,
      // FORGE_COLLABORA_* are the earlier names, still accepted.
      officeUrl: (env.FORGE_OFFICE_URL || env.FORGE_COLLABORA_URL)?.replace(/\/+$/, '') || null,
      officeInternalUrl: (env.FORGE_OFFICE_URL || env.FORGE_COLLABORA_URL) ? (env.FORGE_OFFICE_INTERNAL_URL || env.FORGE_COLLABORA_INTERNAL_URL || env.FORGE_OFFICE_URL || env.FORGE_COLLABORA_URL)!.replace(/\/+$/, '') : null,
      wopiUrl: (env.FORGE_WOPI_URL ?? publicUrl).replace(/\/+$/, ''),
      officeProtocol: env.FORGE_OFFICE_PROTOCOL === 'wopi' || (!env.FORGE_OFFICE_PROTOCOL && !env.FORGE_OFFICE_URL && !!env.FORGE_COLLABORA_URL) ? 'wopi' : 'docs',
      officeJwtSecret: env.FORGE_OFFICE_JWT_SECRET || null,
    },
    team: {
      rtc: {
        listenIp: env.FORGE_RTC_LISTEN_IP ?? '0.0.0.0',
        // Browsers send media here: this machine's LAN or public address (127.0.0.1 only works on this machine).
        announcedIp: env.FORGE_RTC_ANNOUNCED_IP || null,
        minPort: Number(env.FORGE_RTC_MIN_PORT ?? 40000),
        maxPort: Number(env.FORGE_RTC_MAX_PORT ?? 40099),
        workers: Number(env.FORGE_RTC_WORKERS ?? 1),
      },
      ffmpegPath: env.FORGE_FFMPEG ?? 'ffmpeg',
    },
    migrate: env.FORGE_MIGRATE ? env.FORGE_MIGRATE === 'true' : parseServices(env.FORGE_SERVICES).has('directory'),
    mail: {
      storeUrl: env.FORGE_MAIL_STORE_URL || null,
      hostname: env.FORGE_MAIL_HOSTNAME ?? new URL(publicUrl).hostname,
      relayUrl: env.FORGE_SMTP_RELAY || null,
      embed: env.FORGE_MAIL_EMBED ? env.FORGE_MAIL_EMBED === 'true' : dev,
      // Unprivileged ports in development; standard ports when embedded in production.
      ports: {
        smtp: optionalPort(env.FORGE_SMTP_PORT, dev ? 2525 : 25),
        submission: optionalPort(env.FORGE_SUBMISSION_PORT, dev ? 2587 : 587),
        submissions: optionalPort(env.FORGE_SUBMISSIONS_PORT, dev ? undefined : 465),
        imap: optionalPort(env.FORGE_IMAP_PORT, dev ? 2143 : 143),
        imaps: optionalPort(env.FORGE_IMAPS_PORT, dev ? undefined : 993),
      },
      allowInsecureAuth: env.FORGE_MAIL_ALLOW_INSECURE_AUTH ? env.FORGE_MAIL_ALLOW_INSECURE_AUTH === 'true' : dev,
      disableAuthChecks: env.FORGE_MAIL_DISABLE_AUTH_CHECKS === 'true',
    },
  };
}
