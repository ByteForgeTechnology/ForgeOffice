import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, signIn, startServer } from './harness';

let server: Awaited<ReturnType<typeof startServer>>;
let relay: SMTPServer;
const relayed: { to: string[]; raw: string }[] = [];
let admin: string;
let bob: string;
let bobId: string;

const PASSWORD = 'correct horse battery staple';
const login = (email: string, password: string) => async ({ uid, client }: { uid: string; client: Client }) => client.post(`/interaction/${uid}/login`, { email, password });

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const api = new Proxy({} as Client, { get: (_t, p) => (new Client(server.baseUrl) as never)[p] });

beforeAll(async () => {
  relay = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    logger: false,
    closeTimeout: 200,
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        relayed.push({ to: session.envelope.rcptTo.map((r) => r.address), raw: Buffer.concat(chunks).toString() });
        cb();
      });
    },
  });
  await new Promise<void>((r) => relay.listen(0, '127.0.0.1', () => r()));
  server = await startServer({ FORGE_SMTP_RELAY: `smtp://127.0.0.1:${(relay.server.address() as { port: number }).port}?ignoreTLS=true`, FORGE_MAIL_DISABLE_AUTH_CHECKS: 'true' });
  const c = new Client(server.baseUrl);
  await c.post('/api/v1/setup', {
    setupToken: 'test-setup-token',
    organization: { name: 'Acme', timezone: 'UTC', defaultQuotaBytes: 1024 ** 3, requireMfa: false },
    domain: 'acme.test',
    admin: { username: 'admin', displayName: 'Ada Admin', password: PASSWORD },
  });
  admin = (await signIn(c, login('admin', PASSWORD))).tokens.access_token;
  await c.request('PATCH', '/api/v1/admin/org', { body: { undoSendSeconds: 0 }, token: admin });
  const created = await c.post('/api/v1/admin/users', { username: 'bob', displayName: 'Bob Builder', password: 'purple elephant 99', mustChangePassword: false }, admin);
  bobId = created.json.user.id;
  bob = (await signIn(new Client(server.baseUrl), login('bob', 'purple elephant 99'))).tokens.access_token;
}, 90_000);

afterAll(async () => {
  await server?.close();
  await new Promise<void>((r) => relay?.close(() => r()));
});

async function inboxThreads(token: string) {
  const boxes = await api.get('/api/v1/mail/mailboxes', token);
  const inbox = boxes.json.items.find((b: { specialUse: string }) => b.specialUse === '\\Inbox');
  return (await api.get(`/api/v1/mail/threads?mailboxId=${inbox.id}`, token)).json.items as any[];
}

