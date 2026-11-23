import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blobReplicas, orm, syncSharedFiles, SecretMismatchError } from '@forge/db';
import { mailStoreToken } from '@forge/mail';
import { createStoreNode, type StoreNode } from '@forge/storage';
import { Client, signIn, startServer } from './harness';

const SECRET = 'cluster-test-secret-0123456789abcdefghijklmnop';
const { eq } = orm;
let server: Awaited<ReturnType<typeof startServer>>;
let dir: string;
const nodes: StoreNode[] = [];
const urls: string[] = [];
const tokens: Record<string, string> = {};

const login = (email: string, password: string) => async ({ uid, client }: { uid: string; client: Client }) => client.post(`/interaction/${uid}/login`, { email, password });
async function call(method: string, path: string, who: string | null, body?: unknown, raw?: Buffer, headers: Record<string, string> = {}) {
  const res = await fetch(server.baseUrl + path, {
    method,
    headers: { ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try {
    json = JSON.parse(buf.toString());
  } catch {
    /* binary */
  }
  return { status: res.status, json, buf };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-cluster-'));
  for (let i = 0; i < 2; i++) {
    const root = join(dir, `node${i}`);
    const node = await createStoreNode({
      token: mailStoreToken(SECRET),
      idFile: join(root, 'id'),
      namespaces: { mail: { blobs: join(root, 'mail') }, drive: { blobs: join(root, 'drive', 'blobs'), objects: { root: join(root, 'drive', '.previews'), suffix: '.webp' }, uploads: join(root, 'drive', '.uploads') }, team: { blobs: join(root, 'team') } },
    });
    await new Promise<void>((r) => node.server.listen(0, '127.0.0.1', r));
    nodes.push(node);
    urls.push(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`);
  }
  server = await startServer({ FORGE_SECRET: SECRET, FORGE_STORE_NODES: urls.join(','), FORGE_MAIL_DISABLE_AUTH_CHECKS: 'true' });
  const c = new Client(server.baseUrl);
  await c.post('/api/v1/setup', {
    setupToken: 'test-setup-token',
    organization: { name: 'Acme', timezone: 'UTC', defaultQuotaBytes: 1024 ** 3, requireMfa: false },
    domain: 'acme.test',
    admin: { username: 'admin', displayName: 'Ada Admin', password: 'correct horse battery staple' },
  });
  tokens.admin = (await signIn(c, login('admin', 'correct horse battery staple'))).tokens.access_token;
}, 120_000);

afterAll(async () => {
  await server?.close();
  for (const n of nodes) n.server.close();
  await rm(dir, { recursive: true, force: true });
});

describe('several machines: storage nodes and shared keys', () => {
  it('Drive uploads go to the storage nodes, with a copy on each', async () => {
    expect(server.ctx.storage.mode).toBe('cluster');
    const lib = (await call('GET', '/api/v1/drive/libraries', 'admin')).json.items.find((l: { mine: boolean }) => l.mine).id;
    const data = Buffer.from('x'.repeat(5000) + 'the end');
    const start = await call('POST', '/api/v1/drive/uploads', 'admin', { libraryId: lib, parentId: null, name: 'report.txt', size: data.length });
    const id = start.json.upload.id;
    // Two chunks: either drive-api instance could take each one.
    const patch = (off: number, part: Buffer) => call('PATCH', `/api/v1/drive/uploads/${id}`, 'admin', undefined, part, { 'content-type': 'application/offset+octet-stream', 'upload-offset': String(off) });
    expect((await patch(0, data.subarray(0, 3000))).json.received).toBe(3000);
    expect((await call('GET', `/api/v1/drive/uploads/${id}`, 'admin')).json.upload.received).toBe(3000);
    const done = await patch(3000, data.subarray(3000));
    expect(done.status).toBe(200);
    const item = done.json.item;
    const sha = (await server.ctx.db.select().from(blobReplicas).where(eq(blobReplicas.namespace, 'drive'))).map((r) => r.sha256);
    const rows = await server.ctx.db.select().from(blobReplicas).where(eq(blobReplicas.sha256, sha[0]!));
    expect(new Set(rows.map((r) => r.nodeId))).toEqual(new Set(nodes.map((n) => n.id)));
    const url = (await call('GET', `/api/v1/drive/items/${item.id}/url`, 'admin')).json.url;
    expect((await call('GET', url, null)).buf.toString().endsWith('the end')).toBe(true);
    // Range reads come from the nodes too.
    expect((await call('GET', url, null, undefined, undefined, { range: 'bytes=5000-5006' })).buf.toString()).toBe('the end');

    const cluster = (await call('GET', '/api/v1/admin/system/cluster', 'admin')).json;
    expect(cluster.storage).toMatchObject({ mode: 'cluster', replicas: 2, underReplicated: 0 });
    expect(cluster.storage.nodes.map((n: { online: boolean }) => n.online)).toEqual([true, true]);
  });

  it('pictures too; and files stay readable with a node down', async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#336699' } }).png().toBuffer();
    const set = await call('PUT', '/api/v1/me/avatar', 'admin', { dataUrl: `data:image/png;base64,${png.toString('base64')}` });
    expect(set.status).toBe(200);
    // Stop one node: everything has a copy on the other.
    await new Promise((r) => nodes[0]!.server.close(r));
    nodes[0]!.server.closeAllConnections?.();
    await new Promise((r) => setTimeout(r, 11_000)); // the fixed node list is re-checked every 10 s
    const img = await call('GET', set.json.avatarUrl, null);
    expect(img.status).toBe(200);
    expect((await sharp(img.buf).metadata()).width).toBe(512);
  }, 30_000);

  it('keys and certificates are shared through the database; a different secret is refused', async () => {
    const other = await mkdtemp(join(tmpdir(), 'forge-machine2-'));
    try {
      // A second machine with an empty certs volume gets the same signing keys.
      const written = await syncSharedFiles(server.ctx.db, SECRET, other);
      expect(written).toContain('oidc/jwks.json');
      expect(await readFile(join(other, 'oidc', 'jwks.json'), 'utf8')).toBe(await readFile(join(server.dataRoot, 'certs', 'oidc', 'jwks.json'), 'utf8'));
      // The setup token was used: it's gone everywhere.
      await expect(readFile(join(other, 'setup-token'))).rejects.toThrow();
      await expect(syncSharedFiles(server.ctx.db, 'another-secret-entirely-0123456789abcdef', other)).rejects.toBeInstanceOf(SecretMismatchError);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('says why other servers cannot join an install with a built-in database, and gives no code', async () => {
    const r = await call('GET', '/api/v1/admin/system/cluster', 'admin');
    expect(r.json.join).toMatchObject({ available: false, reason: expect.stringContaining('built-in database') });
    expect((await call('POST', '/api/v1/admin/system/join-code', 'admin')).status).toBe(409);
    expect((await call('POST', '/api/v1/admin/system/join-code', null)).status).toBe(401);
  });
});
