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
  await c.post('/api/v1/admin/users', { username: 'helen', displayName: 'Helen', password: 'violet tangerine 77', mustChangePassword: false }, tokens.admin);
  tokens.helen = (await signIn(new Client(server.baseUrl), login('helen', 'violet tangerine 77'))).tokens.access_token;
  await call('PATCH', '/api/v1/admin/org', 'admin', { undoSendSeconds: 0 });
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

async function inboxMessage(who: string, subject: string) {
  const inbox = (await call('GET', '/api/v1/mail/mailboxes', who)).json.items.find((b: { specialUse: string }) => b.specialUse === '\\Inbox');
  return waitFor(async () => {
    const threads = (await call('GET', `/api/v1/mail/threads?mailboxId=${inbox.id}`, who)).json.items as { threadId: string; messageIds: string[]; latest: { subject: string } }[];
    const t = threads.find((x) => x.latest.subject === subject);
    return t ? { id: t.messageIds[0]!, threadId: t.threadId, mailboxId: inbox.id as string } : null;
  });
}
const flagOf = async (who: string, threadId: string) => (await call('GET', `/api/v1/mail/threads/${threadId}`, who)).json.messages.at(-1).flagged as boolean;

describe('tasks', () => {
  let flaggedList: string;
  let defaultList: string;

  it('every person has Tasks and Flagged email lists, kept out of the calendar', async () => {
    const lists = (await call('GET', '/api/v1/tasks/lists', 'helen')).json.items;
    expect(lists.map((l: { name: string }) => l.name)).toEqual(['Tasks', 'Flagged email']);
    defaultList = lists[0].id;
    flaggedList = lists[1].id;
    const cals = (await call('GET', '/api/v1/calendar/calendars', 'helen')).json.items.map((c: { name: string }) => c.name);
    expect(cals).not.toContain('Tasks');
    expect(cals).not.toContain('Flagged email');
    expect((await call('DELETE', `/api/v1/tasks/lists/${flaggedList}`, 'helen')).status).toBe(400);
    expect((await call('DELETE', `/api/v1/tasks/lists/${defaultList}`, 'helen')).status).toBe(400);
  });

  it('flagging an email creates a task; unflagging completes it; completing the task unflags the email', async () => {
    await call('POST', '/api/v1/mail/send', 'helen', { to: [{ address: 'helen@acme.test' }], subject: 'Follow up with Acme', html: '<p>Call them</p>' });
    const m = await inboxMessage('helen', 'Follow up with Acme');
    await call('POST', '/api/v1/mail/messages/actions', 'helen', { ids: [m.id], action: 'flag' });

    let tasks = (await call('GET', `/api/v1/tasks?listId=${flaggedList}`, 'helen')).json.items;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: 'Follow up with Acme', status: 'NEEDS-ACTION', messageId: m.id, message: { mailboxId: m.mailboxId, threadId: m.threadId } });
    expect((await call('GET', `/api/v1/mail/messages/${m.id}/location`, 'helen')).json).toMatchObject({ mailboxId: m.mailboxId, threadId: m.threadId });
    expect((await call('GET', `/api/v1/mail/messages/${m.id}/location`, 'admin')).status).toBe(404);

    await call('POST', '/api/v1/mail/messages/actions', 'helen', { ids: [m.id], action: 'unflag' });
    tasks = (await call('GET', `/api/v1/tasks?listId=${flaggedList}`, 'helen')).json.items;
    expect(tasks[0].status).toBe('COMPLETED');

    await call('POST', '/api/v1/mail/messages/actions', 'helen', { ids: [m.id], action: 'flag' });
    expect((await call('GET', `/api/v1/tasks?listId=${flaggedList}`, 'helen')).json.items[0].status).toBe('NEEDS-ACTION');
    const done = await call('PATCH', `/api/v1/tasks/${tasks[0].id}`, 'helen', { status: 'COMPLETED' });
    expect(done.status, done.text).toBe(200);
    expect(await flagOf('helen', m.threadId)).toBe(false);
    await call('PATCH', `/api/v1/tasks/${tasks[0].id}`, 'helen', { status: 'NEEDS-ACTION' });
    expect(await flagOf('helen', m.threadId)).toBe(true);
    expect((await call('PATCH', `/api/v1/tasks/${tasks[0].id}`, 'helen', { listId: defaultList })).status).toBe(400);

    // Deleting the task clears the flag.
    await call('DELETE', `/api/v1/tasks/${tasks[0].id}`, 'helen');
    expect(await flagOf('helen', m.threadId)).toBe(false);
  });

  it('a phone completing the task over CalDAV unflags the email', async () => {
    await call('POST', '/api/v1/mail/send', 'helen', { to: [{ address: 'helen@acme.test' }], subject: 'Sign the lease', html: '<p>x</p>' });
    const m = await inboxMessage('helen', 'Sign the lease');
    await call('POST', '/api/v1/mail/messages/actions', 'helen', { ids: [m.id], action: 'flag' });
    const pw = (await call('POST', '/api/v1/me/app-passwords', 'helen', { name: 'Phone' })).json.password;
    const basic = 'Basic ' + Buffer.from(`helen@acme.test:${pw}`).toString('base64');
    const dav = (method: string, path: string, body?: string, headers: Record<string, string> = {}) => fetch(`${server.baseUrl}${path}`, { method, headers: { authorization: basic, ...headers }, body });

    const me = (await call('GET', '/api/v1/me', 'helen')).json.user.id;
    const list = await dav('PROPFIND', `/dav/calendars/${me}/${flaggedList}/`, '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:supported-calendar-component-set/></d:prop></d:propfind>', { depth: '0', 'content-type': 'application/xml' });
    const listXml = await list.text();
    expect(listXml).toContain('VTODO');
    expect(listXml).not.toContain('VEVENT');
    const href = `forge-flag-${m.id}.ics`;
    const ics = await (await dav('GET', `/dav/calendars/${me}/${flaggedList}/${href}`)).text();
    expect(ics).toContain('SUMMARY:Sign the lease');
    const completed = ics.replace('STATUS:NEEDS-ACTION', 'STATUS:COMPLETED\r\nCOMPLETED:20261119T100000Z');
    expect((await dav('PUT', `/dav/calendars/${me}/${flaggedList}/${href}`, completed, { 'content-type': 'text/calendar' })).status).toBe(204);
    expect(await flagOf('helen', m.threadId)).toBe(false);
  });

  it('ordinary tasks: create, views, repeat and lists', async () => {
    const created = await call('POST', '/api/v1/tasks', 'helen', { title: 'Submit timesheet', due: '2026-11-20', importance: 'high', repeat: 'weekly', reminder: '2026-11-20T09:00:00.000Z' });
    expect(created.status, created.text).toBe(201);
    expect(created.json.task).toMatchObject({ listId: defaultList, title: 'Submit timesheet', importance: 'high', repeat: 'weekly' });
    expect((await call('POST', '/api/v1/tasks', 'helen', { title: 'x', repeat: 'daily' })).status).toBe(400);
    expect((await call('POST', '/api/v1/tasks', 'helen', { title: 'x', listId: flaggedList })).status).toBe(400);
    expect((await call('GET', '/api/v1/tasks?view=important', 'helen')).json.items.map((t: { title: string }) => t.title)).toEqual(['Submit timesheet']);

    // Completing a repeating task creates the next one.
    const done = await call('PATCH', `/api/v1/tasks/${created.json.task.id}`, 'helen', { status: 'COMPLETED' });
    expect(done.status, done.text).toBe(200);
    expect(done.json.task).toMatchObject({ status: 'COMPLETED', repeat: null });
    expect(done.json.next).toMatchObject({ title: 'Submit timesheet', due: '2026-11-27', repeat: 'weekly', status: 'NEEDS-ACTION', reminder: '2026-11-27T09:00:00.000Z' });

    // Custom lists; tasks can move between them.
    const list = await call('POST', '/api/v1/tasks/lists', 'helen', { name: 'House' });
    expect(list.status).toBe(201);
    const moved = await call('PATCH', `/api/v1/tasks/${done.json.next.id}`, 'helen', { listId: list.json.list.id });
    expect(moved.json.task.listId).toBe(list.json.list.id);
    expect((await call('GET', '/api/v1/tasks?view=planned', 'helen')).json.items.length).toBe(2);
    // Other people can't see them.
    expect((await call('GET', `/api/v1/tasks?listId=${list.json.list.id}`, 'admin')).status).toBe(404);
    expect((await call('DELETE', `/api/v1/tasks/lists/${list.json.list.id}`, 'helen')).status).toBe(200);
  });
});
