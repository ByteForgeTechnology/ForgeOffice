import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { calendarObjects } from '@forge/db';
import { Client, signIn, startServer } from './harness';

let server: Awaited<ReturnType<typeof startServer>>;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
const sockets: Socket[] = [];

const login = (email: string, password: string) => async ({ uid, client }: { uid: string; client: Client }) => client.post(`/interaction/${uid}/login`, { email, password });
async function call(method: string, path: string, who: string, body?: unknown) {
  const res = await fetch(server.baseUrl + path, {
    method,
    headers: { ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
}

/** A Team app connection; records every event it receives. */
async function socketFor(auth: Record<string, string>) {
  const s = connect(server.baseUrl, { path: '/team-socket', auth, transports: ['websocket'], forceNew: true });
  const events: [string, any][] = [];
  s.onAny((e, p) => events.push([e, p]));
  await new Promise<void>((resolve, reject) => {
    s.once('connect', () => resolve());
    s.once('connect_error', reject);
  });
  sockets.push(s);
  return Object.assign(s, { events });
}
const ask = (s: Socket, event: string, payload: unknown = {}) => new Promise<any>((resolve) => s.emit(event, payload, resolve));
async function waitFor<T>(fn: () => T | undefined | null | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}
const got = (s: { events: [string, any][] }, event: string, match: (p: any) => boolean = () => true) => waitFor(() => s.events.find(([e, p]) => e === event && match(p))?.[1]);

async function upload(who: string, libraryId: string, parentId: string | null, name: string, data: Buffer) {
  const start = await call('POST', '/api/v1/drive/uploads', who, { libraryId, parentId, name, size: data.length });
  const res = await fetch(`${server.baseUrl}/api/v1/drive/uploads/${start.json.upload.id}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/offset+octet-stream', 'upload-offset': '0' },
    body: data,
  });
  return ((await res.json()) as { item: { id: string } }).item;
}

beforeAll(async () => {
  server = await startServer({ FORGE_MAIL_DISABLE_AUTH_CHECKS: 'true', FORGE_RTC_LISTEN_IP: '127.0.0.1', FORGE_RTC_MIN_PORT: '43000', FORGE_RTC_MAX_PORT: '43200' });
  const c = new Client(server.baseUrl);
  await c.post('/api/v1/setup', {
    setupToken: 'test-setup-token',
    organization: { name: 'Acme', timezone: 'UTC', defaultQuotaBytes: 1024 ** 3, requireMfa: false },
    domain: 'acme.test',
    admin: { username: 'admin', displayName: 'Ada Admin', password: 'correct horse battery staple' },
  });
  tokens.admin = (await signIn(c, login('admin', 'correct horse battery staple'))).tokens.access_token;
  for (const [u, n, pw] of [['alice', 'Alice', 'violet tangerine 77'], ['bob', 'Bob', 'orange marmalade 88'], ['carol', 'Carol', 'purple aubergine 99']]) {
    await c.post('/api/v1/admin/users', { username: u, displayName: n, password: pw, mustChangePassword: false }, tokens.admin);
    tokens[u!] = (await signIn(new Client(server.baseUrl), login(u!, pw!))).tokens.access_token;
    ids[u!] = (await call('GET', '/api/v1/me', u!)).json.user.id;
  }
}, 120_000);

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await server?.close();
});

describe('ForgeTeam', () => {
  let team: string;
  let general: string;
  let library: string;

  it('teams: a group, a General channel and a document library; private teams stay private', async () => {
    const created = await call('POST', '/api/v1/team/teams', 'alice', { name: 'Product', description: 'Roadmaps and launches', memberIds: [ids.bob] });
    expect(created.status, created.text).toBe(201);
    team = created.json.team.id;
    general = created.json.generalChannelId;
    const home = (await call('GET', '/api/v1/team/home', 'bob')).json;
    expect(home.teams).toMatchObject([{ name: 'Product', role: 'member', channels: [{ name: 'General', isGeneral: true, kind: 'standard' }] }]);
    expect((await call('GET', '/api/v1/team/home', 'carol')).json.teams).toEqual([]);
    expect((await call('GET', `/api/v1/team/teams/${team}`, 'carol')).status).toBe(404);
    const detail = (await call('GET', `/api/v1/team/teams/${team}`, 'alice')).json;
    expect(detail.members.map((m: { name: string; role: string }) => `${m.name}:${m.role}`)).toEqual(['Alice:owner', 'Bob:member']);
    library = detail.libraryId;
    // The team is a security group with a library: its files are in Drive.
    expect((await call('GET', `/api/v1/drive/libraries/${library}/items`, 'bob')).json.items.map((i: { name: string }) => i.name)).toEqual(['General']);

    // Public teams can be found and joined.
    const pub = (await call('POST', '/api/v1/team/teams', 'bob', { name: 'Social', visibility: 'public' })).json.team;
    expect((await call('GET', '/api/v1/team/teams/discover', 'carol')).json.items.map((t: { name: string }) => t.name)).toEqual(['Social']);
    expect((await call('POST', `/api/v1/team/teams/${pub.id}/join`, 'carol')).status).toBe(200);
    expect((await call('POST', `/api/v1/team/teams/${team}/join`, 'carol')).status).toBe(404); // private
    expect((await call('POST', `/api/v1/team/teams/${team}/members`, 'bob', { add: [{ userId: ids.carol, role: 'member' }] })).status).toBe(403); // owners only
  });

  it('channels: standard for the team, private for chosen members (with their own folder)', async () => {
    expect((await call('POST', `/api/v1/team/teams/${team}/channels`, 'bob', { name: 'Design' })).status).toBe(201);
    const leads = await call('POST', `/api/v1/team/teams/${team}/channels`, 'alice', { name: 'Leads', private: true });
    expect(leads.status, leads.text).toBe(201);
    expect((await call('POST', `/api/v1/team/teams/${team}/channels`, 'alice', { name: 'design' })).status).toBe(409);
    const bobs = (await call('GET', '/api/v1/team/home', 'bob')).json.teams[0].channels.map((c: { name: string }) => c.name);
    expect(bobs).toEqual(['General', 'Design']);
    expect((await call('GET', `/api/v1/team/channels/${leads.json.channel.id}`, 'bob')).status).toBe(404);
    const folders = (await call('GET', `/api/v1/drive/libraries/${library}/items`, 'alice')).json.items.map((i: { name: string }) => i.name);
    expect(folders.sort()).toEqual(['Design', 'General', 'Leads']);
    expect((await call('GET', `/api/v1/drive/libraries/${library}/items?parentId=${leads.json.channel.folderId}`, 'bob')).status).toBe(404);
    // Adding Bob to the private channel opens its folder to him.
    await call('POST', `/api/v1/team/channels/${leads.json.channel.id}/members`, 'alice', { add: [ids.bob] });
    expect((await call('GET', `/api/v1/drive/libraries/${library}/items?parentId=${leads.json.channel.folderId}`, 'bob')).status).toBe(200);
    expect((await call('POST', `/api/v1/team/channels/${leads.json.channel.id}/members`, 'alice', { add: [ids.carol] })).status).toBe(400); // not in the team
  });

  it('messages: live delivery, mentions, unread counts, threads, edits, reactions, moderation, search', async () => {
    const aliceS = await socketFor({ token: tokens.alice! });
    const carolS = await socketFor({ token: tokens.carol! });
    const post = await call('POST', `/api/v1/team/channels/${general}/messages`, 'bob', { body: `Hi <@${ids.alice}>, the **roadmap** is ready` });
    expect(post.status, post.text).toBe(201);
    const msg = post.json.message;
    expect(msg).toMatchObject({ author: { name: 'Bob' }, mentions: [ids.alice] });
    expect((await got(aliceS, 'message:new')).message.id).toBe(msg.id);

    let home = (await call('GET', '/api/v1/team/home', 'alice')).json;
    expect(home.teams[0].channels[0]).toMatchObject({ name: 'General', unread: 1, mentions: 1, notify: 'mentions' });
    await call('POST', `/api/v1/team/channels/${general}/read`, 'alice');
    home = (await call('GET', '/api/v1/team/home', 'alice')).json;
    expect(home.teams[0].channels[0]).toMatchObject({ unread: 0, mentions: 0 });

    // Thread
    const base = `/api/v1/team/channels/${general}/messages`;
    expect((await call('POST', base, 'alice', { body: 'Great, reviewing now', parentId: msg.id })).status).toBe(201);
    const thread = (await call('GET', `${base}/${msg.id}/replies`, 'bob')).json;
    expect(thread.message.replyCount).toBe(1);
    expect(thread.replies.map((r: { body: string }) => r.body)).toEqual(['Great, reviewing now']);
    expect((await call('GET', base, 'bob')).json.items.map((m: { body: string }) => m.body)).toEqual([msg.body]); // replies aren't top-level

    // Edits (own only), reactions, deletion by an owner
    expect((await call('PATCH', `${base}/${msg.id}`, 'alice', { body: 'hacked' })).status).toBe(403);
    expect((await call('PATCH', `${base}/${msg.id}`, 'bob', { body: 'The roadmap is ready' })).json.message.editedAt).not.toBeNull();
    const reacted = await call('PUT', `${base}/${msg.id}/reactions`, 'alice', { emoji: '👍', on: true });
    expect(reacted.json.message.reactions).toEqual([{ emoji: '👍', count: 1, userIds: [ids.alice] }]);
    expect((await call('PUT', `${base}/${msg.id}/reactions`, 'alice', { emoji: 'lol', on: true })).status).toBe(400);
    const spam = (await call('POST', base, 'bob', { body: 'spam' })).json.message;
    expect((await call('DELETE', `${base}/${spam.id}`, 'alice')).json.message).toMatchObject({ deleted: true, body: '' });

    expect((await call('GET', '/api/v1/team/search?q=roadmap', 'bob')).json.items.map((m: { body: string }) => m.body)).toEqual(['The roadmap is ready']);
    expect((await call('GET', '/api/v1/team/search?q=roadmap', 'carol')).json.items).toEqual([]);
    // Carol isn't in the team: she heard nothing.
    expect(carolS.events.filter(([e]) => e === 'message:new')).toEqual([]);

    // Notification level
    expect((await call('PUT', `/api/v1/team/channels/${general}/notify`, 'bob', { notify: 'muted' })).json.notify).toBe('muted');
    expect((await call('GET', '/api/v1/team/home', 'bob')).json.teams[0].channels[0].notify).toBe('muted');
  });

  it('files: channel files go to its folder; chat files are shared with the chat', async () => {
    const target = (await call('GET', `/api/v1/team/channels/${general}/upload-target`, 'bob')).json;
    expect(target.libraryId).toBe(library);
    const file = await upload('bob', target.libraryId, target.parentId, 'spec.txt', Buffer.from('spec'));
    const posted = await call('POST', `/api/v1/team/channels/${general}/messages`, 'bob', { body: 'Spec attached', attachments: [file.id] });
    expect(posted.json.message.attachments).toMatchObject([{ itemId: file.id, name: 'spec.txt', size: 4 }]);
    expect((await call('GET', `/api/v1/drive/items/${file.id}`, 'alice')).status).toBe(200);
    const files = (await call('GET', `/api/v1/team/channels/${general}/files`, 'alice')).json;
    expect(files).toMatchObject({ folder: { libraryId: library }, items: [{ itemId: file.id, name: 'spec.txt', sharedBy: 'Bob' }] });
    // Carol can't attach a file she can't open.
    const chat = (await call('POST', '/api/v1/team/chats', 'alice', { userIds: [ids.carol] })).json.channel;
    expect((await call('POST', `/api/v1/team/channels/${chat.id}/messages`, 'carol', { body: 'x', attachments: [file.id] })).status).toBe(400);

    // One-to-one chat: the same chat every time; files shared with the other person.
    expect((await call('POST', '/api/v1/team/chats', 'carol', { userIds: [ids.alice] })).json.channel.id).toBe(chat.id);
    const chatTarget = (await call('GET', `/api/v1/team/channels/${chat.id}/upload-target`, 'alice')).json;
    const note = await upload('alice', chatTarget.libraryId, chatTarget.parentId, 'note.txt', Buffer.from('for carol'));
    expect((await call('GET', `/api/v1/drive/items/${note.id}`, 'carol')).status).toBe(404);
    await call('POST', `/api/v1/team/channels/${chat.id}/messages`, 'alice', { body: 'Here you go', attachments: [note.id] });
    expect((await call('GET', `/api/v1/drive/items/${note.id}`, 'carol')).json.item.role).toBe('viewer');
    const carolHome = (await call('GET', '/api/v1/team/home', 'carol')).json;
    expect(carolHome.chats).toMatchObject([{ id: chat.id, kind: 'dm', unread: 1, notify: 'all' }]);
    expect(carolHome.chats[0].members.map((m: { name: string }) => m.name).sort()).toEqual(['Alice', 'Carol']);
    // Group chats
    const group = (await call('POST', '/api/v1/team/chats', 'alice', { userIds: [ids.bob, ids.carol], name: 'Lunch' })).json;
    expect(group.channel).toMatchObject({ kind: 'group', name: 'Lunch' });
    expect((await call('POST', `/api/v1/team/channels/${group.channel.id}/members`, 'bob', { remove: [ids.bob] })).status).toBe(200);
    expect((await call('GET', `/api/v1/team/channels/${group.channel.id}`, 'bob')).status).toBe(404);
  });

  it('presence: online from heartbeats, a status you set, broadcast to the organisation', async () => {
    const bobS = await socketFor({ token: tokens.bob! });
    const presence = async () => (await call('GET', `/api/v1/team/presence?ids=${ids.alice},${ids.carol},${ids.admin ?? ids.bob}`, 'bob')).json.items;
    await waitFor(async () => true);
    expect((await presence())[ids.alice!].status).toBe('available'); // her socket is open
    const set = await call('PUT', '/api/v1/team/presence', 'alice', { status: 'dnd', message: 'Heads down' });
    expect(set.json.presence).toMatchObject({ status: 'dnd', manual: true, message: 'Heads down' });
    expect(await got(bobS, 'presence', (p) => p.userId === ids.alice && p.status === 'dnd')).toBeTruthy();
    await call('PUT', '/api/v1/team/presence', 'alice', { status: null });
    expect((await presence())[ids.alice!].status).toBe('available');
    bobS.emit('presence:heartbeat', { active: false });
    await waitFor(async () => (await call('GET', `/api/v1/team/presence?ids=${ids.bob}`, 'alice')).json.items[ids.bob!].status === 'away');
  });

  it('meetings: start in a channel, join (SFU), guests wait in the lobby, the card updates when it ends', async () => {
    const started = await call('POST', '/api/v1/team/meetings', 'alice', { channelId: general });
    expect(started.status, started.text).toBe(201);
    const { code, id: meetingId } = started.json.meeting;
    const card = (await call('GET', `/api/v1/team/channels/${general}/messages`, 'bob')).json.items.at(-1);
    expect(card).toMatchObject({ kind: 'meeting', meta: { code, meetingId } });

    const alice = await socketFor({ token: tokens.alice! });
    const bob = await socketFor({ token: tokens.bob! });
    expect(await ask(alice, 'call:prepare', { code })).toMatchObject({ ok: true, you: { host: true }, lobby: false });
    const joined = await ask(alice, 'call:join', { code });
    expect(joined.ok, joined.error).toBe(true);
    expect(joined.rtpCapabilities.codecs.map((c: { mimeType: string }) => c.mimeType)).toEqual(expect.arrayContaining(['audio/opus', 'video/VP8']));
    const t = await ask(alice, 'call:transport');
    expect(t.transport.iceCandidates[0]).toMatchObject({ ip: '127.0.0.1' });
    const bobJoin = await ask(bob, 'call:join', { code });
    expect(bobJoin).toMatchObject({ ok: true, you: { host: false, name: 'Bob' }, peers: [{ name: 'Alice', host: true }] });
    expect(await got(alice, 'call:peer-joined', (p) => p.name === 'Bob')).toBeTruthy();
    expect((await ask(bob, 'call:mute', { peerId: joined.you.id })).error).toMatch(/organisers/);
    await waitFor(async () => (await call('GET', `/api/v1/team/presence?ids=${ids.bob}`, 'carol')).json.items[ids.bob!].status === 'in_call');
    // Carol isn't in the channel: she can't join its meeting.
    const carol = await socketFor({ token: tokens.carol! });
    expect((await ask(carol, 'call:join', { code })).error).toMatch(/members of a channel/);

    await ask(alice, 'call:leave');
    await ask(bob, 'call:leave');
    const ended = await got(alice, 'message:updated', (p) => p.message.id === card.id && p.message.meta.endedAt);
    expect(ended.message.meta.participants.sort()).toEqual(['Alice', 'Bob']);
    expect(server.ctx.team.media.rooms.size).toBe(0);
    void meetingId;
  }, 30_000);

  it('meeting links from calendar invitations, with guests admitted from the lobby', async () => {
    const cal = (await call('GET', '/api/v1/calendar/calendars', 'alice')).json.items[0];
    const code = 'CalInviteCode123';
    await server.ctx.db.insert(calendarObjects).values({
      calendarId: cal.id,
      uid: 'evt-1',
      href: 'evt-1.ics',
      etag: '"1"',
      ics: `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:evt-1\r\nSUMMARY:Supplier review\r\nURL:${server.baseUrl}/team/meet/${code}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`,
      summary: 'Supplier review',
      syncRevision: 1,
    });
    expect((await call('GET', '/api/v1/team/guest/NotARealCode9', '')).status).toBe(404);
    expect((await call('GET', `/api/v1/team/guest/${code}`, '')).json).toMatchObject({ title: 'Supplier review', organisation: 'Acme', guestAccess: true });
    const pass = (await call('POST', `/api/v1/team/guest/${code}`, '', { name: 'Gina Guest' })).json.token;

    const alice = await socketFor({ token: tokens.alice! });
    const host = await ask(alice, 'call:join', { code });
    expect(host).toMatchObject({ ok: true, you: { host: true }, meeting: { title: 'Supplier review' } });

    const guest = await socketFor({ guest: pass });
    expect(await ask(guest, 'call:prepare', { code })).toMatchObject({ ok: true, lobby: true, you: { guest: true, name: 'Gina Guest' } });
    expect((await ask(guest, 'call:join', { code })).error).toMatch(/admitted/);
    expect(await ask(guest, 'call:knock', { code })).toMatchObject({ ok: true, inMeeting: 1 });
    const lobby = await got(alice, 'call:lobby', (p) => p.waiting.length === 1);
    expect(lobby.waiting[0].name).toBe('Gina Guest');
    expect(await ask(alice, 'call:admit', { guestId: lobby.waiting[0].id, admit: true })).toMatchObject({ ok: true });
    await got(guest, 'call:admitted');
    expect(await ask(guest, 'call:join', { code })).toMatchObject({ ok: true, you: { guest: true, host: false }, peers: [{ name: 'Alice' }] });
    // A guest pass only works for its own meeting.
    expect((await ask(guest, 'call:prepare', { code: 'SomeOtherCode1' })).error).toMatch(/not found/);

    // The host removes the guest.
    const guestPeer = (await got(alice, 'call:peer-joined', (p) => p.guest)).id;
    expect(await ask(alice, 'call:remove', { peerId: guestPeer })).toMatchObject({ ok: true });
    await got(guest, 'call:removed');
    await ask(alice, 'call:leave');

    // Guests can be turned off.
    await call('PUT', '/api/v1/admin/team/settings', 'admin', { guestAccess: false, recording: true, createTeams: 'everyone', maxParticipants: 50 });
    expect((await call('POST', `/api/v1/team/guest/${code}`, '', { name: 'Gina' })).status).toBe(403);
    await call('PUT', '/api/v1/admin/team/settings', 'admin', { guestAccess: true, recording: true, createTeams: 'everyone', maxParticipants: 50 });
  }, 30_000);

  it('admin: settings, every team, archiving; and the ForgeTeam feature switch', async () => {
    const settings = (await call('GET', '/api/v1/admin/team/settings', 'admin')).json;
    expect(settings.settings).toMatchObject({ guestAccess: true, recording: true, createTeams: 'everyone' });
    expect(settings.status.media).toMatchObject({ ports: '43000–43200' });
    const teams = (await call('GET', '/api/v1/admin/team/teams', 'admin')).json.items;
    expect(teams.find((t: { name: string }) => t.name === 'Product')).toMatchObject({ members: 2, channels: 3, owners: ['Alice'] });
    expect((await call('GET', '/api/v1/admin/team/teams', 'bob')).status).toBe(403);

    await call('PUT', '/api/v1/admin/team/settings', 'admin', { guestAccess: true, recording: true, createTeams: 'admins', maxParticipants: 50 });
    expect((await call('POST', '/api/v1/team/teams', 'bob', { name: 'Nope' })).status).toBe(403);
    expect((await call('POST', '/api/v1/team/teams', 'admin', { name: 'Admins only' })).status).toBe(201);

    await call('PATCH', '/api/v1/admin/org', 'admin', { features: { team: false } });
    expect((await call('GET', '/api/v1/team/home', 'alice')).status).toBe(403);
    await call('PATCH', '/api/v1/admin/org', 'admin', { features: { team: true } });
    expect((await call('GET', '/api/v1/team/home', 'alice')).status).toBe(200);
  });
});
