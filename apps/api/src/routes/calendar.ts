import { randomBytes } from 'node:crypto';
import { Type, type Static } from 'typebox';
import {
  accessibleCalendars,
  bumpSequence,
  buildEventIcs,
  delegatedMailboxes,
  setReminders,
  buildReply,
  calendarAccess,
  cancelIcs,
  deleteCalendarObject,
  describeObject,
  ensureDefaultCalendar,
  eventFields,
  expandOccurrences,
  freeBusy,
  objectsInRange,
  putCalendarObject,
  setAttendeePartstat,
  withMethod,
  type PartStat,
} from '@forge/calendar';
import { calendarObjects, calendarPreferences, calendarShares, calendars, groupMembers, groups, orm, resources, users, type MailAddress } from '@forge/db';
import { composeMessage, submitMessage } from '@forge/mail';
import type { AppContext } from '../context';
import { assertPrincipals } from '../services/sharing';
import { badRequest, forbidden, notFound } from '../errors';
import { authenticate } from '../plugins/auth';
import type { App } from '../types';

const { and, asc, eq, inArray, isNull } = orm;
const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });
const HEX = '^#[0-9a-fA-F]{6}$';

const EventBody = Type.Object({
  calendarId: Type.String({ format: 'uuid' }),
  summary: Type.String({ minLength: 1, maxLength: 500 }),
  start: Type.String({ format: 'date-time' }),
  end: Type.String({ format: 'date-time' }),
  allDay: Type.Boolean({ default: false }),
  location: Type.String({ maxLength: 500, default: '' }),
  description: Type.String({ maxLength: 20_000, default: '' }),
  attendees: Type.Array(Type.Object({ email: Type.String({ maxLength: 320 }), name: Type.Optional(Type.String({ maxLength: 200 })) }), { maxItems: 300, default: [] }),
  resourceIds: Type.Array(Type.String({ format: 'uuid' }), { maxItems: 20, default: [] }),
  recurrence: Type.Optional(
    Type.Union([
      Type.Null(),
      Type.Object({
        freq: Type.Union(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].map((f) => Type.Literal(f))),
        interval: Type.Optional(Type.Integer({ minimum: 1, maximum: 99 })),
        count: Type.Optional(Type.Integer({ minimum: 1, maximum: 999 })),
        until: Type.Optional(Type.String({ format: 'date-time' })),
        byDay: Type.Optional(Type.Array(Type.String({ pattern: '^(MO|TU|WE|TH|FR|SA|SU)$' }), { maxItems: 7 })),
      }),
    ]),
  ),
  addMeeting: Type.Boolean({ default: false }),
  reminderMinutes: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 40320 }), Type.Null()])),
  transparent: Type.Boolean({ default: false }),
});

