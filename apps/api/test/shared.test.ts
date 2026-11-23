import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, signIn, startServer } from './harness';

let server: Awaited<ReturnType<typeof startServer>>;
let relay: SMTPServer;
const relayed: { to: string[]; raw: string }[] = [];
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
let sharedId: string;

const PASSWORD = 'correct horse battery staple';
const login = (email: string, password: string) => async ({ uid, client }: { uid: string; client: Client }) => client.post(`/interaction/${uid}/login`, { email, password });
const c = () => new Client(server.baseUrl);
const as = (who: string, mailbox?: string) => ({
  get: (path: string) => fetchJson('GET', path, who, mailbox),
  post: (path: string, body: unknown) => fetchJson('POST', path, who, mailbox, body),
});

async function fetchJson(method: string, path: string, who: string, mailbox?: string, body?: unknown) {
  const res = await fetch(server.baseUrl + path, {
    method,
    headers: { authorization: `Bearer ${tokens[who]}`, ...(mailbox ? { 'x-forge-mailbox': mailbox } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
}

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
  relay = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    logger: false,
    closeTimeout: 200,
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on('data', (ch: Buffer) => chunks.push(ch));
      stream.on('end', () => {
        relayed.push({ to: session.envelope.rcptTo.map((r) => r.address), raw: Buffer.concat(chunks).toString() });
        cb();
      });
    },
  });
  await new Promise<void>((r) => relay.listen(0, '127.0.0.1', () => r()));
  server = await startServer({ FORGE_SMTP_RELAY: `smtp://127.0.0.1:${(relay.server.address() as { port: number }).port}?ignoreTLS=true`, FORGE_MAIL_DISABLE_AUTH_CHECKS: 'true' });
  await c().post('/api/v1/setup', {
    setupToken: 'test-setup-token',
    organization: { name: 'Acme', timezone: 'UTC', defaultQuotaBytes: 1024 ** 3, requireMfa: false },
    domain: 'acme.test',
    admin: { username: 'admin', displayName: 'Ada Admin', password: PASSWORD },
  });
  tokens.admin = (await signIn(c(), login('admin', PASSWORD))).tokens.access_token;
  await c().request('PATCH', '/api/v1/admin/org', { body: { undoSendSeconds: 0 }, token: tokens.admin });
  for (const [name, pw] of [['alice', 'purple elephant 11'], ['bob', 'purple elephant 22'], ['carol', 'purple elephant 33']] as const) {
    const res = await c().post('/api/v1/admin/users', { username: name, displayName: name, password: pw, mustChangePassword: false }, tokens.admin);
    ids[name] = res.json.user.id;
    tokens[name] = (await signIn(c(), login(name, pw))).tokens.access_token;
  }
}, 120_000);

afterAll(async () => {
  await server?.close();
  await new Promise<void>((r) => relay?.close(() => r()));
});

