import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PORTAL, SERVICE_HOSTS, WEB_APPS, gatewayRules, renderCaddyfile, routeFor, type GatewayRule } from '../src/gateway';
import { SERVICE_PORTS, type ServiceName } from '../src/services';
import { startServer } from './harness';

const CADDYFILE = fileURLToPath(new URL('../../../docker/gateway/Caddyfile', import.meta.url));

let server: Awaited<ReturnType<typeof startServer>>;
let rules: GatewayRule[];
let owners: Map<string, ServiceName>;

beforeAll(async () => {
  server = await startServer();
  owners = server.app.routeOwners;
  rules = gatewayRules(owners);
}, 120_000);

afterAll(async () => {
  await server?.close();
});

const upstream = (s: ServiceName) => `${SERVICE_HOSTS[s]}:${SERVICE_PORTS[s]}`;
/** A concrete path for a route URL. */
const sample = (url: string) => url.replace(/:[^/]+/g, 'x1').replace(/\*$/, 'a/b');

describe('gateway', () => {
  it('sends every API route to the service that registers it', () => {
    const wrong: string[] = [];
    for (const [key, service] of owners) {
      const url = key.slice(key.indexOf(' ') + 1);
      const expected = url.startsWith('/dav/addressbooks') || url === '/.well-known/carddav' ? upstream('contacts') : upstream(service);
      const got = routeFor(rules, sample(url));
      if (got !== expected) wrong.push(`${key} → ${got} (expected ${expected})`);
    }
    expect(wrong).toEqual([]);
    expect(owners.size).toBeGreaterThan(150);
  });

  it('splits DAV between calendar and contacts, and serves the web apps', () => {
    expect(routeFor(rules, '/dav/calendars/u1/c1/e.ics')).toBe(upstream('calendar'));
    expect(routeFor(rules, '/dav/addressbooks/u1/b1/c.vcf')).toBe(upstream('contacts'));
    expect(routeFor(rules, '/.well-known/caldav')).toBe(upstream('calendar'));
    expect(routeFor(rules, '/oidc/token')).toBe(upstream('directory'));
    expect(routeFor(rules, '/interaction/abc')).toBe(upstream('directory'));
    expect(routeFor(rules, '/socket.io/')).toBe(upstream('directory'));
    for (const w of WEB_APPS) {
      expect(routeFor(rules, w.prefix)).toBe(`${w.host}:${w.port}`);
      expect(routeFor(rules, `${w.prefix}/assets/index-abc.js`)).toBe(`${w.host}:${w.port}`);
    }
    expect(routeFor(rules, '/admin/mail/flow')).toBe('admin-web:8086');
    expect(routeFor(rules, '/api/v1/admin/mail/smarthost')).toBe(upstream('mail'));
    expect(routeFor(rules, '/account')).toBe(`${PORTAL.host}:${PORTAL.port}`);
    expect(routeFor(rules, '/assets/index-abc.js')).toBe(`${PORTAL.host}:${PORTAL.port}`);
  });

  it('matches the checked-in Caddyfile (UPDATE_GATEWAY=1 regenerates it)', async () => {
    const generated = renderCaddyfile(rules);
    if (process.env.UPDATE_GATEWAY === '1') await writeFile(CADDYFILE, generated);
    const current = await readFile(CADDYFILE, 'utf8').catch(() => '');
    expect(current, 'docker/gateway/Caddyfile is out of date: run UPDATE_GATEWAY=1 pnpm --filter @forge/api test gateway').toBe(generated);
  });
});
