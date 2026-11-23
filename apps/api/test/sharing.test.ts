import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, signIn, startServer } from './harness';

let server: Awaited<ReturnType<typeof startServer>>;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
const passwords: Record<string, string> = {};

const login = (email: string, password: string) => async ({ uid, client }: { uid: string; client: Client }) => client.post(`/interaction/${uid}/login`, { email, password });
const c = () => new Client(server.baseUrl);

async function call(method: string, path: string, who: string, opts: { mailbox?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {}) {
  const res = await fetch(server.baseUrl + path, {
    method,
    headers: {
      ...(who.startsWith('Basic ') ? { authorization: who } : { authorization: `Bearer ${tokens[who]}` }),
      ...(opts.mailbox ? { 'x-forge-mailbox': opts.mailbox } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    },
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text, headers: res.headers };
}
const get = (who: string, path: string, mailbox?: string) => call('GET', path, who, { mailbox });
const post = (who: string, path: string, body: unknown, mailbox?: string) => call('POST', path, who, { body, mailbox });
const put = (who: string, path: string, body: unknown, mailbox?: string) => call('PUT', path, who, { body, mailbox });

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  server = await startServer({ FORGE_MAIL_DISABLE_AUTH_CHECKS: 'true' });
  await c().post('/api/v1/setup', {
    setupToken: 'test-setup-token',
    organization: { name: 'Acme', timezone: 'UTC', defaultQuotaBytes: 1024 ** 3, requireMfa: false },
    domain: 'acme.test',
    admin: { username: 'admin', displayName: 'Ada Admin', password: 'correct horse battery staple' },
  });
  tokens.admin = (await signIn(c(), login('admin', 'correct horse battery staple'))).tokens.access_token;
  await c().request('PATCH', '/api/v1/admin/org', { body: { undoSendSeconds: 0 }, token: tokens.admin });
  for (const name of ['alice', 'bob', 'carol']) {
    passwords[name] = `orange giraffe number ${name.length}${name.charCodeAt(0)}`;
    const res = await c().post('/api/v1/admin/users', { username: name, displayName: name[0]!.toUpperCase() + name.slice(1), password: passwords[name], mustChangePassword: false }, tokens.admin);
    ids[name] = res.json.user.id;
    tokens[name] = (await signIn(c(), login(name, passwords[name]!))).tokens.access_token;
  }
}, 120_000);

afterAll(async () => {
  await server?.close();
});

describe('sharing a single mail folder', () => {
  let projects: string;
  let thread: { threadId: string; messageIds: string[] };

  it('is set up by the owner with per-person access', async () => {
    const folder = await post('alice', '/api/v1/mail/mailboxes', { path: 'Projects' });
    projects = folder.json.mailbox.id;
    await post('bob', '/api/v1/mail/send', { to: [{ address: 'alice@acme.test' }], subject: 'Project Apollo', html: '<p>Kick-off notes</p>' });
    const inboxThread = await waitFor(async () => {
      const boxes = (await get('alice', '/api/v1/mail/mailboxes')).json.items;
      const inbox = boxes.find((b: { specialUse: string }) => b.specialUse === '\\Inbox');
      return (await get('alice', `/api/v1/mail/threads?mailboxId=${inbox.id}`)).json.items[0];
    });
    await post('alice', '/api/v1/mail/messages/actions', { ids: inboxThread.messageIds, action: 'move', mailboxId: projects });
    const shared = await put('alice', `/api/v1/mail/mailboxes/${projects}/shares`, {
      grants: [
        { principalType: 'user', principalId: ids.bob, access: 'read' },
        { principalType: 'user', principalId: ids.carol, access: 'write' },
      ],
    });
    expect(shared.status, shared.text).toBe(200);
    expect(shared.json.items.map((g: { name: string; access: string }) => `${g.name}:${g.access}`)).toEqual(['Bob:read', 'Carol:write']);
    // Only the owner (or whole-mailbox full access) manages shares.
    expect((await put('bob', `/api/v1/mail/mailboxes/${projects}/shares`, { grants: [] }, ids.alice)).status).toBe(404);
  });

  it('shows only the shared folder to the people it is shared with', async () => {
    const accounts = (await get('bob', '/api/v1/mail/accounts')).json.items;
    expect(accounts.find((a: { id: string }) => a.id === ids.alice)).toMatchObject({ access: 'folders', name: 'Alice' });
    const boxes = (await get('bob', '/api/v1/mail/mailboxes', ids.alice)).json.items;
    expect(boxes.map((b: { name: string; access: string }) => `${b.name}:${b.access}`)).toEqual(['Projects:read']);
    const threads = (await get('bob', `/api/v1/mail/threads?mailboxId=${projects}`, ids.alice)).json.items;
    thread = threads[0];
    expect(threads[0].latest.subject).toBe('Project Apollo');
    expect((await get('bob', `/api/v1/mail/threads/${thread.threadId}`, ids.alice)).json.messages).toHaveLength(1);
    expect((await get('admin', '/api/v1/mail/mailboxes', ids.alice)).status).toBe(404);
  });

  it('enforces read / write / full', async () => {
    expect((await post('bob', '/api/v1/mail/messages/actions', { ids: thread.messageIds, action: 'flag' }, ids.alice)).status).toBe(403);
    expect((await post('carol', '/api/v1/mail/messages/actions', { ids: thread.messageIds, action: 'flag' }, ids.alice)).status).toBe(200);
    expect((await post('carol', '/api/v1/mail/messages/actions', { ids: thread.messageIds, action: 'delete' }, ids.alice)).status).toBe(403);
    // Filing out of the shared folder needs write on the destination too (Alice's Inbox isn't shared).
    expect((await post('carol', '/api/v1/mail/messages/actions', { ids: thread.messageIds, action: 'restore' }, ids.alice)).status).toBe(404);
    await put('alice', `/api/v1/mail/mailboxes/${projects}/shares`, { grants: [{ principalType: 'user', principalId: ids.carol, access: 'full' }] });
    expect((await get('bob', '/api/v1/mail/mailboxes', ids.alice)).status).toBe(404);
    expect((await post('carol', '/api/v1/mail/messages/actions', { ids: thread.messageIds, action: 'delete' }, ids.alice)).status).toBe(200);
    const left = (await get('alice', `/api/v1/mail/threads?mailboxId=${projects}`)).json.items;
    expect(left).toHaveLength(0);
  });
});

describe('free/busy respects calendar access', () => {
  it('shows titles only to people who can read the calendar', async () => {
    const cal = (await get('alice', '/api/v1/calendar/calendars')).json.items[0];
    await post('alice', '/api/v1/calendar/events', { calendarId: cal.id, summary: 'Secret plans', location: 'Bunker', start: '2033-01-10T10:00:00.000Z', end: '2033-01-10T11:00:00.000Z' });
    const query = { emails: ['alice@acme.test'], from: '2033-01-10T00:00:00Z', to: '2033-01-11T00:00:00Z' };
    const before = (await post('bob', '/api/v1/calendar/freebusy', query)).json.busy['alice@acme.test'];
    expect(before).toEqual([{ start: '2033-01-10T10:00:00.000Z', end: '2033-01-10T11:00:00.000Z', status: 'busy' }]);
    await put('alice', `/api/v1/calendar/calendars/${cal.id}/shares`, { shares: [{ principalType: 'user', principalId: ids.bob, access: 'read' }] });
    const after = (await post('bob', '/api/v1/calendar/freebusy', query)).json.busy['alice@acme.test'];
    expect(after[0]).toMatchObject({ summary: 'Secret plans', location: 'Bunker' });
    expect((await post('carol', '/api/v1/calendar/freebusy', query)).json.busy['alice@acme.test'][0].summary).toBeUndefined();
  });

  it('applies to shared mailboxes through their member grants', async () => {
    const mb = await post('admin', '/api/v1/admin/shared-mailboxes', {
      displayName: 'Support',
      username: 'support',
      grants: [{ principalType: 'user', principalId: ids.carol, access: 'full', sendAs: true, sendOnBehalf: false }],
    });
    ids.support = mb.json.mailbox.id;
    const supportCal = (await get('carol', '/api/v1/calendar/calendars')).json.items.find((x: { ownerEmail: string }) => x.ownerEmail === 'support@acme.test');
    await post('carol', '/api/v1/calendar/events', { calendarId: supportCal.id, summary: 'On-call rota', start: '2033-01-12T09:00:00.000Z', end: '2033-01-12T17:00:00.000Z' });
    const query = { emails: ['support@acme.test'], from: '2033-01-12T00:00:00Z', to: '2033-01-13T00:00:00Z' };
    expect((await post('carol', '/api/v1/calendar/freebusy', query)).json.busy['support@acme.test'][0].summary).toBe('On-call rota');
    expect((await post('bob', '/api/v1/calendar/freebusy', query)).json.busy['support@acme.test'][0].summary).toBeUndefined();
  });
});

describe('per-person reminders', () => {
  let basic: string;
  let calHref: string;
  let eventHref: string;

  it('are off by default for shared calendars and on for your own', async () => {
    const cals = (await get('carol', '/api/v1/calendar/calendars')).json.items;
    expect(cals.find((x: { owner: string | null }) => !x.owner).reminders).toBe(true);
    const support = cals.find((x: { ownerEmail: string }) => x.ownerEmail === 'support@acme.test');
    expect(support.reminders).toBe(false);
    const created = await post('carol', '/api/v1/calendar/events', { calendarId: support.id, summary: 'Standby', start: '2033-02-01T09:00:00.000Z', end: '2033-02-01T10:00:00.000Z', reminderMinutes: 15 });
    expect(created.status).toBe(201);
    const pw = (await post('carol', '/api/v1/me/app-passwords', { name: 'Phone' })).json.password;
    basic = 'Basic ' + Buffer.from(`carol@acme.test:${pw}`).toString('base64');
    calHref = `/dav/calendars/${ids.carol}/${support.id}/`;
    const list = await call('PROPFIND', calHref, basic, { headers: { depth: '1', 'content-type': 'application/xml' }, raw: '<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>' });
    const hrefs = [...list.text.matchAll(/<d:href>([^<]+\.ics)<\/d:href>/g)].map((m) => m[1]!);
    for (const h of hrefs) if ((await call('GET', h, basic)).text.includes('SUMMARY:Standby')) eventHref = h;
    const ics = await call('GET', eventHref, basic);
    expect(ics.text).not.toContain('BEGIN:VALARM');
    expect(ics.headers.get('etag')).toMatch(/-r"$/);
  });

  it('can be turned on per person, and device edits keep other people’s alarms', async () => {
    const support = (await get('carol', '/api/v1/calendar/calendars')).json.items.find((x: { ownerEmail: string }) => x.ownerEmail === 'support@acme.test');
    // Edit from a device that cannot see the alarm: the stored alarm must survive.
    const current = await call('GET', eventHref, basic);
    const edited = current.text.replace('SUMMARY:Standby', 'SUMMARY:Standby (edited)');
    const saved = await call('PUT', eventHref, basic, { raw: edited, headers: { 'content-type': 'text/calendar', 'if-match': current.headers.get('etag')! } });
    expect(saved.status, saved.text).toBe(204);
    expect((await put('carol', `/api/v1/calendar/calendars/${support.id}/reminders`, { enabled: true })).status).toBe(200);
    const withAlarms = await call('GET', eventHref, basic);
    expect(withAlarms.text).toContain('BEGIN:VALARM');
    expect(withAlarms.text).toContain('Standby (edited)');
    expect(withAlarms.headers.get('etag')).not.toMatch(/-r"$/);
  });
});

describe('sharing a single address book', () => {
  it('grants read or write to chosen people', async () => {
    const own = (await get('alice', '/api/v1/contacts/books')).json.items[0];
    expect(own.canShare).toBe(true);
    await post('alice', '/api/v1/contacts', { fullName: 'Vendor Contact', emails: [{ type: 'work', value: 'v@vendor.example' }] });
    const shared = await put('alice', `/api/v1/contacts/books/${own.id}/shares`, { grants: [{ principalType: 'user', principalId: ids.bob, access: 'read' }] });
    expect(shared.status, shared.text).toBe(200);
    const bobBooks = (await get('bob', '/api/v1/contacts/books')).json.items;
    const book = bobBooks.find((b: { id: string }) => b.id === own.id);
    expect(book).toMatchObject({ name: 'Alice', access: 'read', canShare: false });
    expect((await get('bob', `/api/v1/contacts?bookId=${own.id}`)).json.items[0].fullName).toBe('Vendor Contact');
    expect((await post('bob', `/api/v1/contacts?bookId=${own.id}`, { fullName: 'X' })).status).toBe(403);
    expect((await put('bob', `/api/v1/contacts/books/${own.id}/shares`, { grants: [] })).status).toBe(403);
    expect((await get('carol', `/api/v1/contacts?bookId=${own.id}`)).status).toBe(404);
  });
});