describe('shared mailboxes', () => {
  it('are created and permissioned by admins', async () => {
    const res = await as('admin').post('/api/v1/admin/shared-mailboxes', {
      displayName: 'Sales',
      username: 'sales',
      grants: [
        { principalType: 'user', principalId: ids.alice, access: 'full', sendAs: true, sendOnBehalf: false },
        { principalType: 'user', principalId: ids.bob, access: 'read', sendAs: false, sendOnBehalf: true },
      ],
    });
    expect(res.status, res.text).toBe(201);
    sharedId = res.json.mailbox.id;
    const detail = await as('admin').get(`/api/v1/admin/shared-mailboxes/${sharedId}`);
    expect(detail.json.grants.map((g: { name: string; access: string }) => `${g.name}:${g.access}`)).toEqual(['alice:full', 'bob:read']);
    // Shared mailboxes are not people: hidden from the user list, no admin roles.
    const users = await as('admin').get('/api/v1/admin/users');
    expect(users.json.items.map((u: { email: string }) => u.email)).not.toContain('sales@acme.test');
    const roles = await fetch(`${server.baseUrl}/api/v1/admin/users/${sharedId}/roles`, { method: 'PUT', headers: { authorization: `Bearer ${tokens.admin}`, 'content-type': 'application/json' }, body: JSON.stringify({ roles: ['helpdesk'] }) });
    expect(roles.status).toBe(400);
  });

  it('cannot be signed in to', async () => {
    await expect(signIn(c(), login('sales@acme.test', 'anything at all 1'))).rejects.toThrow(/401/);
  });

  it('show up as accounts for members only', async () => {
    const alice = await as('alice').get('/api/v1/mail/accounts');
    expect(alice.json.items.map((a: { address: string; access: string }) => `${a.address}:${a.access}`)).toEqual(['alice@acme.test:owner', 'sales@acme.test:full']);
    const carol = await as('carol').get('/api/v1/mail/accounts');
    expect(carol.json.items).toHaveLength(1);
  });

  it('receive mail that members can read', async () => {
    await as('carol').post('/api/v1/mail/send', { to: [{ address: 'sales@acme.test' }], subject: 'Quote request', html: '<p>Price for 10 units?</p>' });
    const boxes = await waitFor(async () => {
      const r = await as('alice', sharedId).get('/api/v1/mail/mailboxes');
      return r.json.items.find((b: { specialUse: string; total: number }) => b.specialUse === '\\Inbox' && b.total > 0) ? r : null;
    });
    const inbox = boxes.json.items.find((b: { specialUse: string }) => b.specialUse === '\\Inbox');
    const threads = await as('bob', sharedId).get(`/api/v1/mail/threads?mailboxId=${inbox.id}`);
    expect(threads.json.items[0].latest.subject).toBe('Quote request');
    expect((await as('carol', sharedId).get('/api/v1/mail/mailboxes')).status).toBe(404);
  });

  it('enforce read-only access', async () => {
    const boxes = await as('bob', sharedId).get('/api/v1/mail/mailboxes');
    const inbox = boxes.json.items.find((b: { specialUse: string }) => b.specialUse === '\\Inbox');
    const thread = (await as('bob', sharedId).get(`/api/v1/mail/threads?mailboxId=${inbox.id}`)).json.items[0];
    expect((await as('bob', sharedId).post('/api/v1/mail/messages/actions', { ids: thread.messageIds, action: 'archive' })).status).toBe(403);
    expect((await as('alice', sharedId).post('/api/v1/mail/messages/actions', { ids: thread.messageIds, action: 'read' })).status).toBe(200);
  });

  it('send as the shared address and keep the copy in its Sent folder', async () => {
    const r = await as('alice', sharedId).post('/api/v1/mail/send', { from: 'sales@acme.test', to: [{ address: 'buyer@remote.example' }], subject: 'Your quote', html: '<p>£100</p>' });
    expect(r.status, r.text).toBe(200);
    const out = await waitFor(async () => relayed.find((m) => m.raw.includes('Subject: Your quote')));
    expect(out.raw).toMatch(/^From: Sales <sales@acme\.test>/m);
    expect(out.raw).not.toMatch(/^Sender:/m);
    const sent = (await as('alice', sharedId).get('/api/v1/mail/mailboxes')).json.items.find((b: { specialUse: string }) => b.specialUse === '\\Sent');
    expect(sent.total).toBe(1);
    const mine = (await as('alice').get('/api/v1/mail/mailboxes')).json.items.find((b: { specialUse: string }) => b.specialUse === '\\Sent');
    expect(mine.total).toBe(0);
  });

  it('send on behalf with a Sender header', async () => {
    const settings = await as('bob').get('/api/v1/mail/settings');
    expect(settings.json.onBehalfOf).toEqual(['sales@acme.test']);
    const r = await as('bob', sharedId).post('/api/v1/mail/send', { from: 'sales@acme.test', to: [{ address: 'buyer@remote.example' }], subject: 'Follow-up', html: '<p>Any questions?</p>' });
    expect(r.status, r.text).toBe(200);
    const out = await waitFor(async () => relayed.find((m) => m.raw.includes('Subject: Follow-up')));
    expect(out.raw).toMatch(/^Sender: bob <bob@acme\.test>/m);
    expect((await as('carol').post('/api/v1/mail/send', { from: 'sales@acme.test', to: [{ address: 'x@remote.example' }], subject: 'x', html: 'x' })).status).toBe(400);
  });
});

