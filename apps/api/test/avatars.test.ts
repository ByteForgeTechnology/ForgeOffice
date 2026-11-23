import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { blobs, orm, users } from '@forge/db';
import { Client, signIn, startServer } from './harness';

const { eq } = orm;
let server: Awaited<ReturnType<typeof startServer>>;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};

const login = (email: string, password: string) => async ({ uid, client }: { uid: string; client: Client }) => client.post(`/interaction/${uid}/login`, { email, password });
async function call(method: string, path: string, who: string | null, body?: unknown) {
  const res = await fetch(server.baseUrl + path, {
    method,
    headers: { ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* binary */
  }
  return { status: res.status, json, buf, headers: res.headers };
}

/** A landscape JPEG taken "on its side" (EXIF orientation 6) with GPS data. */
async function photo(color = '#3366cc') {
  const jpeg = await sharp({ create: { width: 1200, height: 800, channels: 3, background: color } })
    .jpeg()
    .withMetadata({ orientation: 6, exif: { IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1' } } })
    .toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}

beforeAll(async () => {
  server = await startServer({ FORGE_MAIL_DISABLE_AUTH_CHECKS: 'true' });
  const c = new Client(server.baseUrl);
  await c.post('/api/v1/setup', {
    setupToken: 'test-setup-token',
    organization: { name: 'Acme', timezone: 'UTC', defaultQuotaBytes: 1024 ** 3, requireMfa: false },
    domain: 'acme.test',
    admin: { username: 'admin', displayName: 'Ada Admin', password: 'correct horse battery staple' },
  });
  tokens.admin = (await signIn(c, login('admin', 'correct horse battery staple'))).tokens.access_token;
  for (const [u, n, pw] of [['alice', 'Alice Able', 'violet tangerine 77'], ['bob', 'Bob Baker', 'orange marmalade 88']]) {
    await c.post('/api/v1/admin/users', { username: u, displayName: n, password: pw, mustChangePassword: false }, tokens.admin);
    tokens[u!] = (await signIn(new Client(server.baseUrl), login(u!, pw!))).tokens.access_token;
    ids[u!] = (await call('GET', '/api/v1/me', u!)).json.user.id;
  }
}, 120_000);

afterAll(async () => {
  await server?.close();
});

describe('profile pictures', () => {
  it('upload your own: square 512 px WebP, upright, without location data; served without a session', async () => {
    expect((await call('GET', '/api/v1/me', 'alice')).json.user.avatarUrl).toBeNull();
    const up = await call('PUT', '/api/v1/me/avatar', 'alice', { dataUrl: await photo() });
    expect(up.status).toBe(200);
    const url = up.json.avatarUrl as string;
    expect(url).toMatch(new RegExp(`^/api/v1/avatars/${ids.alice}\\?v=[0-9a-f]{12}$`));
    expect((await call('GET', '/api/v1/me', 'alice')).json.user.avatarUrl).toBe(url);

    const img = await call('GET', url, null);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/webp');
    expect(img.headers.get('cache-control')).toContain('immutable');
    const meta = await sharp(img.buf).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 512, height: 512 });
    expect(meta.exif).toBeUndefined();
    expect((await call('GET', url, null)).status).toBe(200);
    // Everyone sees it in the directory.
    const found = (await call('GET', '/api/v1/directory/search?q=Alice', 'bob')).json.people[0];
    expect(found.avatarUrl).toBe(url);
  });

  it('replacing and removing keep storage tidy', async () => {
    const first = (await call('GET', '/api/v1/me', 'alice')).json.user.avatarUrl;
    const second = (await call('PUT', '/api/v1/me/avatar', 'alice', { dataUrl: await photo('#cc3333') })).json.avatarUrl;
    expect(second).not.toBe(first);
    // The same picture again: still one reference.
    await call('PUT', '/api/v1/me/avatar', 'alice', { dataUrl: await photo('#cc3333') });
    const sha = (await server.ctx.db.select({ sha: users.avatarSha }).from(users).where(eq(users.id, ids.alice!)))[0]!.sha!;
    const [row] = await server.ctx.db.select().from(blobs).where(eq(blobs.sha256, sha));
    expect(row?.refCount).toBe(1);

    expect((await call('DELETE', '/api/v1/me/avatar', 'alice')).json.avatarUrl).toBeNull();
    expect((await call('GET', `/api/v1/avatars/${ids.alice}`, null)).status).toBe(404);
    expect((await server.ctx.db.select().from(blobs).where(eq(blobs.sha256, sha))).length).toBe(0);
  });

  it('admins set and remove other people’s pictures; others can’t; only pictures are accepted', async () => {
    const set = await call('PUT', `/api/v1/admin/users/${ids.bob}/avatar`, 'admin', { dataUrl: await photo('#22aa55') });
    expect(set.status).toBe(200);
    expect((await call('GET', `/api/v1/admin/users/${ids.bob}`, 'admin')).json.user.avatarUrl).toBe(set.json.avatarUrl);
    expect((await call('PUT', `/api/v1/admin/users/${ids.alice}/avatar`, 'bob', { dataUrl: await photo() })).status).toBe(403);
    expect((await call('PUT', '/api/v1/me/avatar', 'alice', { dataUrl: 'data:image/png;base64,bm90IGFuIGltYWdl' })).json.message).toMatch(/isn’t a picture/);
    expect((await call('PUT', '/api/v1/me/avatar', 'alice', { dataUrl: 'data:text/html;base64,PGI+aGk8L2I+' })).status).toBe(400);
    expect((await call('DELETE', `/api/v1/admin/users/${ids.bob}/avatar`, 'admin')).status).toBe(200);
    expect((await call('GET', `/api/v1/avatars/${ids.bob}`, null)).status).toBe(404);
  });
});