export function calendarRoutes(app: App, ctx: AppContext) {
  const { db } = ctx;
  app.addHook('preHandler', authenticate(ctx));

  const me = (req: { principal: { user: { id: string; email: string; displayName: string; orgId: string; timezone: string | null } } | null }) => req.principal!.user;

  const requireAccess = async (userId: string, calendarId: string, need: 'read' | 'write' | 'owner') => {
    const access = await calendarAccess(db, userId, calendarId);
    const rank = { freebusy: 0, read: 1, write: 2, owner: 3 } as const;
    if (!access) throw notFound('Calendar');
    if (rank[access] < rank[need]) throw forbidden('You do not have access to change this calendar');
    return access;
  };

  /** Owners manage their calendars; full-access members manage a shared mailbox's calendars. */
  const requireManage = async (userId: string, calendarId: string) => {
    const [cal] = await db.select().from(calendars).where(eq(calendars.id, calendarId)).limit(1);
    if (!cal) throw notFound('Calendar');
    if (cal.ownerType === 'user' && cal.ownerId === userId) return cal;
    if (cal.ownerType === 'user' && (await delegatedMailboxes(db, userId)).some((d) => d.ownerId === cal.ownerId && d.access === 'full')) return cal;
    await requireAccess(userId, calendarId, 'owner');
    return cal;
  };

  const loadObject = async (userId: string, id: string, need: 'read' | 'write' = 'read') => {
    const [obj] = await db.select().from(calendarObjects).where(and(eq(calendarObjects.id, id), isNull(calendarObjects.deletedAt))).limit(1);
    if (!obj) throw notFound('Event');
    await requireAccess(userId, obj.calendarId, need);
    return obj;
  };

  /** Mail an iTIP message (REQUEST / CANCEL / REPLY) as the user. */
  /**
   * Who acts in a calendar. In a shared mailbox's calendar members act as the
   * mailbox; without "Send as" they are recorded as the sender (on behalf).
   */
  interface Actor {
    userId: string;
    email: string;
    displayName: string;
    sender?: MailAddress;
  }
  const actorFor = async (user: { id: string; email: string; displayName: string }, calendarId: string): Promise<Actor> => {
    const self: Actor = { userId: user.id, email: user.email, displayName: user.displayName };
    const [cal] = await db.select({ ownerType: calendars.ownerType, ownerId: calendars.ownerId }).from(calendars).where(eq(calendars.id, calendarId)).limit(1);
    if (!cal || cal.ownerType !== 'user' || cal.ownerId === user.id) return self;
    const grant = (await delegatedMailboxes(db, user.id)).find((d) => d.ownerId === cal.ownerId);
    if (!grant) return self;
    return { userId: user.id, email: grant.address, displayName: grant.name, sender: grant.sendAs ? undefined : { name: user.displayName, address: user.email } };
  };

  const sendItip = async (from: Actor, to: string[], method: 'REQUEST' | 'CANCEL' | 'REPLY', ics: string, subject: string, text: string) => {
    if (!to.length) return;
    const { raw } = await composeMessage({
      from: { name: from.displayName, address: from.email },
      sender: from.sender,
      to: to.map((address) => ({ name: '', address })),
      subject,
      text,
      calendar: { method, content: withMethod(ics, method) },
    });
    await submitMessage(ctx.mail, { userId: from.userId, raw, envelopeFrom: from.email, recipients: to, source: 'system' });
  };

  const describeWhen = (start: Date, allDay: boolean) =>
    allDay ? start.toDateString() : start.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';

  // -------------------------------------------------------------------------
  // Calendars
  // -------------------------------------------------------------------------

  app.get('/api/v1/calendar/calendars', { schema: { tags: ['calendar'], summary: 'Calendars you can see' } }, async (req) => {
    const user = me(req);
    await ensureDefaultCalendar(db, user);
    const list = await accessibleCalendars(db, user.id);
    // Name the owner of every calendar that is not the user's own, straight from the owning
    // account: people, shared mailboxes (users.kind = 'shared'), groups and rooms.
    const userIds = [...new Set(list.filter((c) => c.ownerType === 'user' && c.ownerId !== user.id).map((c) => c.ownerId))];
    const groupIds = [...new Set(list.filter((c) => c.ownerType === 'group').map((c) => c.ownerId))];
    const resourceIds = [...new Set(list.filter((c) => c.ownerType === 'resource').map((c) => c.ownerId))];
    const owners = new Map<string, { name: string; email: string | null; kind: 'shared' | 'user' | 'group' | 'resource' }>();
    if (userIds.length)
      for (const u of await db.select({ id: users.id, name: users.displayName, email: users.email, kind: users.kind }).from(users).where(inArray(users.id, userIds)))
        owners.set(u.id, { name: u.name, email: u.email, kind: u.kind === 'shared' ? 'shared' : 'user' });
    if (groupIds.length)
      for (const g of await db.select({ id: groups.id, name: groups.name, email: groups.email }).from(groups).where(inArray(groups.id, groupIds)))
        owners.set(g.id, { name: g.name, email: g.email, kind: 'group' });
    const reminderPrefs = new Map(
      (await db.select().from(calendarPreferences).where(eq(calendarPreferences.userId, user.id))).map((p) => [p.calendarId, p.reminders]),
    );
    const fullShared = new Set((await delegatedMailboxes(db, user.id)).filter((d) => d.access === 'full').map((d) => d.ownerId));
    if (resourceIds.length)
      for (const r of await db.select({ id: resources.id, name: resources.name, email: resources.email }).from(resources).where(inArray(resources.id, resourceIds)))
        owners.set(r.id, { name: r.name, email: r.email, kind: 'resource' });
    return {
      items: list
        .map((c) => {
          const mine = c.ownerType === 'user' && c.ownerId === user.id;
          const owner = mine ? null : owners.get(c.ownerId);
          return {
            id: c.id,
            name: c.name,
            color: c.color,
            description: c.description,
            isDefault: c.isDefault && mine,
            ownerType: owner?.kind ?? c.ownerType,
            owner: owner?.name ?? null,
            ownerEmail: owner?.email ?? null,
            access: c.access,
            reminders: reminderPrefs.get(c.id) ?? mine,
            canShare: mine || (owner?.kind === 'shared' && fullShared.has(c.ownerId)),
          };
        })
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name)),
    };
  });

  app.post(
    '/api/v1/calendar/calendars',
    {
      schema: {
        tags: ['calendar'],
        summary: 'Create a personal calendar, or a team calendar for a group',
        body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 200 }), color: Type.Optional(Type.String({ pattern: HEX })), groupId: Type.Optional(Type.String({ format: 'uuid' })) }),
      },
    },
    async (req, reply) => {
      const user = me(req);
      const { name, color, groupId } = req.body;
      if (groupId) {
        const [membership] = await db.select().from(groupMembers).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, user.id))).limit(1);
        if (membership?.role !== 'owner' && !req.principal!.permissions.has('groups:manage')) throw forbidden('Only group owners can create a team calendar');
      }
      const [cal] = await db
        .insert(calendars)
        .values({ orgId: user.orgId, ownerType: groupId ? 'group' : 'user', ownerId: groupId ?? user.id, name, color: color ?? '#0ea5e9', timezone: user.timezone ?? 'UTC' })
        .returning();
      reply.code(201);
      return { calendar: cal };
    },
  );

  app.patch(
    '/api/v1/calendar/calendars/:id',
    {
      schema: {
        tags: ['calendar'],
        summary: 'Rename or recolour a calendar',
        params: IdParams,
        body: Type.Object({ name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), color: Type.Optional(Type.String({ pattern: HEX })), description: Type.Optional(Type.String({ maxLength: 2000 })) }),
      },
    },
    async (req) => {
      await requireAccess(me(req).id, req.params.id, 'write');
      const [cal] = await db.update(calendars).set(req.body).where(eq(calendars.id, req.params.id)).returning();
      return { calendar: cal };
    },
  );

  app.delete('/api/v1/calendar/calendars/:id', { schema: { tags: ['calendar'], summary: 'Delete a calendar', params: IdParams } }, async (req) => {
    await requireManage(me(req).id, req.params.id);
    const [cal] = await db.select().from(calendars).where(eq(calendars.id, req.params.id)).limit(1);
    if (cal?.isDefault) throw badRequest('Your default calendar cannot be deleted');
    await db.delete(calendars).where(eq(calendars.id, req.params.id));
    return { ok: true };
  });

  app.put(
    '/api/v1/calendar/calendars/:id/reminders',
    {
      schema: {
        tags: ['calendar'],
        summary: 'Whether this calendar’s reminders reach your devices (per person)',
        params: IdParams,
        body: Type.Object({ enabled: Type.Boolean() }),
      },
    },
    async (req) => {
      await requireAccess(me(req).id, req.params.id, 'read');
      await setReminders(db, me(req).id, req.params.id, req.body.enabled);
      return { ok: true };
    },
  );

  app.put(
    '/api/v1/calendar/calendars/:id/shares',
    {
      schema: {
        tags: ['calendar'],
        summary: 'Replace who a calendar is shared with',
        params: IdParams,
        body: Type.Object({
          shares: Type.Array(
            Type.Object({
              principalType: Type.Union([Type.Literal('user'), Type.Literal('group')]),
              principalId: Type.String({ format: 'uuid' }),
              access: Type.Union([Type.Literal('freebusy'), Type.Literal('read'), Type.Literal('write')]),
            }),
            { maxItems: 200 },
          ),
        }),
      },
    },
    async (req) => {
      const cal = await requireManage(me(req).id, req.params.id);
      await assertPrincipals(req.body.shares, cal.ownerId);
      await db.transaction(async (tx) => {
        await tx.delete(calendarShares).where(eq(calendarShares.calendarId, req.params.id));
        if (req.body.shares.length) await tx.insert(calendarShares).values(req.body.shares.map((s) => ({ ...s, calendarId: req.params.id })));
      });
      return { ok: true };
    },
  );

  app.get('/api/v1/calendar/calendars/:id/shares', { schema: { tags: ['calendar'], summary: 'Who a calendar is shared with', params: IdParams } }, async (req) => {
    await requireManage(me(req).id, req.params.id);
    const rows = await db.select().from(calendarShares).where(eq(calendarShares.calendarId, req.params.id));
    const userIds = rows.filter((r) => r.principalType === 'user').map((r) => r.principalId);
    const groupIds = rows.filter((r) => r.principalType === 'group').map((r) => r.principalId);
    const names = new Map<string, string>([
      ...(userIds.length ? await db.select({ id: users.id, n: users.displayName }).from(users).where(inArray(users.id, userIds)) : []).map((u) => [u.id, u.n] as [string, string]),
      ...(groupIds.length ? await db.select({ id: groups.id, n: groups.name }).from(groups).where(inArray(groups.id, groupIds)) : []).map((g) => [g.id, g.n] as [string, string]),
    ]);
    return { items: rows.map((r) => ({ ...r, name: names.get(r.principalId) ?? 'Unknown' })) };
  });

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  app.get(
    '/api/v1/calendar/events',
    {
      schema: {
        tags: ['calendar'],
        summary: 'Event occurrences in a time range (recurrences expanded)',
        querystring: Type.Object({ from: Type.String({ format: 'date-time' }), to: Type.String({ format: 'date-time' }), calendarIds: Type.Optional(Type.String({ maxLength: 5000 })) }),
      },
    },
    async (req) => {
      const user = me(req);
      const from = new Date(req.query.from);
      const to = new Date(req.query.to);
      if (to.getTime() - from.getTime() > 400 * 86400_000) throw badRequest('Range is too large');
      await ensureDefaultCalendar(db, user);
      const visible = await accessibleCalendars(db, user.id);
      const wanted = req.query.calendarIds ? new Set(req.query.calendarIds.split(',')) : null;
      const cals = visible.filter((c) => !wanted || wanted.has(c.id));
      const objects = await objectsInRange(db, cals.map((c) => c.id), from, to);
      const delegated = new Map((await delegatedMailboxes(db, user.id)).map((d) => [d.ownerId, d.address]));
      // In a shared mailbox's calendar, "me" is the mailbox.
      const identity = (c: (typeof cals)[number]) => (c.ownerType === 'user' && delegated.get(c.ownerId)) || user.email;
      const items = [];
      for (const obj of objects) {
        const cal = cals.find((c) => c.id === obj.calendarId)!;
        for (const occ of expandOccurrences(obj.ics, from, to)) {
          const self = identity(cal);
          const mine = occ.attendees.find((a) => a.email === self);
          const freebusyOnly = cal.access === 'freebusy';
          items.push({
            objectId: obj.id,
            calendarId: obj.calendarId,
            color: cal.color,
            uid: occ.uid,
            recurrenceId: occ.recurrenceId,
            start: occ.start.toISOString(),
            end: occ.end.toISOString(),
            allDay: occ.allDay,
            summary: freebusyOnly ? 'Busy' : occ.summary,
            location: freebusyOnly ? '' : occ.location,
            status: occ.status,
            organizer: freebusyOnly ? null : occ.organizer,
            isOrganizer: !occ.organizer || occ.organizer === self,
            myStatus: mine?.partstat ?? null,
            attendeeCount: occ.attendees.length,
            meetingUrl: freebusyOnly ? null : occ.meetingUrl,
            recurring: obj.recurring,
            canEdit: cal.access === 'owner' || cal.access === 'write',
          });
        }
      }
      return { items: items.sort((a, b) => a.start.localeCompare(b.start)) };
    },
  );

  app.get('/api/v1/calendar/events/:id', { schema: { tags: ['calendar'], summary: 'Full details of an event', params: IdParams } }, async (req) => {
    const user = me(req);
    const obj = await loadObject(user.id, req.params.id);
    const access = await calendarAccess(db, user.id, obj.calendarId);
    if (access === 'freebusy') throw forbidden();
    return { event: { id: obj.id, calendarId: obj.calendarId, ...eventFields(obj.ics), canEdit: access === 'owner' || access === 'write' } };
  });

  const buildInput = async (user: Actor, b: Static<typeof EventBody>, existing?: { uid: string; sequence: number; meetingUrl: string | null; attendees: { email: string; partstat: PartStat }[] }) => {
    const start = new Date(b.start);
    const end = new Date(b.end);
    if (end <= start) throw badRequest('The event must end after it starts');
    const rooms = b.resourceIds.length ? await db.select().from(resources).where(inArray(resources.id, b.resourceIds)) : [];
    const attendeeEmails = [...new Map(b.attendees.map((a) => [a.email.trim().toLowerCase(), a.name ?? ''])).entries()].filter(([e]) => e !== user.email);
    const hasGuests = attendeeEmails.length > 0 || rooms.length > 0;
    const prev = new Map(existing?.attendees.map((a) => [a.email, a.partstat]) ?? []);
    return {
      uid: existing?.uid,
      sequence: existing ? existing.sequence + 1 : 0,
      summary: b.summary,
      start,
      end,
      allDay: b.allDay,
      location: [b.location, ...rooms.map((r) => r.name)].filter(Boolean).join(', '),
      description: b.description,
      recurrence: b.recurrence ? { ...b.recurrence, until: b.recurrence.until ? new Date(b.recurrence.until) : undefined } : null,
      transparent: b.transparent,
      reminderMinutes: b.reminderMinutes ?? null,
      meetingUrl: b.addMeeting ? (existing?.meetingUrl ?? `${ctx.config.publicUrl}/team/meet/${randomBytes(9).toString('base64url')}`) : null,
      organizer: hasGuests ? { email: user.email, name: user.displayName, sentBy: user.sender?.address } : null,
      attendees: hasGuests
        ? [
            { email: user.email, name: user.displayName, partstat: 'ACCEPTED' as PartStat, rsvp: false },
            ...attendeeEmails.map(([email, name]) => ({ email, name, partstat: prev.get(email) ?? ('NEEDS-ACTION' as PartStat) })),
            ...rooms.map((r) => ({ email: r.email, name: r.name, cutype: 'ROOM' as const, partstat: prev.get(r.email) ?? ('NEEDS-ACTION' as PartStat) })),
          ]
        : [],
    };
  };

  const inviteText = (b: { summary: string; location?: string; description?: string; meetingUrl?: string | null }, start: Date, allDay: boolean, organizer: string) =>
    [`${organizer} has invited you to: ${b.summary}`, `When: ${describeWhen(start, allDay)}`, b.location ? `Where: ${b.location}` : '', b.meetingUrl ? `Join online: ${b.meetingUrl}` : '', '', b.description ?? '']
      .filter((l) => l !== '')
      .join('\n');

  app.post('/api/v1/calendar/events', { schema: { tags: ['calendar'], summary: 'Create an event and send invitations', body: EventBody } }, async (req, reply) => {
    const user = me(req);
    const b = req.body as Static<typeof EventBody>;
    await requireAccess(user.id, b.calendarId, 'write');
    const actor = await actorFor(user, b.calendarId);
    const input = await buildInput(actor, b);
    const ics = buildEventIcs(input);
    const info = describeObject(ics);
    const { object } = await putCalendarObject(db, b.calendarId, `${info.uid.replace(/[^A-Za-z0-9@._-]/g, '_')}.ics`, ics);
    const guests = info.attendees.filter((a) => a.email !== actor.email).map((a) => a.email);
    await sendItip(actor, guests, 'REQUEST', ics, `Invitation: ${b.summary}`, inviteText({ ...b, meetingUrl: input.meetingUrl }, input.start, b.allDay, actor.displayName));
    void ctx.bus?.publish('calendar.changed', { userIds: [user.id] }).catch(() => {});
    reply.code(201);
    return { event: { id: object.id, uid: info.uid } };
  });

  app.put('/api/v1/calendar/events/:id', { schema: { tags: ['calendar'], summary: 'Update an event (organiser) and notify attendees', params: IdParams, body: EventBody } }, async (req) => {
    const user = me(req);
    const b = req.body as Static<typeof EventBody>;
    const obj = await loadObject(user.id, req.params.id, 'write');
    const current = eventFields(obj.ics);
    const actor = await actorFor(user, obj.calendarId);
    if (current.organizer && current.organizer !== actor.email) throw forbidden('Only the organiser can change this meeting');
    const input = await buildInput(actor, b, { uid: current.uid, sequence: current.sequence, meetingUrl: current.meetingUrl, attendees: current.attendees });
    const ics = buildEventIcs(input);
    await putCalendarObject(db, obj.calendarId, obj.href, ics);
    if (b.calendarId !== obj.calendarId) {
      await requireAccess(user.id, b.calendarId, 'write');
      await putCalendarObject(db, b.calendarId, obj.href, ics);
      await deleteCalendarObject(db, obj.calendarId, obj.href);
    }
    const now = new Set(input.attendees.map((a) => a.email));
    const removed = current.attendees.map((a) => a.email).filter((e) => !now.has(e) && e !== actor.email);
    const guests = [...now].filter((e) => e !== actor.email);
    await sendItip(actor, guests, 'REQUEST', ics, `Updated invitation: ${b.summary}`, inviteText({ ...b, meetingUrl: input.meetingUrl }, input.start, b.allDay, actor.displayName));
    if (removed.length) await sendItip(actor, removed, 'CANCEL', cancelIcs(obj.ics), `Cancelled: ${current.summary}`, `${actor.displayName} removed you from this meeting.`);
    return { ok: true };
  });

  app.delete('/api/v1/calendar/events/:id', { schema: { tags: ['calendar'], summary: 'Delete an event (cancels it for attendees if you organise it)', params: IdParams } }, async (req) => {
    const user = me(req);
    const obj = await loadObject(user.id, req.params.id, 'write');
    const info = describeObject(obj.ics);
    const actor = await actorFor(user, obj.calendarId);
    if (info.attendees.length && (!info.organizer || info.organizer === actor.email)) {
      const guests = info.attendees.filter((a) => a.email !== actor.email).map((a) => a.email);
      await sendItip(actor, guests, 'CANCEL', cancelIcs(obj.ics), `Cancelled: ${info.summary}`, `${actor.displayName} cancelled this meeting.`);
    } else if (info.organizer && info.attendees.some((a) => a.email === actor.email)) {
      const replyIcs = buildReply(obj.ics, actor.email, 'DECLINED', actor.displayName);
      await sendItip(actor, [info.organizer], 'REPLY', replyIcs, `Declined: ${info.summary}`, `${actor.displayName} declined.`);
    }
    await deleteCalendarObject(db, obj.calendarId, obj.href);
    return { ok: true };
  });

  app.post(
    '/api/v1/calendar/events/:id/rsvp',
    {
      schema: {
        tags: ['calendar'],
        summary: 'Accept, tentatively accept or decline an invitation',
        params: IdParams,
        body: Type.Object({ status: Type.Union([Type.Literal('ACCEPTED'), Type.Literal('TENTATIVE'), Type.Literal('DECLINED')]) }),
      },
    },
    async (req) => {
      const user = me(req);
      const obj = await loadObject(user.id, req.params.id, 'write');
      const info = describeObject(obj.ics);
      const actor = await actorFor(user, obj.calendarId);
      if (!info.attendees.some((a) => a.email === actor.email)) throw badRequest('You are not an attendee of this event');
      const { ics } = setAttendeePartstat(obj.ics, actor.email, req.body.status);
      await putCalendarObject(db, obj.calendarId, obj.href, ics);
      if (info.organizer && info.organizer !== actor.email) {
        const verb = { ACCEPTED: 'Accepted', TENTATIVE: 'Tentative', DECLINED: 'Declined' }[req.body.status];
        await sendItip(actor, [info.organizer], 'REPLY', buildReply(ics, actor.email, req.body.status, actor.displayName), `${verb}: ${info.summary}`, `${actor.sender ? `${actor.sender.name} on behalf of ` : ''}${actor.displayName} ${verb.toLowerCase()} this invitation.`);
      }
      return { ok: true };
    },
  );

  app.post(
    '/api/v1/calendar/freebusy',
    {
      schema: {
        tags: ['calendar'],
        summary: 'Busy times for people and rooms',
        body: Type.Object({ emails: Type.Array(Type.String({ maxLength: 320 }), { minItems: 1, maxItems: 50 }), from: Type.String({ format: 'date-time' }), to: Type.String({ format: 'date-time' }) }),
      },
    },
    async (req) => {
      const from = new Date(req.body.from);
      const to = new Date(req.body.to);
      if (to.getTime() - from.getTime() > 62 * 86400_000) throw badRequest('Range is too large');
      return { busy: await freeBusy(db, req.body.emails.map((e) => e.toLowerCase()), from, to, me(req).id) };
    },
  );

  app.get('/api/v1/calendar/resources', { schema: { tags: ['calendar'], summary: 'Bookable rooms and equipment' } }, async (req) => ({
    items: await db.select().from(resources).where(eq(resources.orgId, req.principal!.orgId)).orderBy(asc(resources.name)),
  }));
}