describe('shared mailbox calendars', () => {
  let salesCal: string;

  it('appear for members with matching access', async () => {
    const alice = (await as('alice').get('/api/v1/calendar/calendars')).json.items;
    const cal = alice.find((c: { ownerEmail: string | null }) => c.ownerEmail === 'sales@acme.test');
    expect(cal).toMatchObject({ access: 'write', ownerType: 'shared', owner: 'Sales' });
    salesCal = cal.id;
    const bob = (await as('bob').get('/api/v1/calendar/calendars')).json.items;
    expect(bob.find((c: { id: string }) => c.id === salesCal)?.access).toBe('read');
    const carol = (await as('carol').get('/api/v1/calendar/calendars')).json.items;
    expect(carol.find((c: { id: string }) => c.id === salesCal)).toBeUndefined();
  });

  it('send invitations as the shared mailbox and collect replies there', async () => {
    const created = await as('alice').post('/api/v1/calendar/events', {
      calendarId: salesCal,
      summary: 'Sales pipeline review',
      start: '2032-02-02T10:00:00.000Z',
      end: '2032-02-02T11:00:00.000Z',
      attendees: [{ email: 'carol@acme.test' }],
    });
    expect(created.status, created.text).toBe(201);
    const carolEvent = await waitFor(async () => {
      const r = await as('carol').get('/api/v1/calendar/events?from=2032-02-01T00:00:00Z&to=2032-02-03T00:00:00Z');
      return r.json.items.find((e: { summary: string }) => e.summary === 'Sales pipeline review');
    });
    expect(carolEvent.organizer).toBe('sales@acme.test');
    expect((await as('carol').post(`/api/v1/calendar/events/${carolEvent.objectId}/rsvp`, { status: 'ACCEPTED' })).status).toBe(200);
    // The reply goes to sales@ and updates the shared calendar, visible to every member.
    await waitFor(async () => {
      const ev = (await as('bob').get(`/api/v1/calendar/events/${created.json.event.id}`)).json.event;
      return ev?.attendees.find((a: { email: string }) => a.email === 'carol@acme.test')?.partstat === 'ACCEPTED';
    });
    const bobView = (await as('bob').get('/api/v1/calendar/events?from=2032-02-01T00:00:00Z&to=2032-02-03T00:00:00Z')).json.items.find((e: { summary: string }) => e.summary === 'Sales pipeline review');
    expect(bobView).toMatchObject({ isOrganizer: true, canEdit: false });
  });

  it('enforce read-only access', async () => {
    const r = await as('bob').post('/api/v1/calendar/events', { calendarId: salesCal, summary: 'Nope', start: '2032-02-03T10:00:00.000Z', end: '2032-02-03T11:00:00.000Z' });
    expect(r.status).toBe(403);
  });

  it('let members answer invitations sent to the shared mailbox', async () => {
    const created = await as('carol').post('/api/v1/calendar/events', {
      calendarId: (await as('carol').get('/api/v1/calendar/calendars')).json.items[0].id,
      summary: 'Customer visit',
      start: '2032-03-03T09:00:00.000Z',
      end: '2032-03-03T10:00:00.000Z',
      attendees: [{ email: 'sales@acme.test' }],
    });
    expect(created.status).toBe(201);
    const invite = await waitFor(async () => {
      const r = await as('alice').get('/api/v1/calendar/events?from=2032-03-01T00:00:00Z&to=2032-03-05T00:00:00Z');
      return r.json.items.find((e: { summary: string; calendarId: string }) => e.summary === 'Customer visit' && e.calendarId === salesCal);
    });
    expect(invite.myStatus).toBe('NEEDS-ACTION');
    expect((await as('alice').post(`/api/v1/calendar/events/${invite.objectId}/rsvp`, { status: 'TENTATIVE' })).status).toBe(200);
    await waitFor(async () => {
      const ev = (await as('carol').get(`/api/v1/calendar/events/${created.json.event.id}`)).json.event;
      return ev.attendees.find((a: { email: string }) => a.email === 'sales@acme.test')?.partstat === 'TENTATIVE';
    });
  });

  it('sync to native apps over CalDAV with the same rights', async () => {
    const pw = (await as('bob').post('/api/v1/me/app-passwords', { name: 'Laptop' })).json.password;
    const basic = 'Basic ' + Buffer.from(`bob@acme.test:${pw}`).toString('base64');
    const list = await fetch(`${server.baseUrl}/dav/calendars/${ids.bob}/`, { method: 'PROPFIND', headers: { authorization: basic, depth: '1', 'content-type': 'application/xml' }, body: '<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>' });
    expect(await list.text()).toContain(`/${salesCal}/`);
    const put = await fetch(`${server.baseUrl}/dav/calendars/${ids.bob}/${salesCal}/x.ics`, {
      method: 'PUT',
      headers: { authorization: basic, 'content-type': 'text/calendar' },
      body: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTAMP:20320101T000000Z\r\nDTSTART:20320101T100000Z\r\nDTEND:20320101T110000Z\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
    });
    expect(put.status).toBe(403);
  });
});

