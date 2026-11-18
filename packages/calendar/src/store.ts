import { createHash } from 'node:crypto';
import {
  addressBookShares,
  addressBooks,
  calendarObjects,
  calendarPreferences,
  calendarShares,
  calendars,
  contacts,
  groupMembers,
  mailboxPermissions,
  orm,
  resources,
  userAliases,
  users,
  type Calendar,
  type CalendarObject,
  type Database,
  type Resource,
} from '@forge/db';
import { buildReply, describeObject, expandOccurrences, setAttendeePartstat, withMethod, type PartStat } from './ics';
import { parseVCard } from './vcard';

const { and, eq, gt, inArray, isNull, lt, or, sql } = orm;

export class PreconditionFailedError extends Error {
  constructor(message = 'Precondition failed') {
    super(message);
    this.name = 'PreconditionFailedError';
  }
}

export class UidConflictError extends Error {
  constructor(readonly existingHref: string) {
    super('An object with this UID already exists in the collection');
    this.name = 'UidConflictError';
  }
}

export const etagOf = (data: string) => `"${createHash('sha256').update(data).digest('hex').slice(0, 32)}"`;

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------

export async function ensureDefaultCalendar(db: Database, user: { id: string; orgId: string; timezone?: string | null }): Promise<Calendar> {
  const find = () =>
    db
      .select()
      .from(calendars)
      .where(and(eq(calendars.ownerType, 'user'), eq(calendars.ownerId, user.id), eq(calendars.isDefault, true)))
      .limit(1);
  const [existing] = await find();
  if (existing) return existing;
  // Concurrent first requests race here; the partial unique index lets only one win.
  await db
    .insert(calendars)
    .values({ orgId: user.orgId, ownerType: 'user', ownerId: user.id, name: 'Calendar', isDefault: true, timezone: user.timezone ?? 'UTC' })
    .onConflictDoNothing();
  const [created] = await find();
  return created!;
}

export async function ensureResourceCalendar(db: Database, resource: Resource): Promise<Calendar> {
  const find = () =>
    db
      .select()
      .from(calendars)
      .where(and(eq(calendars.ownerType, 'resource'), eq(calendars.ownerId, resource.id), eq(calendars.isDefault, true)))
      .limit(1);
  const [existing] = await find();
  if (existing) return existing;
  await db
    .insert(calendars)
    .values({ orgId: resource.orgId, ownerType: 'resource', ownerId: resource.id, name: resource.name, isDefault: true, color: '#0d9488' })
    .onConflictDoNothing();
  const [created] = await find();
  return created!;
}

// ---------------------------------------------------------------------------
// Delegated (shared) mailboxes: one set of grants covers mail, calendar and contacts
// ---------------------------------------------------------------------------

export interface DelegatedMailbox {
  ownerId: string;
  orgId: string;
  address: string;
  name: string;
  /** "full" = read/write, "read" = read-only, "none" = send rights only. */
  access: 'none' | 'read' | 'full';
  sendAs: boolean;
  sendOnBehalf: boolean;
}

const MAIL_RANK = { none: 0, read: 1, full: 2 } as const;

