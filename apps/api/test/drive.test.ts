import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, signIn, startServer } from './harness';

let server: Awaited<ReturnType<typeof startServer>>;
const tokens: Record<string, string> = {};

const login = (email: string, password: string) => async ({ uid, client }: { uid: string; client: Client }) => client.post(`/interaction/${uid}/login`, { email, password });
async function call(method: string, path: string, who: string, body?: unknown) {
  const res = await fetch(server.baseUrl + path, {
    method,
    headers: { authorization: `Bearer ${tokens[who]}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
}

// A stand-in for the Euro-Office document server: health check and edited files.
const OFFICE_SECRET = 'euro-office-test-secret-0123456789abcdef';
const officeRequests: string[] = [];
let office: Server;
let officeUrl: string;

beforeAll(async () => {
  office = createServer((req, res) => {
    officeRequests.push(req.url ?? '');
    if (req.url === '/healthcheck') return res.end('true');
    if (req.url?.startsWith('/cache/files/')) return res.end('edited in euro-office');
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => office.listen(0, '127.0.0.1', r));
  officeUrl = `http://127.0.0.1:${(office.address() as AddressInfo).port}`;
  server = await startServer({ FORGE_MAIL_DISABLE_AUTH_CHECKS: 'true', FORGE_OFFICE_URL: officeUrl, FORGE_OFFICE_JWT_SECRET: OFFICE_SECRET });
  const c = new Client(server.baseUrl);
  await c.post('/api/v1/setup', {
    setupToken: 'test-setup-token',
    organization: { name: 'Acme', timezone: 'UTC', defaultQuotaBytes: 1024 ** 3, requireMfa: false },
    domain: 'acme.test',
    admin: { username: 'admin', displayName: 'Ada Admin', password: 'correct horse battery staple' },
  });
  tokens.admin = (await signIn(c, login('admin', 'correct horse battery staple'))).tokens.access_token;
  for (const [u, n, pw] of [['alice', 'Alice', 'violet tangerine 77'], ['bob', 'Bob', 'orange marmalade 88']]) {
    await c.post('/api/v1/admin/users', { username: u, displayName: n, password: pw, mustChangePassword: false }, tokens.admin);
    tokens[u!] = (await signIn(new Client(server.baseUrl), login(u!, pw!))).tokens.access_token;
  }
}, 120_000);

afterAll(async () => {
  await server?.close();
  office?.close();
});

const raw = (path: string, headers: Record<string, string> = {}) => fetch(server.baseUrl + path, { headers });
async function upload(who: string, libraryId: string, name: string, data: Buffer, opts: { parentId?: string; itemId?: string; chunk?: number } = {}) {
  const start = await call('POST', '/api/v1/drive/uploads', who, { libraryId, parentId: opts.parentId ?? null, itemId: opts.itemId, name, size: data.length });
  expect(start.status, start.text).toBe(201);
  const chunk = opts.chunk ?? data.length;
  let last: { item: { id: string } | null } = { item: null };
  for (let off = 0; off < data.length || off === 0; off += chunk) {
    const res = await fetch(`${server.baseUrl}/api/v1/drive/uploads/${start.json.upload.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/offset+octet-stream', 'upload-offset': String(off) },
      body: data.subarray(off, off + chunk),
    });
    last = (await res.json()) as typeof last;
    if (data.length === 0) break;
  }
  return last.item!;
}

describe('ForgeDrive over HTTP', () => {
  let lib: string;
  let fileId: string;

  it('uploads in chunks, downloads with Range from a signed URL, keeps versions', async () => {
    const libs = await call('GET', '/api/v1/drive/libraries', 'alice');
    lib = libs.json.items.find((l: { kind: string }) => l.kind === 'personal').id;
    const folder = await call('POST', `/api/v1/drive/libraries/${lib}/folders`, 'alice', { name: 'Reports' });
    expect(folder.status).toBe(201);
    const data = Buffer.from('0123456789'.repeat(1000));
    const item = await upload('alice', lib, 'q3.txt', data, { parentId: folder.json.item.id, chunk: 4096 });
    fileId = item.id;
    const list = await call('GET', `/api/v1/drive/libraries/${lib}/items?parentId=${folder.json.item.id}`, 'alice');
    expect(list.json.items.map((i: { name: string }) => i.name)).toEqual(['q3.txt']);
    expect(list.json.breadcrumbs.map((b: { name: string }) => b.name)).toEqual(['Reports']);

    const { url } = (await call('GET', `/api/v1/drive/items/${fileId}/url`, 'alice')).json;
    const part = await raw(url, { range: 'bytes=10-19' });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 10-19/${data.length}`);
    expect(await part.text()).toBe('0123456789');
    expect((await raw(url.slice(0, -3) + 'abc')).status).toBe(403);

    await upload('alice', lib, 'q3.txt', Buffer.from('second version'), { itemId: fileId });
    const versions = (await call('GET', `/api/v1/drive/items/${fileId}/versions`, 'alice')).json.items;
    expect(versions.map((v: { number: number; current: boolean }) => [v.number, v.current])).toEqual([[2, true], [1, false]]);
  });

  it('shares with people; others cannot see; search respects permissions', async () => {
    const bobId = (await call('GET', '/api/v1/me', 'bob')).json.user.id;
    expect((await call('GET', `/api/v1/drive/items/${fileId}`, 'bob')).status).toBe(404);
    const put = await call('PUT', `/api/v1/drive/items/${fileId}/permissions`, 'alice', { grants: [{ principalType: 'user', principalId: bobId, role: 'viewer' }] });
    expect(put.status, put.text).toBe(200);
    expect((await call('GET', '/api/v1/drive/shared', 'bob')).json.items.map((i: { name: string }) => i.name)).toEqual(['q3.txt']);
    expect((await call('GET', `/api/v1/drive/items/${fileId}`, 'bob')).json.item.role).toBe('viewer');
    expect((await call('PATCH', `/api/v1/drive/items/${fileId}`, 'bob', { name: 'x.txt' })).status).toBe(403);
    expect((await call('GET', '/api/v1/drive/search?q=q3', 'bob')).json.items.map((i: { name: string }) => i.name)).toEqual(['q3.txt']);
    expect((await call('GET', '/api/v1/drive/search?q=q3', 'admin')).json.items).toEqual([]);
  });

  it('external links: password, download limit, revocation', async () => {
    const link = await call('POST', `/api/v1/drive/items/${fileId}/links`, 'alice', { password: 'open sesame', maxDownloads: 1 });
    expect(link.status, link.text).toBe(201);
    const token = link.json.link.url.split('/drive/s/')[1];
    expect((await raw(`/api/v1/share/${token}`).then((r) => r.json())) as object).toEqual({ needsPassword: true });
    expect((await raw(`/api/v1/share/${token}/download`)).status).toBe(401);
    const bad = await fetch(`${server.baseUrl}/api/v1/share/${token}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) });
    expect(bad.status).toBe(401);
    const ok = (await (await fetch(`${server.baseUrl}/api/v1/share/${token}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'open sesame' }) })).json()) as { access: string; item: { name: string } };
    expect(ok.item.name).toBe('q3.txt');
    const dl = await raw(`/api/v1/share/${token}/download?access=${ok.access}`);
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe('second version');
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment/);
    expect((await raw(`/api/v1/share/${token}/download?access=${ok.access}`)).status).toBe(410);
    // Revoked links stop working.
    const second = await call('POST', `/api/v1/drive/items/${fileId}/links`, 'alice', {});
    await call('DELETE', `/api/v1/drive/links/${second.json.link.id}`, 'alice');
    expect((await raw(`/api/v1/share/${second.json.link.url.split('/drive/s/')[1]}`)).status).toBe(404);
    // Organisation policy can switch external sharing off.
    await call('PUT', '/api/v1/admin/drive/settings', 'admin', { trashDays: 30, maxUploadMb: 100, externalSharing: false, linkMaxDays: null });
    expect((await call('POST', `/api/v1/drive/items/${fileId}/links`, 'alice', {})).status).toBe(403);
    await call('PUT', '/api/v1/admin/drive/settings', 'admin', { trashDays: 30, maxUploadMb: 100, externalSharing: true, linkMaxDays: 7 });
  });

  it('recycle bin and check-out', async () => {
    const out = await call('POST', `/api/v1/drive/items/${fileId}/checkout`, 'alice');
    expect(out.json.item.checkedOutBy.name).toBe('Alice');
    await call('POST', `/api/v1/drive/items/${fileId}/checkin`, 'alice', {});
    expect((await call('DELETE', `/api/v1/drive/items/${fileId}`, 'alice')).status).toBe(200);
    const bin = await call('GET', `/api/v1/drive/libraries/${lib}/trash`, 'alice');
    expect(bin.json).toMatchObject({ retentionDays: 30 });
    expect(bin.json.items.map((i: { name: string; deletedBy: string }) => [i.name, i.deletedBy])).toEqual([['q3.txt', 'Alice']]);
    expect((await call('GET', `/api/v1/drive/items/${fileId}`, 'alice')).status).toBe(404);
    expect((await call('POST', `/api/v1/drive/items/${fileId}/restore`, 'alice')).status).toBe(200);
    expect((await call('GET', `/api/v1/drive/items/${fileId}`, 'alice')).status).toBe(200);
  });

  it('WOPI: the Office editor reads, locks and saves the file', async () => {
    const { signToken } = await import('@forge/drive');
    const alice = (await call('GET', '/api/v1/me', 'alice')).json.user.id;
    const token = signToken(server.ctx.keys.shareLinkKey, { p: 'wopi', i: fileId, u: alice, w: 1 }, 3600);
    const info = (await (await raw(`/wopi/files/${fileId}?access_token=${token}`)).json()) as { BaseFileName: string; UserCanWrite: boolean };
    expect(info).toMatchObject({ BaseFileName: 'q3.txt', UserCanWrite: true });
    const wopi = (op: string, lock: string, extra: Record<string, string> = {}) => fetch(`${server.baseUrl}/wopi/files/${fileId}?access_token=${token}`, { method: 'POST', headers: { 'x-wopi-override': op, 'x-wopi-lock': lock, ...extra } });
    expect((await wopi('LOCK', 'L1')).status).toBe(200);
    expect((await wopi('LOCK', 'L2')).status).toBe(409);
    const save = (lock: string) => fetch(`${server.baseUrl}/wopi/files/${fileId}/contents?access_token=${token}`, { method: 'POST', headers: { 'x-wopi-lock': lock, 'content-type': 'application/octet-stream' }, body: Buffer.from('edited in office') });
    expect((await save('wrong')).status).toBe(409);
    expect((await save('L1')).status).toBe(200);
    expect(await (await raw(`/wopi/files/${fileId}/contents?access_token=${token}`)).text()).toBe('edited in office');
    expect((await wopi('UNLOCK', 'L1')).status).toBe(200);
    expect((await raw(`/wopi/files/${fileId}?access_token=nope`)).status).toBe(401);
  });

  it('Euro-Office: new documents, signed editor config, saves from the callback', async () => {
    const { signOfficeJwt, verifyOfficeJwt } = await import('@forge/drive');
    expect((await call('GET', '/api/v1/drive/libraries', 'alice')).json.office).toBe(true);
    const created = await call('POST', `/api/v1/drive/libraries/${lib}/documents`, 'alice', { kind: 'docx', name: 'Plan' });
    expect(created.status, created.text).toBe(201);
    expect(created.json.item).toMatchObject({ name: 'Plan.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const docId = created.json.item.id as string;
    // A real (zip) Word file.
    const url = (await call('GET', `/api/v1/drive/items/${docId}/url`, 'alice')).json.url;
    expect((await (await raw(url)).arrayBuffer()).byteLength).toBeGreaterThan(1000);

    const open = await call('GET', `/api/v1/drive/items/${docId}/office`, 'alice');
    expect(open.status, open.text).toBe(200);
    const { config } = open.json;
    expect(open.json).toMatchObject({ protocol: 'docs', apiUrl: `${officeUrl}/web-apps/apps/api/documents/api.js`, canWrite: true });
    expect(config).toMatchObject({ documentType: 'word', document: { fileType: 'docx', title: 'Plan.docx', permissions: { edit: true } }, editorConfig: { mode: 'edit', user: { name: 'Alice' } } });
    // Signed with the shared secret, covering what the editor is told.
    const signed = verifyOfficeJwt<{ document: { key: string; url: string } }>(OFFICE_SECRET, config.token)!;
    expect(signed.document.key).toBe(config.document.key);
    // The document server can fetch the file from the URL in the config.
    expect(await (await fetch(signed.document.url)).arrayBuffer()).toBeInstanceOf(ArrayBuffer);
    expect((await fetch(signed.document.url)).status).toBe(200);

    // Viewers get a read-only editor.
    const bobId = (await call('GET', '/api/v1/me', 'bob')).json.user.id;
    await call('PUT', `/api/v1/drive/items/${docId}/permissions`, 'alice', { grants: [{ principalType: 'user', principalId: bobId, role: 'viewer' }] });
    const asBob = await call('GET', `/api/v1/drive/items/${docId}/office`, 'bob');
    expect(asBob.json).toMatchObject({ canWrite: false, readOnlyReason: 'permission', config: { editorConfig: { mode: 'view' }, document: { permissions: { edit: false } } } });

    // Saving: the document server posts status 2 with the edited file's URL
    // (named by its public address; drive-api fetches it internally).
    const alice = (await call('GET', '/api/v1/me', 'alice')).json.user.id;
    const callback = new URL(config.editorConfig.callbackUrl).pathname;
    const post = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
      fetch(server.baseUrl + callback, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
    const saved = { key: config.document.key, status: 2, url: 'http://office.example:9980/cache/files/data/abc/output.docx?md5=x&expires=1', filetype: 'docx', users: [alice], actions: [{ type: 0, userid: alice }] };
    expect(await post({ ...saved, token: signOfficeJwt('not-the-secret-but-long-enough-000000', saved) })).toMatchObject({ status: 403, json: { error: 1 } });
    expect(await post({ key: 'x', status: 1, token: signOfficeJwt(OFFICE_SECRET, { key: 'x', status: 1 }) })).toEqual({ status: 200, json: { error: 0 } });
    expect(await post({ ...saved, token: signOfficeJwt(OFFICE_SECRET, saved) })).toEqual({ status: 200, json: { error: 0 } });
    expect(officeRequests).toContain('/cache/files/data/abc/output.docx?md5=x&expires=1');
    const history = await call('GET', `/api/v1/drive/items/${docId}/versions`, 'alice');
    expect(history.json.items[0]).toMatchObject({ number: 2, comment: 'Edited in Euro-Office' });
    const latest = (await call('GET', `/api/v1/drive/items/${docId}/url`, 'alice')).json.url;
    expect(await (await raw(latest)).text()).toBe('edited in euro-office');
    // The token in the Authorization header form works too; a viewer's edits are not saved.
    const asViewer = { ...saved, users: [bobId], actions: [{ type: 0, userid: bobId }] };
    expect((await post(asViewer, { authorization: `Bearer ${signOfficeJwt(OFFICE_SECRET, { payload: asViewer })}` })).status).toBe(403);
    // A new version means a new document key for the next editing session.
    expect((await call('GET', `/api/v1/drive/items/${docId}/office`, 'alice')).json.config.document.key).not.toBe(config.document.key);

    const status = await call('GET', '/api/v1/admin/drive/settings', 'admin');
    expect(status.json.status.office).toMatchObject({ configured: true, ok: true });
  });

  it('sites: create, pages, news, organisation-wide visibility', async () => {
    const site = await call('POST', '/api/v1/sites', 'alice', { name: 'Human Resources', visibility: 'members' });
    expect(site.status, site.text).toBe(201);
    expect(site.json.site.slug).toBe('human-resources');
    const got = await call('GET', '/api/v1/sites/by-slug/human-resources', 'alice');
    expect(got.json.pages.map((p: { slug: string }) => p.slug)).toEqual(['home']);
    expect((await call('GET', '/api/v1/sites/by-slug/human-resources', 'bob')).status).toBe(404);
    const news = await call('POST', `/api/v1/sites/${site.json.site.id}/pages`, 'alice', { title: 'New holiday policy', isNews: true, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Everyone gets an extra day.' }] }] } });
    expect(news.status).toBe(201);
    await call('PATCH', `/api/v1/sites/${site.json.site.id}`, 'alice', { visibility: 'organisation' });
    const feed = await call('GET', '/api/v1/sites/news', 'bob');
    expect(feed.json.items[0]).toMatchObject({ title: 'New holiday policy', excerpt: 'Everyone gets an extra day.', site: { name: 'Human Resources' } });
    expect((await call('GET', '/api/v1/sites/by-slug/human-resources', 'bob')).json.site).toMatchObject({ role: 'viewer', canEdit: false });
    expect((await call('POST', `/api/v1/sites/${site.json.site.id}/pages`, 'bob', { title: 'x' })).status).toBe(403);
    // The site library holds its documents.
    const libId = site.json.site.libraryId;
    await upload('alice', libId, 'handbook.txt', Buffer.from('handbook'));
    expect((await call('GET', `/api/v1/drive/libraries/${libId}/items`, 'bob')).json.items.map((i: { name: string }) => i.name)).toEqual(['handbook.txt']);
  });

  it('site lists: templates, typed values, permissions, column changes', async () => {
    const site = (await call('POST', '/api/v1/sites', 'alice', { name: 'Facilities', visibility: 'organisation' })).json.site;
    const bobId = (await call('GET', '/api/v1/me', 'bob')).json.user.id;
    const created = await call('POST', `/api/v1/sites/${site.id}/lists`, 'alice', { name: 'Office moves', template: 'tasks' });
    expect(created.status, created.text).toBe(201);
    const list = created.json.list;
    expect(list.columns.map((c: { name: string }) => c.name)).toEqual(['Task', 'Status', 'Priority', 'Assigned to', 'Due date', 'Notes']);
    const col = (name: string) => list.columns.find((c: { name: string }) => c.name === name).id as string;
    const base = `/api/v1/sites/${site.id}/lists/${list.id}`;

    const add = (values: Record<string, unknown>, who = 'alice') => call('POST', `${base}/items`, who, { values });
    const ok = await add({ title: 'Move printers', [col('Status')]: 'In progress', [col('Assigned to')]: bobId, [col('Due date')]: '2026-12-01T15:00:00Z', unknown: 'dropped' });
    expect(ok.status, ok.text).toBe(201);
    expect(ok.json.item.values).toEqual({ title: 'Move printers', [col('Status')]: 'In progress', [col('Assigned to')]: bobId, [col('Due date')]: '2026-12-01' });
    expect(ok.json.people[bobId]).toMatchObject({ name: 'Bob' });
    expect((await add({ [col('Status')]: 'In progress' })).json.message).toMatch(/Task is required/);
    expect((await add({ title: 'x', [col('Status')]: 'Done-ish' })).json.message).toMatch(/Status: choose one of/);
    expect((await add({ title: 'x', [col('Assigned to')]: '00000000-0000-4000-8000-000000000000' })).status).toBe(400);
    const second = await add({ title: 'Order desks', [col('Priority')]: 'High' });

    // Everyone in the organisation can read it; only members change it.
    const asBob = await call('GET', base, 'bob');
    expect(asBob.json).toMatchObject({ canEdit: false, list: { itemCount: 2 } });
    expect((await add({ title: 'nope' }, 'bob')).status).toBe(403);
    expect((await call('GET', `/api/v1/sites/by-slug/${site.slug}`, 'bob')).json.lists).toEqual([{ id: list.id, name: 'Office moves' }]);

    // Partial updates keep other columns; clearing a value removes it.
    const upd = await call('PATCH', `${base}/items/${ok.json.item.id}`, 'alice', { values: { [col('Status')]: 'Completed', [col('Due date')]: null } });
    expect(upd.json.item.values).toEqual({ title: 'Move printers', [col('Status')]: 'Completed', [col('Assigned to')]: bobId });

    // Removing the Priority column removes its values; a new column gets an id.
    const columns = list.columns.filter((c: { name: string }) => c.name !== 'Priority').concat([{ name: 'Cost', type: 'number' }]);
    const changed = await call('PATCH', base, 'alice', { name: 'Office move', columns });
    expect(changed.status, changed.text).toBe(200);
    const cost = changed.json.list.columns.find((c: { name: string }) => c.name === 'Cost');
    expect(cost.id).toMatch(/^c[0-9a-f]{8}$/);
    const after = (await call('GET', base, 'alice')).json.items.find((i: { id: string }) => i.id === second.json.item.id);
    expect(after.values).toEqual({ title: 'Order desks' });
    expect((await call('PATCH', base, 'alice', { columns: [{ id: 'title', name: 'Task', type: 'text' }, { name: 'Stage', type: 'choice' }] })).status).toBe(400);

    expect((await call('DELETE', base, 'alice')).status).toBe(200);
    expect((await call('GET', base, 'alice')).status).toBe(404);
  });

  it('the ForgeDrive feature switch', async () => {
    await call('PATCH', '/api/v1/admin/org', 'admin', { features: { drive: false } });
    expect((await call('GET', '/api/v1/drive/libraries', 'alice')).status).toBe(403);
    expect((await call('GET', '/api/v1/sites', 'alice')).status).toBe(403);
    await call('PATCH', '/api/v1/admin/org', 'admin', { features: { drive: true } });
    expect((await call('GET', '/api/v1/drive/libraries', 'alice')).status).toBe(200);
    const admin = await call('GET', '/api/v1/admin/drive/libraries', 'admin');
    expect(admin.json.items.some((l: { kind: string }) => l.kind === 'site')).toBe(true);
  });
});
