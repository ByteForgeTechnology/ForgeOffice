import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { addressBooks, calendarObjects, calendars, connectDatabase, domains, orm, organizations, users, type DatabaseHandle } from '@forge/db';
import { buildEventIcs, ensureAddressBook, ensureDefaultCalendar, putCalendarObject } from '../src';

const { eq, sql } = orm;
const migrations = fileURLToPath(new URL('../../db/drizzle', import.meta.url));
let h: DatabaseHandle;
let orgId: string;
let userId: string;

beforeAll(async () => {
  h = await connectDatabase('pglite://memory');
  await h.migrate(migrations);
  const [org] = await h.db.insert(organizations).values({ name: 'Acme', slug: 'acme' }).returning();
  const [dom] = await h.db.insert(domains).values({ orgId: org!.id, name: 'acme.test', verificationToken: 'x' }).returning();
  const [u] = await h.db.insert(users).values({ orgId: org!.id, domainId: dom!.id, username: 'sales', email: 'sales@acme.test', displayName: 'Sales', passwordHash: 'x', kind: 'shared' }).returning();
  orgId = org!.id;
  userId = u!.id;
});

afterAll(async () => {
  await h.close();
});

it('creates exactly one default calendar and address book under concurrent first use', async () => {
  await Promise.all(Array.from({ length: 10 }, () => ensureDefaultCalendar(h.db, { id: userId, orgId })));
  await Promise.all(Array.from({ length: 10 }, () => ensureAddressBook(h.db, userId)));
  expect(await h.db.select().from(calendars).where(eq(calendars.ownerId, userId))).toHaveLength(1);
  expect(await h.db.select().from(addressBooks).where(eq(addressBooks.userId, userId))).toHaveLength(1);
});

it('migration merges duplicates that already exist, keeping their events', async () => {
  // Recreate the pre-fix state: drop the guard and add a second default calendar with an event.
  await h.db.execute(sql`drop index calendars_default_uq`);
  const keep = await ensureDefaultCalendar(h.db, { id: userId, orgId });
  await putCalendarObject(h.db, keep.id, 'a.ics', buildEventIcs({ uid: 'a', summary: 'In the first', start: new Date('2033-01-01T10:00:00Z'), end: new Date('2033-01-01T11:00:00Z') }));
  const [dup] = await h.db.insert(calendars).values({ orgId, ownerType: 'user', ownerId: userId, name: 'Calendar', isDefault: true }).returning();
  await putCalendarObject(h.db, dup!.id, 'b.ics', buildEventIcs({ uid: 'b', summary: 'In the duplicate', start: new Date('2033-01-02T10:00:00Z'), end: new Date('2033-01-02T11:00:00Z') }));

  const migration = readFileSync(`${migrations}/0004_dedupe_default_calendars.sql`, 'utf8').split('--> statement-breakpoint');
  for (const statement of migration.filter((s) => !/address_books_default_uq/.test(s))) await h.db.execute(sql.raw(statement));

  const remaining = await h.db.select().from(calendars).where(eq(calendars.ownerId, userId));
  expect(remaining.map((c) => c.id)).toEqual([keep.id]);
  const events = await h.db.select().from(calendarObjects).where(eq(calendarObjects.calendarId, keep.id));
  expect(events.map((e) => e.summary).sort()).toEqual(['In the duplicate', 'In the first']);
  // Moved events are re-versioned so devices that already synced the calendar pick them up.
  const moved = events.find((e) => e.summary === 'In the duplicate')!;
  expect(moved.syncRevision).toBe(remaining[0]!.syncRevision);
  expect(remaining[0]!.syncRevision).toBeGreaterThan(1000);
});