/** Mailboxes (normally shared mailboxes) a user has been granted rights on, directly or via groups. */
export async function delegatedMailboxes(db: Database, userId: string): Promise<DelegatedMailbox[]> {
  const groupIds = (await db.select({ id: groupMembers.groupId }).from(groupMembers).where(eq(groupMembers.userId, userId))).map((g) => g.id);
  const rows = await db
    .select({ perm: mailboxPermissions, owner: users })
    .from(mailboxPermissions)
    .innerJoin(users, eq(users.id, mailboxPermissions.ownerId))
    .where(
      and(
        eq(users.status, 'active'),
        or(
          and(eq(mailboxPermissions.principalType, 'user'), eq(mailboxPermissions.principalId, userId)),
          groupIds.length ? and(eq(mailboxPermissions.principalType, 'group'), inArray(mailboxPermissions.principalId, groupIds)) : undefined,
        ),
      ),
    );
  const merged = new Map<string, DelegatedMailbox>();
  for (const { perm, owner } of rows) {
    if (owner.id === userId) continue;
    const prev = merged.get(owner.id);
    merged.set(owner.id, {
      ownerId: owner.id,
      orgId: owner.orgId,
      address: owner.email,
      name: owner.displayName,
      access: prev && MAIL_RANK[prev.access] >= MAIL_RANK[perm.access] ? prev.access : perm.access,
      sendAs: (prev?.sendAs ?? false) || perm.sendAs,
      sendOnBehalf: (prev?.sendOnBehalf ?? false) || perm.sendOnBehalf,
    });
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export type CalendarAccess = 'owner' | 'write' | 'read' | 'freebusy';

const RANK: Record<CalendarAccess, number> = { freebusy: 0, read: 1, write: 2, owner: 3 };

/** Every calendar a user can see, with their access level. */
export async function accessibleCalendars(db: Database, userId: string): Promise<(Calendar & { access: CalendarAccess })[]> {
  const groupIds = (await db.select({ id: groupMembers.groupId }).from(groupMembers).where(eq(groupMembers.userId, userId))).map((g) => g.id);
  const own = await db.select().from(calendars).where(and(eq(calendars.ownerType, 'user'), eq(calendars.ownerId, userId)));
  // Group (team) calendars are writable by members.
  const team = groupIds.length ? await db.select().from(calendars).where(and(eq(calendars.ownerType, 'group'), inArray(calendars.ownerId, groupIds))) : [];
  const shared = await db
    .select({ calendar: calendars, access: calendarShares.access })
    .from(calendarShares)
    .innerJoin(calendars, eq(calendars.id, calendarShares.calendarId))
    .where(
      or(
        and(eq(calendarShares.principalType, 'user'), eq(calendarShares.principalId, userId)),
        groupIds.length ? and(eq(calendarShares.principalType, 'group'), inArray(calendarShares.principalId, groupIds)) : sql`false`,
      ),
    );
  const map = new Map<string, Calendar & { access: CalendarAccess }>();
  const add = (c: Calendar, access: CalendarAccess) => {
    const prev = map.get(c.id);
    if (!prev || RANK[access] > RANK[prev.access]) map.set(c.id, { ...c, access });
  };
  own.forEach((c) => add(c, 'owner'));
  team.forEach((c) => add(c, 'write'));
  shared.forEach((s) => add(s.calendar, s.access));
  // Shared mailboxes: full access → write, read → read, on all of the mailbox's calendars.
  const delegated = (await delegatedMailboxes(db, userId)).filter((d) => d.access !== 'none');
  for (const d of delegated) {
    await ensureDefaultCalendar(db, { id: d.ownerId, orgId: d.orgId });
    const cals = await db.select().from(calendars).where(and(eq(calendars.ownerType, 'user'), eq(calendars.ownerId, d.ownerId)));
    cals.forEach((c) => add(c, d.access === 'full' ? 'write' : 'read'));
  }
  return [...map.values()];
}

export async function calendarAccess(db: Database, userId: string, calendarId: string): Promise<CalendarAccess | null> {
  return (await accessibleCalendars(db, userId)).find((c) => c.id === calendarId)?.access ?? null;
}

async function bumpCalendarRevision(db: Database, calendarId: string): Promise<number> {
  const [row] = await db
    .update(calendars)
    .set({ syncRevision: sql`${calendars.syncRevision} + 1` })
    .where(eq(calendars.id, calendarId))
    .returning({ rev: calendars.syncRevision });
  return row?.rev ?? 0;
}

export interface PutOptions {
  /** Expected ETag (If-Match); "*" means must exist. */
  ifMatch?: string | null;
  /** If-None-Match: "*" means must not exist. */
  ifNoneMatch?: string | null;
}

/** Create or replace a calendar object (CalDAV PUT semantics). */
export async function putCalendarObject(db: Database, calendarId: string, href: string, ics: string, opts: PutOptions = {}): Promise<{ object: CalendarObject; created: boolean }> {
  const info = describeObject(ics);
  const stored = withMethod(ics, null);
  const [existing] = await db
    .select()
    .from(calendarObjects)
    .where(and(eq(calendarObjects.calendarId, calendarId), eq(calendarObjects.href, href)))
    .limit(1);
  const live = existing && !existing.deletedAt ? existing : null;
  if (opts.ifNoneMatch === '*' && live) throw new PreconditionFailedError('Object already exists');
  if (opts.ifMatch && (!live || (opts.ifMatch !== '*' && opts.ifMatch !== live.etag))) throw new PreconditionFailedError('ETag does not match');
  const [sameUid] = await db
    .select({ href: calendarObjects.href })
    .from(calendarObjects)
    .where(and(eq(calendarObjects.calendarId, calendarId), eq(calendarObjects.uid, info.uid), isNull(calendarObjects.deletedAt)))
    .limit(1);
  if (sameUid && sameUid.href !== href) throw new UidConflictError(sameUid.href);

  const rev = await bumpCalendarRevision(db, calendarId);
  const values = {
    calendarId,
    href,
    uid: info.uid,
    etag: etagOf(stored),
    ics: stored,
    componentType: info.componentType,
    startsAt: info.startsAt,
    endsAt: info.endsAt,
    recurring: info.recurring,
    summary: info.summary.slice(0, 500),
    organizer: info.organizer,
    transparent: info.transparent,
    syncRevision: rev,
    deletedAt: null,
    updatedAt: new Date(),
  };
  const [object] = await db
    .insert(calendarObjects)
    .values(values)
    .onConflictDoUpdate({ target: [calendarObjects.calendarId, calendarObjects.href], set: values })
    .returning();
  return { object: object!, created: !live };
}

/** Delete an object, leaving a tombstone so sync-collection reports it. */
export async function deleteCalendarObject(db: Database, calendarId: string, href: string, ifMatch?: string | null): Promise<boolean> {
  const [existing] = await db
    .select()
    .from(calendarObjects)
    .where(and(eq(calendarObjects.calendarId, calendarId), eq(calendarObjects.href, href), isNull(calendarObjects.deletedAt)))
    .limit(1);
  if (!existing) return false;
  if (ifMatch && ifMatch !== '*' && ifMatch !== existing.etag) throw new PreconditionFailedError();
  const rev = await bumpCalendarRevision(db, calendarId);
  await db
    .update(calendarObjects)
    .set({ deletedAt: new Date(), ics: '', etag: '', syncRevision: rev, uid: `deleted:${existing.id}` })
    .where(eq(calendarObjects.id, existing.id));
  return true;
}

export async function findByUid(db: Database, calendarIds: string[], uid: string): Promise<CalendarObject | null> {
  if (!calendarIds.length) return null;
  const [row] = await db
    .select()
    .from(calendarObjects)
    .where(and(inArray(calendarObjects.calendarId, calendarIds), eq(calendarObjects.uid, uid), isNull(calendarObjects.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** Live objects whose span overlaps [from, to). */
export async function objectsInRange(db: Database, calendarIds: string[], from: Date, to: Date): Promise<CalendarObject[]> {
  if (!calendarIds.length) return [];
  return db
    .select()
    .from(calendarObjects)
    .where(
      and(
        inArray(calendarObjects.calendarId, calendarIds),
        isNull(calendarObjects.deletedAt),
        or(isNull(calendarObjects.startsAt), lt(calendarObjects.startsAt, to)),
        or(isNull(calendarObjects.endsAt), gt(calendarObjects.endsAt, from)),
      ),
    );
}

// ---------------------------------------------------------------------------
// Free/busy and directory lookups
// ---------------------------------------------------------------------------

export type Principal = { kind: 'user'; id: string; orgId: string; email: string; name: string } | { kind: 'resource'; resource: Resource };

/** Resolve an address to a user (primary or alias) or a bookable resource. */
export async function resolvePrincipal(db: Database, email: string): Promise<Principal | null> {
  const addr = email.trim().toLowerCase();
  const [u] = await db.select().from(users).where(and(eq(users.email, addr), eq(users.status, 'active'))).limit(1);
  if (u) return { kind: 'user', id: u.id, orgId: u.orgId, email: u.email, name: u.displayName };
  const [alias] = await db
    .select({ user: users })
    .from(userAliases)
    .innerJoin(users, eq(users.id, userAliases.userId))
    .where(and(eq(userAliases.address, addr), eq(users.status, 'active')))
    .limit(1);
  if (alias) return { kind: 'user', id: alias.user.id, orgId: alias.user.orgId, email: alias.user.email, name: alias.user.displayName };
  const [r] = await db.select().from(resources).where(eq(resources.email, addr)).limit(1);
  return r ? { kind: 'resource', resource: r } : null;
}

export interface BusyBlock {
  start: string;
  end: string;
  status: 'busy' | 'tentative';
  /** Only present when the viewer may read the calendar. */
  summary?: string;
  location?: string;
}

/** Busy periods for internal people/rooms; unknown addresses return null. */
export async function freeBusy(db: Database, emails: string[], from: Date, to: Date, viewerId?: string): Promise<Record<string, BusyBlock[] | null>> {
  const result: Record<string, BusyBlock[] | null> = {};
  // Calendars the viewer may read get titles and locations; everything else is busy/free only.
  const readable = new Set(viewerId ? (await accessibleCalendars(db, viewerId)).filter((c) => c.access !== 'freebusy').map((c) => c.id) : []);
  for (const email of emails) {
    const p = await resolvePrincipal(db, email);
    if (!p) {
      result[email] = null;
      continue;
    }
    const ownerId = p.kind === 'user' ? p.id : p.resource.id;
    const own = await db
      .select({ id: calendars.id })
      .from(calendars)
      .where(and(eq(calendars.ownerType, p.kind), eq(calendars.ownerId, ownerId)));
    const selfEmail = p.kind === 'user' ? p.email : p.resource.email;
    const blocks: BusyBlock[] = [];
    for (const obj of await objectsInRange(db, own.map((c) => c.id), from, to)) {
      const details = readable.has(obj.calendarId);
      for (const occ of expandOccurrences(obj.ics, from, to)) {
        if (occ.transparent || occ.status === 'CANCELLED') continue;
        const me = occ.attendees.find((a) => a.email === selfEmail);
        if (me?.partstat === 'DECLINED') continue;
        blocks.push({
          start: occ.start.toISOString(),
          end: occ.end.toISOString(),
          status: me?.partstat === 'TENTATIVE' || occ.status === 'TENTATIVE' ? 'tentative' : 'busy',
          ...(details ? { summary: occ.summary, location: occ.location || undefined } : {}),
        });
      }
    }
    result[email] = blocks.sort((a, b) => a.start.localeCompare(b.start));
  }
  return result;
}

// ---------------------------------------------------------------------------
// iTIP / iMIP processing (RFC 5546 / 6047)
// ---------------------------------------------------------------------------

export interface ItipOutcome {
  action: 'stored' | 'updated' | 'cancelled' | 'ignored' | 'accepted' | 'declined';
  calendarId?: string;
  /** For resources: a REPLY that must be mailed back to the organiser. */
  reply?: { to: string; ics: string; partstat: PartStat };
  affectedUserIds: string[];
}

const hrefFor = (uid: string) => `${uid.replace(/[^A-Za-z0-9@._-]/g, '_')}.ics`;

/**
 * Apply an incoming scheduling message to the recipient's calendar:
 * REQUEST → store/update the invitation, REPLY → update the organiser's copy,
 * CANCEL → remove. Rooms auto-accept when free.
 */
export async function processItip(db: Database, recipient: Principal, method: string, ics: string): Promise<ItipOutcome> {
  const info = describeObject(ics);
  const m = method.toUpperCase();

  if (recipient.kind === 'resource') {
    const cal = await ensureResourceCalendar(db, recipient.resource);
    if (m === 'CANCEL') {
      const existing = await findByUid(db, [cal.id], info.uid);
      if (existing) await deleteCalendarObject(db, cal.id, existing.href);
      return { action: 'cancelled', calendarId: cal.id, affectedUserIds: [] };
    }
    if (m !== 'REQUEST') return { action: 'ignored', affectedUserIds: [] };
    const email = recipient.resource.email;
    let partstat: PartStat = 'ACCEPTED';
    if (!recipient.resource.autoAccept) partstat = 'TENTATIVE';
    else if (info.startsAt) {
      const end = info.endsAt ?? new Date(info.startsAt.getTime() + 365 * 86400_000);
      const busy = (await freeBusy(db, [email], info.startsAt, end))[email] ?? [];
      const mine = await findByUid(db, [cal.id], info.uid);
      // Ignore our own previous booking of the same meeting when it is rescheduled.
      const ownOcc = mine ? expandOccurrences(mine.ics, info.startsAt, end).map((o) => o.start.toISOString()) : [];
      const conflicts = busy.filter((b) => !ownOcc.includes(b.start));
      const occ = expandOccurrences(ics, info.startsAt, end);
      if (occ.some((o) => conflicts.some((b) => new Date(b.start) < o.end && new Date(b.end) > o.start))) partstat = 'DECLINED';
    }
    const updated = setAttendeePartstat(ics, email, partstat).ics;
    const existing = await findByUid(db, [cal.id], info.uid);
    if (partstat === 'DECLINED') {
      if (existing) await deleteCalendarObject(db, cal.id, existing.href);
    } else {
      await putCalendarObject(db, cal.id, existing?.href ?? hrefFor(info.uid), updated);
    }
    return {
      action: partstat === 'DECLINED' ? 'declined' : 'accepted',
      calendarId: cal.id,
      reply: info.organizer ? { to: info.organizer, ics: buildReply(updated, email, partstat, recipient.resource.name), partstat } : undefined,
      affectedUserIds: [],
    };
  }

  const user = recipient;
  const cal = await ensureDefaultCalendar(db, { id: user.id, orgId: user.orgId });
  const mine = (await accessibleCalendars(db, user.id)).filter((c) => c.access === 'owner').map((c) => c.id);
  const existing = await findByUid(db, mine, info.uid);

  if (m === 'REQUEST' || m === 'PUBLISH') {
    if (existing) {
      const prev = describeObject(existing.ics);
      if (info.sequence < prev.sequence) return { action: 'ignored', affectedUserIds: [] };
      // Keep the user's own response unless the organiser changed the meeting.
      let next = ics;
      const myPrev = prev.attendees.find((a) => a.email === user.email);
      if (myPrev && info.sequence === prev.sequence && myPrev.partstat !== 'NEEDS-ACTION') next = setAttendeePartstat(ics, user.email, myPrev.partstat).ics;
      await putCalendarObject(db, existing.calendarId, existing.href, next);
      return { action: 'updated', calendarId: existing.calendarId, affectedUserIds: [user.id] };
    }
    await putCalendarObject(db, cal.id, hrefFor(info.uid), ics);
    return { action: 'stored', calendarId: cal.id, affectedUserIds: [user.id] };
  }

  if (m === 'REPLY') {
    if (!existing) return { action: 'ignored', affectedUserIds: [] };
    let next = existing.ics;
    for (const a of info.attendees) next = setAttendeePartstat(next, a.email, a.partstat).ics;
    await putCalendarObject(db, existing.calendarId, existing.href, next);
    return { action: 'updated', calendarId: existing.calendarId, affectedUserIds: [user.id] };
  }

  if (m === 'CANCEL') {
    if (!existing) return { action: 'ignored', affectedUserIds: [] };
    await deleteCalendarObject(db, existing.calendarId, existing.href);
    return { action: 'cancelled', calendarId: existing.calendarId, affectedUserIds: [user.id] };
  }

  return { action: 'ignored', affectedUserIds: [] };
}

// ---------------------------------------------------------------------------
// Address books
// ---------------------------------------------------------------------------

export async function ensureAddressBook(db: Database, userId: string) {
  const find = () =>
    db
      .select()
      .from(addressBooks)
      .where(and(eq(addressBooks.userId, userId), eq(addressBooks.isDefault, true)))
      .limit(1);
  const [existing] = await find();
  if (existing) return existing;
  await db.insert(addressBooks).values({ userId, name: 'Contacts', isDefault: true }).onConflictDoNothing();
  const [created] = await find();
  return created!;
}

export type BookAccess = 'owner' | 'write' | 'read';

/** The user's own address books plus those of shared mailboxes they can open. */
export async function accessibleAddressBooks(db: Database, userId: string): Promise<(typeof addressBooks.$inferSelect & { access: BookAccess; ownerName: string | null })[]> {
  await ensureAddressBook(db, userId);
  const own = (await db.select().from(addressBooks).where(eq(addressBooks.userId, userId))).map((b) => ({ ...b, access: 'owner' as BookAccess, ownerName: null as string | null }));
  const out = [...own];
  for (const d of (await delegatedMailboxes(db, userId)).filter((x) => x.access !== 'none')) {
    await ensureAddressBook(db, d.ownerId);
    const books = await db.select().from(addressBooks).where(eq(addressBooks.userId, d.ownerId));
    out.push(...books.map((b) => ({ ...b, access: (d.access === 'full' ? 'write' : 'read') as BookAccess, ownerName: d.name })));
  }
  // Individually shared address books (from a person or a shared mailbox).
  const groupIds = (await db.select({ id: groupMembers.groupId }).from(groupMembers).where(eq(groupMembers.userId, userId))).map((g) => g.id);
  const shared = await db
    .select({ book: addressBooks, access: addressBookShares.access, ownerName: users.displayName })
    .from(addressBookShares)
    .innerJoin(addressBooks, eq(addressBooks.id, addressBookShares.addressBookId))
    .innerJoin(users, eq(users.id, addressBooks.userId))
    .where(
      and(
        eq(users.status, 'active'),
        or(
          and(eq(addressBookShares.principalType, 'user'), eq(addressBookShares.principalId, userId)),
          groupIds.length ? and(eq(addressBookShares.principalType, 'group'), inArray(addressBookShares.principalId, groupIds)) : undefined,
        ),
      ),
    );
  for (const s of shared) {
    const prev = out.find((b) => b.id === s.book.id);
    if (prev) {
      if (prev.access === 'read' && s.access === 'write') prev.access = 'write';
      continue;
    }
    out.push({ ...s.book, access: s.access, ownerName: s.ownerName });
  }
  return out;
}

export async function putContact(db: Database, addressBookId: string, href: string, vcard: string, opts: PutOptions = {}) {
  const fields = parseVCard(vcard);
  if (!fields.uid) throw new PreconditionFailedError('vCard has no UID');
  const [existing] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.addressBookId, addressBookId), eq(contacts.href, href)))
    .limit(1);
  const live = existing && !existing.deletedAt ? existing : null;
  if (opts.ifNoneMatch === '*' && live) throw new PreconditionFailedError('Contact already exists');
  if (opts.ifMatch && (!live || (opts.ifMatch !== '*' && opts.ifMatch !== live.etag))) throw new PreconditionFailedError('ETag does not match');
  const [book] = await db
    .update(addressBooks)
    .set({ syncRevision: sql`${addressBooks.syncRevision} + 1` })
    .where(eq(addressBooks.id, addressBookId))
    .returning({ rev: addressBooks.syncRevision });
  const values = {
    addressBookId,
    href,
    uid: fields.uid,
    etag: etagOf(vcard),
    vcard,
    fullName: fields.fullName.slice(0, 500),
    emails: fields.emails.map((e) => e.value.toLowerCase()),
    phones: fields.phones.map((p) => p.value),
    organization: fields.organization,
    syncRevision: book!.rev,
    deletedAt: null,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(contacts)
    .values(values)
    .onConflictDoUpdate({ target: [contacts.addressBookId, contacts.href], set: values })
    .returning();
  return { contact: row!, created: !live };
}

export async function deleteContact(db: Database, addressBookId: string, href: string, ifMatch?: string | null): Promise<boolean> {
  const [existing] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.addressBookId, addressBookId), eq(contacts.href, href), isNull(contacts.deletedAt)))
    .limit(1);
  if (!existing) return false;
  if (ifMatch && ifMatch !== '*' && ifMatch !== existing.etag) throw new PreconditionFailedError();
  const [book] = await db
    .update(addressBooks)
    .set({ syncRevision: sql`${addressBooks.syncRevision} + 1` })
    .where(eq(addressBooks.id, addressBookId))
    .returning({ rev: addressBooks.syncRevision });
  await db.update(contacts).set({ deletedAt: new Date(), vcard: '', etag: '', syncRevision: book!.rev }).where(eq(contacts.id, existing.id));
  return true;
}

// ---------------------------------------------------------------------------
// Per-person reminders
// ---------------------------------------------------------------------------

/** Reminders default to on for your own calendars and off for everyone else's. */
export async function remindersEnabled(db: Database, userId: string, calendar: { id: string; ownerType: string; ownerId: string }): Promise<boolean> {
  const [pref] = await db
    .select({ reminders: calendarPreferences.reminders })
    .from(calendarPreferences)
    .where(and(eq(calendarPreferences.userId, userId), eq(calendarPreferences.calendarId, calendar.id)))
    .limit(1);
  return pref ? pref.reminders : calendar.ownerType === 'user' && calendar.ownerId === userId;
}

/**
 * Change whether a calendar's reminders reach a person. All objects are
 * re-versioned so synced devices fetch them again with or without alarms.
 */
export async function setReminders(db: Database, userId: string, calendarId: string, reminders: boolean): Promise<void> {
  await db
    .insert(calendarPreferences)
    .values({ userId, calendarId, reminders })
    .onConflictDoUpdate({ target: [calendarPreferences.userId, calendarPreferences.calendarId], set: { reminders, updatedAt: new Date() } });
  const rev = await bumpCalendarRevision(db, calendarId);
  await db.update(calendarObjects).set({ syncRevision: rev }).where(and(eq(calendarObjects.calendarId, calendarId), isNull(calendarObjects.deletedAt)));
}