describe('webmail', () => {
  it('provisions default folders', async () => {
    const res = await api.get('/api/v1/mail/mailboxes', admin);
    expect(res.json.items.map((b: { name: string }) => b.name)).toEqual(['Inbox', 'Drafts', 'Sent', 'Archive', 'Junk', 'Trash']);
  });

  it('sends with attachments to local and external recipients', async () => {
    const up = await api.request('POST', '/api/v1/mail/uploads', { token: admin, body: undefined });
    expect(up.status).toBe(400);
    const res = await fetch(`${server.baseUrl}/api/v1/mail/uploads`, {
      method: 'POST',
      headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/octet-stream', 'x-filename': 'plan.txt', 'x-content-type': 'text/plain' },
      body: 'the plan',
    });
    const upload = ((await res.json()) as { upload: { id: string } }).upload;
    const sent = await api.post(
      '/api/v1/mail/send',
      { to: [{ address: 'bob@acme.test' }], cc: [{ address: 'partner@remote.example' }], subject: 'Project plan', html: '<p>Hello <b>Bob</b><script>alert(1)</script></p>', attachmentIds: [upload.id] },
      admin,
    );
    expect(sent.status, sent.text).toBe(200);
    const thread = await waitFor(async () => (await inboxThreads(bob)).find((t) => t.latest.subject === 'Project plan'));
    expect(thread.hasAttachments).toBe(true);
    const full = await api.get(`/api/v1/mail/threads/${thread.threadId}`, bob);
    const msg = full.json.messages[0];
    expect(msg.body.html).toContain('<b>Bob</b>');
    expect(msg.body.html).not.toContain('script');
    const att = msg.attachments[0];
    const dl = await fetch(`${server.baseUrl}/api/v1/mail/messages/${msg.id}/attachments/${att.partPath}`, { headers: { authorization: `Bearer ${bob}` } });
    expect(await dl.text()).toBe('the plan');
    await waitFor(async () => relayed.find((r) => r.to.includes('partner@remote.example')));
    // Sent copy keeps the conversation together for the sender.
    const sentBox = (await api.get('/api/v1/mail/mailboxes', admin)).json.items.find((b: { specialUse: string }) => b.specialUse === '\\Sent');
    expect(sentBox.total).toBe(1);
  });

  it('threads replies and finds messages with full-text search', async () => {
    const thread = (await inboxThreads(bob)).find((t) => t.latest.subject === 'Project plan');
    const r = await api.post('/api/v1/mail/send', { to: [{ address: 'admin@acme.test' }], subject: 'Re: Project plan', html: '<p>Looks great, approved</p>', replyToMessageId: thread.latest.id }, bob);
    expect(r.status, r.text).toBe(200);
    const adminThread = await waitFor(async () => (await inboxThreads(admin)).find((t) => t.latest.subject === 'Re: Project plan'));
    const conversation = await api.get(`/api/v1/mail/threads/${adminThread.threadId}`, admin);
    expect(conversation.json.messages.map((m: { subject: string }) => m.subject)).toEqual(['Project plan', 'Re: Project plan']);
    const search = await api.get('/api/v1/mail/threads?q=approved', admin);
    expect(search.json.items).toHaveLength(1);
  });

  it('supports undo send', async () => {
    await api.request('PATCH', '/api/v1/admin/org', { body: { undoSendSeconds: 30 }, token: admin });
    const sent = await api.post('/api/v1/mail/send', { to: [{ address: 'bob@acme.test' }], subject: 'Oops', html: '<p>wrong</p>' }, admin);
    const undone = await api.post(`/api/v1/mail/outbound/${sent.json.outbound.id}/cancel`, {}, admin);
    expect(undone.status, undone.text).toBe(200);
    const drafts = (await api.get('/api/v1/mail/mailboxes', admin)).json.items.find((b: { specialUse: string }) => b.specialUse === '\\Drafts');
    expect(drafts.total).toBe(1);
    const draft = await api.get(`/api/v1/mail/drafts/${undone.json.draftMessageId}`, admin);
    expect(draft.json.draft.subject).toBe('Oops');
    await api.request('PATCH', '/api/v1/admin/org', { body: { undoSendSeconds: 0 }, token: admin });
  });

  it('flags, archives and deletes messages', async () => {
    const thread = (await inboxThreads(bob))[0];
    const ids = thread.messageIds;
    await api.post('/api/v1/mail/messages/actions', { ids, action: 'flag' }, bob);
    await api.post('/api/v1/mail/messages/actions', { ids, action: 'archive' }, bob);
    expect((await inboxThreads(bob)).find((t) => t.threadId === thread.threadId)).toBeUndefined();
    await api.post('/api/v1/mail/messages/actions', { ids, action: 'delete' }, bob);
    await api.post('/api/v1/mail/messages/actions', { ids, action: 'delete' }, bob);
    const trash = (await api.get('/api/v1/mail/mailboxes', bob)).json.items.find((b: { specialUse: string }) => b.specialUse === '\\Trash');
    expect(trash.total).toBe(0);
  });

  it('manages rules and auto-replies', async () => {
    const boxes = (await api.get('/api/v1/mail/mailboxes', bob)).json.items;
    const archive = boxes.find((b: { specialUse: string }) => b.specialUse === '\\Archive');
    const f = await api.post('/api/v1/mail/filters', { name: 'Newsletters', conditions: [{ field: 'subject', op: 'contains', value: 'newsletter' }], actions: [{ type: 'move', value: archive.id }] }, bob);
    expect(f.status, f.text).toBe(201);
    expect((await api.post('/api/v1/mail/filters', { name: 'Bad', conditions: [{ field: 'subject', op: 'matches', value: '(' }], actions: [{ type: 'markRead' }] }, bob)).status).toBe(400);
    const ar = await api.request('PUT', '/api/v1/mail/auto-reply', { body: { enabled: true, subject: 'Away', body: 'Back soon', startsAt: null, endsAt: null, internalOnly: true }, token: bob });
    expect(ar.status).toBe(200);
    const settings = await api.get('/api/v1/mail/settings', bob);
    expect(settings.json.autoReply.enabled).toBe(true);
    expect(settings.json.identities).toEqual(['bob@acme.test']);
    await api.request('PUT', '/api/v1/mail/auto-reply', { body: { enabled: false, subject: 'Away', body: '', startsAt: null, endsAt: null, internalOnly: false }, token: bob });
  });

  it('suggests recipients from the directory', async () => {
    const res = await api.get('/api/v1/mail/suggest?q=bob', admin);
    expect(res.json.items[0]).toMatchObject({ address: 'bob@acme.test', kind: 'person' });
  });
});

