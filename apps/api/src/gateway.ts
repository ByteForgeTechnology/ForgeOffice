import { SERVICE_NAMES, SERVICE_PORTS, type ServiceName } from './services';

/**
 * The gateway (Caddy) gives browsers and apps one address and sends each
 * request to the container that serves it. Its configuration is generated
 * from the routes every service registers (see test/gateway.test.ts), so it
 * cannot drift from the code.
 */

/** Web front-end containers: path prefix → container. */
export const WEB_APPS = [
  { app: 'mail', prefix: '/mail', host: 'mail-web', port: 8082 },
  { app: 'calendar', prefix: '/calendar', host: 'calendar-web', port: 8083 },
  { app: 'contacts', prefix: '/contacts', host: 'contacts-web', port: 8084 },
  { app: 'tasks', prefix: '/tasks', host: 'tasks-web', port: 8085 },
  { app: 'admin', prefix: '/admin', host: 'admin-web', port: 8086 },
  { app: 'drive', prefix: '/drive', host: 'drive-web', port: 8087 },
  { app: 'sites', prefix: '/sites', host: 'sites-web', port: 8088 },
  { app: 'team', prefix: '/team', host: 'team-web', port: 8089 },
] as const;
/** Everything else (home, account, sign-in pages, shared assets) is the portal. */
export const PORTAL = { app: 'portal', host: 'portal-web', port: 8081 } as const;

export const SERVICE_HOSTS: Record<ServiceName, string> = {
  directory: 'directory',
  mail: 'mail-api',
  calendar: 'calendar-api',
  contacts: 'contacts-api',
  tasks: 'tasks-api',
  drive: 'drive-api',
  team: 'team-api',
};

/** Routes outside the services' route tables. */
const EXTRA: Record<string, ServiceName> = {
  '/oidc': 'directory',
  '/oidc/*': 'directory',
  '/interaction/*': 'directory',
  '/socket.io/*': 'directory',
  // ForgeTeam: messages, typing, presence and meeting signalling.
  '/team-socket/*': 'team',
  '/api/docs': 'directory',
  '/api/docs/*': 'directory',
  '/healthz': 'directory',
  '/readyz': 'directory',
};

/** CardDAV lives in the contacts service; the rest of DAV (CalDAV, discovery) in calendar. */
const CONTACTS_DAV = ['/dav/addressbooks', '/dav/addressbooks/*', '/.well-known/carddav'];

/** Fastify route URL → Caddy path pattern (":id" → "*"; a trailing "*" is a prefix match). */
export const toPattern = (url: string) => url.replace(/:[^/]+/g, '*');

/** Caddy path matcher semantics (prefix, suffix, substring, or glob where * stays within a segment). */
export function caddyPathMatch(pattern: string, path: string): boolean {
  const stars = [...pattern].filter((c) => c === '*').length;
  if (!stars) return pattern === path;
  if (stars === 1 && pattern.endsWith('*')) return path.startsWith(pattern.slice(0, -1));
  if (stars === 1 && pattern.startsWith('*')) return path.endsWith(pattern.slice(1));
  if (stars === 2 && pattern.startsWith('*') && pattern.endsWith('*')) return path.includes(pattern.slice(1, -1));
  const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
  return re.test(path);
}

export interface GatewayRule {
  name: string;
  patterns: string[];
  upstream: string;
}

/** Literal characters before the first wildcard. */
const literalPrefix = (p: string) => (p.includes('*') ? p.slice(0, p.indexOf('*')) : p);

/**
 * Ordered rules: the first that matches wins. Patterns are sorted most
 * specific first (exact paths, then longer literal prefixes, then longer
 * patterns), because in Caddy a trailing "*" matches across "/": without
 * this, "/api/v1/admin/users/*" (directory) would capture
 * "/api/v1/admin/users/{id}/aliases" (mail). Neighbouring patterns with the
 * same upstream are merged into one matcher.
 */
export function gatewayRules(routeOwners: Map<string, ServiceName>): GatewayRule[] {
  const owner = new Map<string, ServiceName>();
  for (const [key, service] of routeOwners) owner.set(toPattern(key.slice(key.indexOf(' ') + 1)), service);
  for (const [p, s] of Object.entries(EXTRA)) owner.set(p, s);
  // DAV is registered once (by calendar); CardDAV paths belong to contacts.
  for (const p of CONTACTS_DAV) owner.set(p, 'contacts');

  const entries: { pattern: string; upstream: string; label: string }[] = [...owner].map(([pattern, s]) => ({ pattern, upstream: `${SERVICE_HOSTS[s]}:${SERVICE_PORTS[s]}`, label: s }));
  for (const w of WEB_APPS) for (const pattern of [w.prefix, `${w.prefix}/*`]) entries.push({ pattern, upstream: `${w.host}:${w.port}`, label: `${w.app}_web` });
  entries.sort((a, b) => {
    const exact = Number(a.pattern.includes('*')) - Number(b.pattern.includes('*'));
    if (exact) return exact;
    // Exact paths never overlap one another: group them by service.
    if (!a.pattern.includes('*')) return a.label.localeCompare(b.label) || a.pattern.localeCompare(b.pattern);
    const lp = literalPrefix(b.pattern).length - literalPrefix(a.pattern).length;
    return lp || b.pattern.length - a.pattern.length || a.pattern.localeCompare(b.pattern);
  });

  const rules: GatewayRule[] = [];
  for (const e of entries) {
    const last = rules.at(-1);
    if (last && last.upstream === e.upstream) last.patterns.push(e.pattern);
    else rules.push({ name: `${e.label}_${rules.length + 1}`, patterns: [e.pattern], upstream: e.upstream });
  }
  return rules;
}

/** Which upstream serves a path (for tests). */
export function routeFor(rules: GatewayRule[], path: string): string {
  return rules.find((r) => r.patterns.some((p) => caddyPathMatch(p, path)))?.upstream ?? `${PORTAL.host}:${PORTAL.port}`;
}

export function renderCaddyfile(rules: GatewayRule[]): string {
  const lines = [
    '# GENERATED by apps/api/test/gateway.test.ts from the routes each service registers.',
    '# Regenerate with: UPDATE_GATEWAY=1 pnpm --filter @forge/api test gateway',
    '{',
    '\tadmin off',
    '\tauto_https off',
    '\t# Keep X-Forwarded-Proto/For from a TLS proxy in front (docker compose --profile tls) or another on the private network.',
    '\tservers {',
    '\t\ttrusted_proxies static private_ranges',
    '\t}',
    '}',
    '',
    ':{$GATEWAY_PORT:8080} {',
    '\t# Large uploads (mail attachments, DAV) are limited by each service.',
    '\tlog {',
    '\t\toutput stdout',
    '\t\tformat console',
    '\t\tlevel WARN',
    '\t}',
    '',
  ];
  for (const r of rules) {
    lines.push(`\t@${r.name} path ${r.patterns.join(' ')}`);
    lines.push(`\thandle @${r.name} {`, `\t\treverse_proxy ${r.upstream}`, '\t}', '');
  }
  lines.push('\t# Home, account, sign-in pages and shared assets.', '\thandle {', `\t\treverse_proxy ${PORTAL.host}:${PORTAL.port}`, '\t}', '}', '');
  return lines.join('\n');
}
