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
  for (const [username, displayName, password] of [
    ['alice', 'Alice Manager', 'violet tangerine 77'],
    ['bob', 'Bob Builder', 'orange marmalade 88'],
    ['carol', 'Carol Singer', 'yellow submarine 99'],
  ]) {
    await c.post('/api/v1/admin/users', { username, displayName, password, mustChangePassword: false }, tokens.admin);
    tokens[username!] = (await signIn(new Client(server.baseUrl), login(username!, password!))).tokens.access_token;
  }
}, 120_000);

afterAll(async () => {
  await server?.close();
});

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

interface T {
  id: string;
  uid: string;
  title: string;
  due: string | null;
  status: string;
  role: string | null;
  assignedBy: { email: string; name: string } | null;
  assignee: { email: string; response: string } | null;
}
const all = async (who: string) => (await call('GET', '/api/v1/tasks?view=all', who)).json.items as T[];
const find = (who: string, uid: string, check: (t: T) => boolean = () => true) => waitFor(async () => (await all(who)).find((t) => t.uid === uid && check(t)));
const gone = (who: string, uid: string) => waitFor(async () => !(await all(who)).some((t) => t.uid === uid));
const inboxSubjects = async (who: string) => {
  const inbox = (await call('GET', '/api/v1/mail/mailboxes', who)).json.items.find((b: { specialUse: string }) => b.specialUse === '\\Inbox');
  return ((await call('GET', `/api/v1/mail/threads?mailboxId=${inbox.id}`, who)).json.items as { latest: { subject: string } }[]).map((t) => t.latest.subject);
};

describe('assigning tasks', () => {
  it('assign → accept → assigner edits → assignee completes, with status reports', async () => {
    expect((await call('POST', '/api/v1/tasks', 'alice', { title: 'x', assignTo: 'someone@elsewhere.example' })).status).toBe(400);
    expect((await call('POST', '/api/v1/tasks', 'alice', { title: 'x', assignTo: 'alice@acme.test' })).status).toBe(400);
    expect((await call('POST', '/api/v1/tasks', 'alice', { title: 'x', assignTo: 'bob@acme.test', due: '2026-12-01', repeat: 'weekly' })).status).toBe(400);

    const created = await call('POST', '/api/v1/tasks', 'alice', { title: 'Prepare the Q4 report', notes: 'Use the new template', due: '2026-12-01', importance: 'high', assignTo: 'bob@acme.test' });
    expect(created.status, created.text).toBe(201);
    const uid = created.json.task.uid;
    expect(created.json.task).toMatchObject({ role: 'assigner', assignee: { email: 'bob@acme.test', response: 'NEEDS-ACTION' } });

    // Bob gets a task request email and the task in "Assigned to me".
    const bobs = await waitFor(async () => (await call('GET', '/api/v1/tasks?view=assigned', 'bob')).json.items.find((t: T) => t.uid === uid) as T | undefined);
    expect(bobs).toMatchObject({ title: 'Prepare the Q4 report', due: '2026-12-01', role: 'assignee', assignedBy: { email: 'alice@acme.test', name: 'Alice Manager' }, assignee: { response: 'NEEDS-ACTION' } });
    expect(await inboxSubjects('bob')).toContain('Task request: Prepare the Q4 report');

    // Only Alice changes the details; only Bob reports progress.
    expect((await call('PATCH', `/api/v1/tasks/${bobs.id}`, 'bob', { title: 'Mine now' })).status).toBe(400);
    expect((await call('PATCH', `/api/v1/tasks/${created.json.task.id}`, 'alice', { status: 'COMPLETED' })).status).toBe(400);

    await call('PATCH', `/api/v1/tasks/${bobs.id}`, 'bob', { response: 'ACCEPTED' });
    await find('alice', uid, (t) => t.assignee?.response === 'ACCEPTED');

    await call('PATCH', `/api/v1/tasks/${created.json.task.id}`, 'alice', { due: '2026-12-05' });
    await find('bob', uid, (t) => t.due === '2026-12-05' && t.assignee?.response === 'ACCEPTED');

    await call('PATCH', `/api/v1/tasks/${bobs.id}`, 'bob', { status: 'COMPLETED' });
    await find('alice', uid, (t) => t.status === 'COMPLETED');
    await waitFor(async () => (await inboxSubjects('alice')).includes('Task completed: Prepare the Q4 report'));
  });

  it('reassigning cancels the first assignee’s copy; declining reports back', async () => {
    const created = await call('POST', '/api/v1/tasks', 'alice', { title: 'Book the venue', assignTo: 'bob@acme.test' });
    const uid = created.json.task.uid;
    await find('bob', uid);
    const re = await call('PATCH', `/api/v1/tasks/${created.json.task.id}`, 'alice', { assignTo: 'carol@acme.test' });
    expect(re.status, re.text).toBe(200);
    await gone('bob', uid);
    const carols = await find('carol', uid);
    await call('PATCH', `/api/v1/tasks/${carols.id}`, 'carol', { response: 'DECLINED' });
    await gone('carol', uid);
    await find('alice', uid, (t) => t.assignee?.response === 'DECLINED');
    // Once declined, Alice can finish it herself or take it back.
    const back = await call('PATCH', `/api/v1/tasks/${created.json.task.id}`, 'alice', { assignTo: null });
    expect(back.json.task).toMatchObject({ role: null, assignee: null });
  });

  it('deleting an assigned task cancels it for the assignee', async () => {
    const created = await call('POST', '/api/v1/tasks', 'alice', { title: 'Order chairs', assignTo: 'carol@acme.test' });
    await find('carol', created.json.task.uid);
    await call('DELETE', `/api/v1/tasks/${created.json.task.id}`, 'alice');
    await gone('carol', created.json.task.uid);
  });

  it('progress made in a phone task app reaches the assigner', async () => {
    const created = await call('POST', '/api/v1/tasks', 'alice', { title: 'Renew the domain', assignTo: 'bob@acme.test' });
    const uid = created.json.task.uid;
    const bobs = await find('bob', uid);
    const pw = (await call('POST', '/api/v1/me/app-passwords', 'bob', { name: 'Phone' })).json.password;
    const basic = 'Basic ' + Buffer.from(`bob@acme.test:${pw}`).toString('base64');
    const bobId = (await call('GET', '/api/v1/me', 'bob')).json.user.id;
    const listId = (bobs as T & { listId: string }).listId;
    const path = `/dav/calendars/${bobId}/${listId}/${uid}.ics`;
    const ics = await (await fetch(server.baseUrl + path, { headers: { authorization: basic } })).text();
    expect(ics).toContain('SUMMARY:Renew the domain');
    const done = ics.replace(/STATUS:NEEDS-ACTION/, 'STATUS:COMPLETED\r\nCOMPLETED:20261119T120000Z');
    expect((await fetch(server.baseUrl + path, { method: 'PUT', headers: { authorization: basic, 'content-type': 'text/calendar' }, body: done })).status).toBe(204);
    await find('alice', uid, (t) => t.status === 'COMPLETED' && t.assignee?.response === 'ACCEPTED');
  });
});