describe('calendar', () => {
  let roomId: string;
  let eventId: string;

  it('books meetings: invites colleagues, rooms auto-accept', async () => {
    const room = await api.post('/api/v1/admin/resources', { name: 'Board room', email: 'board@acme.test', capacity: 10 }, admin);
    expect(room.status, room.text).toBe(201);
    roomId = room.json.resource.id;
    const cals = (await api.get('/api/v1/calendar/calendars', admin)).json.items;
    const created = await api.post(
      '/api/v1/calendar/events',
      {
        calendarId: cals[0].id,
        summary: 'Quarterly review',
        start: '2031-03-03T10:00:00.000Z',
        end: '2031-03-03T11:00:00.000Z',
        attendees: [{ email: 'bob@acme.test' }],
        resourceIds: [roomId],
        addMeeting: true,
      },
      admin,
    );
    expect(created.status, created.text).toBe(201);
    eventId = created.json.event.id;

    // Bob receives the invitation by email and it appears in his calendar.
    const bobEvent = await waitFor(async () => {
      const res = await api.get('/api/v1/calendar/events?from=2031-03-01T00:00:00Z&to=2031-03-10T00:00:00Z', bob);
      return res.json.items.find((e: { summary: string }) => e.summary === 'Quarterly review');
    });
    expect(bobEvent.myStatus).toBe('NEEDS-ACTION');
    expect(bobEvent.meetingUrl).toMatch(/\/team\/meet\//);
    expect((await inboxThreads(bob)).some((t) => t.latest.subject === 'Invitation: Quarterly review')).toBe(true);

    const rsvp = await api.post(`/api/v1/calendar/events/${bobEvent.objectId}/rsvp`, { status: 'ACCEPTED' }, bob);
    expect(rsvp.status, rsvp.text).toBe(200);

    // Bob's reply and the room's automatic acceptance update the organiser's copy.
    await waitFor(async () => {
      const ev = (await api.get(`/api/v1/calendar/events/${eventId}`, admin)).json.event;
      const statuses = Object.fromEntries(ev.attendees.map((a: { email: string; partstat: string }) => [a.email, a.partstat]));
      return statuses['bob@acme.test'] === 'ACCEPTED' && statuses['board@acme.test'] === 'ACCEPTED';
    });
  });

  it('declines a double-booked room and reports free/busy', async () => {
    const cals = (await api.get('/api/v1/calendar/calendars', bob)).json.items;
    const clash = await api.post(
      '/api/v1/calendar/events',
      { calendarId: cals[0].id, summary: 'Clash', start: '2031-03-03T10:30:00.000Z', end: '2031-03-03T11:30:00.000Z', resourceIds: [roomId] },
      bob,
    );
    await waitFor(async () => {
      const ev = (await api.get(`/api/v1/calendar/events/${clash.json.event.id}`, bob)).json.event;
      return ev.attendees.find((a: { email: string }) => a.email === 'board@acme.test')?.partstat === 'DECLINED';
    });
    const fb = await api.post('/api/v1/calendar/freebusy', { emails: ['bob@acme.test', 'board@acme.test', 'stranger@x.example'], from: '2031-03-03T00:00:00Z', to: '2031-03-04T00:00:00Z' }, admin);
    expect(fb.json.busy['board@acme.test']).toHaveLength(1);
    expect(fb.json.busy['bob@acme.test'].length).toBeGreaterThanOrEqual(1);
    expect(fb.json.busy['stranger@x.example']).toBeNull();
  });

  it('expands recurring events', async () => {
    const cals = (await api.get('/api/v1/calendar/calendars', admin)).json.items;
    await api.post(
      '/api/v1/calendar/events',
      { calendarId: cals[0].id, summary: 'Stand-up', start: '2031-05-05T09:00:00.000Z', end: '2031-05-05T09:15:00.000Z', recurrence: { freq: 'DAILY', count: 5 } },
      admin,
    );
    const res = await api.get('/api/v1/calendar/events?from=2031-05-01T00:00:00Z&to=2031-05-31T00:00:00Z', admin);
    expect(res.json.items.filter((e: { summary: string }) => e.summary === 'Stand-up')).toHaveLength(5);
  });
});

describe('contacts & directory', () => {
  it('stores personal contacts and exposes the GAL', async () => {
    const c = await api.post('/api/v1/contacts', { fullName: 'Grace Hopper', emails: [{ type: 'work', value: 'grace@navy.example' }], organization: 'US Navy' }, admin);
    expect(c.status, c.text).toBe(201);
    expect((await api.get('/api/v1/contacts?q=grace', admin)).json.items[0].emails[0].value).toBe('grace@navy.example');
    const gal = await api.get('/api/v1/directory/gal', bob);
    expect(gal.json.items.map((e: { email: string }) => e.email)).toEqual(expect.arrayContaining(['admin@acme.test', 'bob@acme.test', 'board@acme.test']));
  });
});

describe('CalDAV / CardDAV', () => {
  let basic: string;

  it('authenticates with an app password', async () => {
    const res = await api.post('/api/v1/me/app-passwords', { name: 'Phone' }, bob);
    expect(res.json.password).toMatch(/^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$/);
    basic = 'Basic ' + Buffer.from(`bob@acme.test:${res.json.password}`).toString('base64');
    const denied = await fetch(`${server.baseUrl}/dav/`, { method: 'PROPFIND' });
    expect(denied.status).toBe(401);
  });

  const dav = (method: string, path: string, body?: string, headers: Record<string, string> = {}) =>
    fetch(`${server.baseUrl}${path}`, { method, headers: { authorization: basic, 'content-type': 'application/xml', ...headers }, body });

  it('discovers the principal and calendar home', async () => {
    const wk = await fetch(`${server.baseUrl}/.well-known/caldav`, { redirect: 'manual' });
    expect(wk.headers.get('location')).toBe('/dav/');
    const res = await dav('PROPFIND', '/dav/', '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>', { depth: '0' });
    expect(res.status).toBe(207);
    expect(await res.text()).toContain(`/dav/principals/${bobId}/`);
    const home = await dav('PROPFIND', `/dav/principals/${bobId}/`, '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>');
    expect(await home.text()).toContain(`/dav/calendars/${bobId}/`);
  });

  it('syncs events with PUT, calendar-query, sync-collection and DELETE', async () => {
    const list = await dav('PROPFIND', `/dav/calendars/${bobId}/`, '<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:prop><d:displayname/><cs:getctag/><d:sync-token/></d:prop></d:propfind>', { depth: '1' });
    const xml = await list.text();
    const calHref = /<d:href>(\/dav\/calendars\/[^<]+\/[0-9a-f-]{36}\/)<\/d:href>/.exec(xml)![1]!;
    const token = /<d:sync-token>([^<]+)<\/d:sync-token>/.exec(xml)![1]!;

    const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\nBEGIN:VEVENT\r\nUID:dav-1\r\nDTSTAMP:20310101T000000Z\r\nDTSTART:20310601T100000Z\r\nDTEND:20310601T110000Z\r\nSUMMARY:From phone\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    const put = await dav('PUT', `${calHref}dav-1.ics`, ics, { 'content-type': 'text/calendar', 'if-none-match': '*' });
    expect(put.status).toBe(201);
    const etag = put.headers.get('etag')!;
    expect((await dav('PUT', `${calHref}dav-1.ics`, ics, { 'content-type': 'text/calendar', 'if-none-match': '*' })).status).toBe(412);

    const query = await dav(
      'REPORT',
      calHref,
      '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="20310601T000000Z" end="20310602T000000Z"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>',
      { depth: '1' },
    );
    const qxml = await query.text();
    expect(qxml).toContain('SUMMARY:From phone');
    expect(qxml).not.toContain('Quarterly review');

    const sync = await dav('REPORT', calHref, `<d:sync-collection xmlns:d="DAV:"><d:sync-token>${token}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`);
    expect(await sync.text()).toContain('dav-1.ics');

    expect((await dav('DELETE', `${calHref}dav-1.ics`, undefined, { 'if-match': etag })).status).toBe(204);
    const after = await dav('REPORT', calHref, `<d:sync-collection xmlns:d="DAV:"><d:sync-token>${token}</d:sync-token><d:prop><d:getetag/></d:prop></d:sync-collection>`);
    expect(await after.text()).toMatch(/dav-1\.ics<\/d:href><d:status>HTTP\/1.1 404/);
  });

  it('serves personal contacts and the read-only directory over CardDAV', async () => {
    const home = await dav('PROPFIND', `/dav/addressbooks/${bobId}/`, '<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>', { depth: '1' });
    const xml = await home.text();
    const bookHref = /<d:href>(\/dav\/addressbooks\/[^<]+\/[0-9a-f-]{36}\/)<\/d:href>/.exec(xml)![1]!;
    expect(xml).toContain('/directory/');
    const vcard = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:c-1\r\nFN:Linus Example\r\nEMAIL;TYPE=WORK:linus@example.org\r\nEND:VCARD\r\n';
    expect((await dav('PUT', `${bookHref}c-1.vcf`, vcard, { 'content-type': 'text/vcard' })).status).toBe(201);
    const contacts = await api.get('/api/v1/contacts', bob);
    expect(contacts.json.items.map((c: { fullName: string }) => c.fullName)).toContain('Linus Example');
    const gal = await dav('REPORT', `/dav/addressbooks/${bobId}/directory/`, '<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><card:address-data/></d:prop></card:addressbook-query>');
    expect(await gal.text()).toContain('admin@acme.test');
    expect((await dav('PUT', `/dav/addressbooks/${bobId}/directory/x.vcf`, vcard, { 'content-type': 'text/vcard' })).status).toBe(403);
  });
});
