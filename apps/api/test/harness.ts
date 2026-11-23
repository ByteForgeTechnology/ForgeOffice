import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { bootstrap } from '../src/bootstrap';
import { loadConfig } from '../src/config';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export async function startServer(env: Record<string, string> = {}) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'forge-test-'));
  const port = await freePort();
  const config = loadConfig({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(port),
    FORGE_PUBLIC_URL: `http://127.0.0.1:${port}`,
    FORGE_DATA_ROOT: dataRoot,
    DATABASE_URL: 'pglite://memory',
    FORGE_SETUP_TOKEN: 'test-setup-token',
    ...env,
  });
  const logger = pino({ level: process.env.TEST_LOG ?? 'silent' });
  const server = await bootstrap(config, logger);
  await server.start();
  return {
    ...server,
    baseUrl: config.publicUrl,
    dataRoot,
    async close() {
      await server.stop();
      await rm(dataRoot, { recursive: true, force: true });
    },
  };
}

/** Tiny cookie jar honouring cookie paths, enough to drive the OIDC flow. */
export class CookieJar {
  private cookies = new Map<string, { value: string; path: string }>();

  store(res: Response) {
    for (const header of res.headers.getSetCookie()) {
      const [pair, ...attrs] = header.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      const path = attrs.map((a) => a.trim()).find((a) => a.toLowerCase().startsWith('path='))?.slice(5) ?? '/';
      const expired = attrs.some((a) => /expires=thu, 01 jan 1970/i.test(a.trim()));
      const key = `${name};${path}`;
      if (expired || value === '') this.cookies.delete(key);
      else this.cookies.set(key, { value, path });
    }
  }

  header(url: string): string {
    const { pathname } = new URL(url);
    return [...this.cookies.entries()]
      .filter(([, c]) => pathname === c.path || pathname.startsWith(c.path.endsWith('/') ? c.path : c.path + '/') || c.path === '/')
      .map(([k, c]) => `${k.split(';')[0]}=${c.value}`)
      .join('; ');
  }
}

export class Client {
  jar = new CookieJar();
  constructor(readonly baseUrl: string) {}

  async request(method: string, path: string, opts: { body?: unknown; token?: string; form?: Record<string, string> } = {}) {
    const url = path.startsWith('http') ? path : this.baseUrl + path;
    const headers: Record<string, string> = { cookie: this.jar.header(url) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let body: string | undefined;
    if (opts.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(opts.form).toString();
    } else if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, { method, headers, body, redirect: 'manual' });
    this.jar.store(res);
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, headers: res.headers, json, text };
  }

  get = (path: string, token?: string) => this.request('GET', path, { token });
  post = (path: string, body?: unknown, token?: string) => this.request('POST', path, { body: body ?? {}, token });
}

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export interface Tokens {
  access_token: string;
  refresh_token?: string;
  id_token: string;
  expires_in: number;
  scope: string;
}

/**
 * Drive the browser side of an authorization-code + PKCE sign-in.
 * `steps` answers each interaction step (login → mfa → ...).
 */
export async function signIn(
  client: Client,
  steps: (stage: { uid: string; response: any; client: Client }) => Promise<any>,
): Promise<{ tokens: Tokens; stepResponses: any[] }> {
  const redirectUri = `${client.baseUrl}/auth/callback`;
  const { verifier, challenge } = pkce();
  const params = new URLSearchParams({
    client_id: 'forge-web',
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'openid profile email offline_access forge api',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: randomBytes(8).toString('hex'),
    nonce: randomBytes(8).toString('hex'),
    prompt: 'consent',
  });
  let res = await client.get(`/oidc/auth?${params}`);
  const stepResponses: any[] = [];
  for (let hops = 0; hops < 15; hops++) {
    if (res.status === 200 && res.json?.redirectTo) {
      res = await client.get(res.json.redirectTo);
      continue;
    }
    if (res.status < 300 || res.status >= 400) throw new Error(`unexpected ${res.status}: ${res.text.slice(0, 500)}`);
    const location = new URL(res.headers.get('location')!, client.baseUrl).toString();
    if (location.startsWith(redirectUri)) {
      const code = new URL(location).searchParams.get('code');
      if (!code) throw new Error(`no code in callback: ${location}`);
      const token = await client.request('POST', '/oidc/token', {
        form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: 'forge-web', code_verifier: verifier },
      });
      if (token.status !== 200) throw new Error(`token exchange failed: ${token.text}`);
      return { tokens: token.json, stepResponses };
    }
    const m = /\/interaction\/([^/?]+)$/.exec(new URL(location).pathname);
    if (m) {
      const page = await client.get(location);
      if (page.status >= 300 && page.status < 400) {
        res = page; // auto-consent redirect
        continue;
      }
      let response = await client.get(`/interaction/${m[1]}/details`);
      // Let the test answer as many steps as it needs, then follow redirectTo.
      for (;;) {
        response = await steps({ uid: m[1]!, response, client });
        stepResponses.push(response.json);
        if (response.json?.redirectTo) break;
        if (response.status >= 400) throw new Error(`step failed ${response.status}: ${response.text}`);
      }
      res = response;
      continue;
    }
    res = await client.get(location);
  }
  throw new Error('too many redirects');
}