describe('shared mailbox contacts', () => {
  it('share an address book with read/write matching mail access', async () => {
    const books = (await as('alice').get('/api/v1/contacts/books')).json.items;
    const sales = books.find((b: { shared: boolean }) => b.shared);
    expect(sales).toMatchObject({ name: 'Sales', access: 'write' });
    const add = await as('alice').post(`/api/v1/contacts?bookId=${sales.id}`, { fullName: 'Big Customer', emails: [{ type: 'work', value: 'buyer@bigco.example' }] });
    expect(add.status, add.text).toBe(201);
    const bobBooks = (await as('bob').get('/api/v1/contacts/books')).json.items;
    expect(bobBooks.find((b: { id: string }) => b.id === sales.id)?.access).toBe('read');
    expect((await as('bob').get(`/api/v1/contacts?bookId=${sales.id}`)).json.items[0].fullName).toBe('Big Customer');
    expect((await as('bob').post(`/api/v1/contacts?bookId=${sales.id}`, { fullName: 'X' })).status).toBe(403);
    expect((await as('carol').get(`/api/v1/contacts?bookId=${sales.id}`)).status).toBe(404);
    // Alice's own default book is untouched.
    expect((await as('alice').get('/api/v1/contacts')).json.items).toHaveLength(0);
  });
});

describe('revocation', () => {
  it('lose access as soon as permissions are removed', async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/admin/shared-mailboxes/${sharedId}/permissions`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${tokens.admin}`, 'content-type': 'application/json' },
      body: JSON.stringify({ grants: [{ principalType: 'user', principalId: ids.alice, access: 'full', sendAs: false, sendOnBehalf: false }] }),
    });
    expect(res.status).toBe(200);
    expect((await as('bob', sharedId).get('/api/v1/mail/mailboxes')).status).toBe(404);
    expect((await as('alice', sharedId).post('/api/v1/mail/send', { from: 'sales@acme.test', to: [{ address: 'x@remote.example' }], subject: 'x', html: 'x' })).status).toBe(400);
    const audit = await as('admin').get('/api/v1/admin/audit?action=shared_mailbox.');
    expect(audit.json.items.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['shared_mailbox.created', 'shared_mailbox.permissions_changed']));
  });
});
