import { randomUUID } from 'node:crypto';
import ICAL from 'ical.js';

/* ical.js's generated typings are loose; keep the surface here narrow and typed. */
type Comp = InstanceType<typeof ICAL.Component>;
type Time = InstanceType<typeof ICAL.Time>;

export const PRODID = '-//ForgeOffice//Calendar//EN';

export type PartStat = 'NEEDS-ACTION' | 'ACCEPTED' | 'TENTATIVE' | 'DECLINED' | 'DELEGATED';

export interface Attendee {
  email: string;
  name: string;
  partstat: PartStat;
  role: string;
  rsvp: boolean;
  cutype: string;
}

export interface ObjectInfo {
  uid: string;
  componentType: string;
  summary: string;
  organizer: string | null;
  organizerName: string | null;
  attendees: Attendee[];
  startsAt: Date | null;
  /** null means the series never ends. */
  endsAt: Date | null;
  recurring: boolean;
  transparent: boolean;
  status: string | null;
  sequence: number;
  method: string | null;
}

export class InvalidIcsError extends Error {
  constructor(message = 'Invalid iCalendar data') {
    super(message);
    this.name = 'InvalidIcsError';
  }
}

/** Parse iCalendar text and register any embedded VTIMEZONEs. */
export function loadCalendar(ics: string): Comp {
  let root: Comp;
  try {
    root = new ICAL.Component(ICAL.parse(ics));
  } catch (err) {
    throw new InvalidIcsError((err as Error).message);
  }
  if (root.name !== 'vcalendar') throw new InvalidIcsError('Expected a VCALENDAR');
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    try {
      const zone = new ICAL.Timezone(tz);
      if (!ICAL.TimezoneService.has(zone.tzid)) ICAL.TimezoneService.register(zone);
    } catch {
      /* ignore malformed zones; times fall back to floating */
    }
  }
  return root;
}

const mailto = (v: unknown) => (typeof v === 'string' ? v.replace(/^mailto:/i, '').trim().toLowerCase() : '');

function attendeesOf(vevent: Comp): Attendee[] {
  return vevent.getAllProperties('attendee').map((p) => ({
    email: mailto(p.getFirstValue()),
    name: String(p.getParameter('cn') ?? ''),
    partstat: (String(p.getParameter('partstat') ?? 'NEEDS-ACTION').toUpperCase() as PartStat) || 'NEEDS-ACTION',
    role: String(p.getParameter('role') ?? 'REQ-PARTICIPANT'),
    rsvp: String(p.getParameter('rsvp') ?? '').toUpperCase() === 'TRUE',
    cutype: String(p.getParameter('cutype') ?? 'INDIVIDUAL').toUpperCase(),
  }));
}

/** Master component (the one without RECURRENCE-ID) of the first VEVENT/VTODO UID. */
function masterComponent(root: Comp): Comp | null {
  const comps = [...root.getAllSubcomponents('vevent'), ...root.getAllSubcomponents('vtodo')];
  return comps.find((c) => !c.hasProperty('recurrence-id')) ?? comps[0] ?? null;
}

const MAX_SPAN_ITERATIONS = 5000;

/** Summarise an object for indexing (time span, participants). */
export function describeObject(ics: string): ObjectInfo {
  const root = loadCalendar(ics);
  const comp = masterComponent(root);
  if (!comp) throw new InvalidIcsError('No VEVENT or VTODO component');
  const uid = String(comp.getFirstPropertyValue('uid') ?? '');
  if (!uid) throw new InvalidIcsError('Missing UID');
  const organizerProp = comp.getFirstProperty('organizer');
  const info: ObjectInfo = {
    uid,
    componentType: comp.name.toUpperCase(),
    summary: String(comp.getFirstPropertyValue('summary') ?? ''),
    organizer: organizerProp ? mailto(organizerProp.getFirstValue()) || null : null,
    organizerName: organizerProp ? String(organizerProp.getParameter('cn') ?? '') || null : null,
    attendees: attendeesOf(comp),
    startsAt: null,
    endsAt: null,
    recurring: false,
    transparent: String(comp.getFirstPropertyValue('transp') ?? '').toUpperCase() === 'TRANSPARENT',
    status: (comp.getFirstPropertyValue('status') as string | null)?.toUpperCase() ?? null,
    sequence: Number(comp.getFirstPropertyValue('sequence') ?? 0),
    method: (root.getFirstPropertyValue('method') as string | null)?.toUpperCase() ?? null,
  };
  if (comp.name !== 'vevent') {
    const due = comp.getFirstPropertyValue('due') as Time | null;
    const start = comp.getFirstPropertyValue('dtstart') as Time | null;
    info.startsAt = start?.toJSDate() ?? due?.toJSDate() ?? null;
    info.endsAt = due?.toJSDate() ?? info.startsAt;
    return info;
  }
  const event = new ICAL.Event(comp);
  info.startsAt = event.startDate?.toJSDate() ?? null;
  const duration = event.endDate && event.startDate ? event.endDate.toJSDate().getTime() - event.startDate.toJSDate().getTime() : 0;
  info.endsAt = event.endDate?.toJSDate() ?? info.startsAt;
  if (event.isRecurring()) {
    info.recurring = true;
    const rrules = comp.getAllProperties('rrule').map((p) => p.getFirstValue() as { isFinite(): boolean });
    if (rrules.some((r) => !r.isFinite())) {
      info.endsAt = null;
    } else {
      const it = event.iterator();
      let last: Time | null = null;
      for (let i = 0, next = it.next(); next && i < MAX_SPAN_ITERATIONS; i++, next = it.next()) last = next;
      if (last) info.endsAt = new Date(last.toJSDate().getTime() + duration);
      else info.endsAt = null;
    }
    // Moved exceptions may fall outside the series span.
    for (const ex of root.getAllSubcomponents('vevent').filter((c) => c.hasProperty('recurrence-id'))) {
      const e = new ICAL.Event(ex);
      if (info.startsAt && e.startDate && e.startDate.toJSDate() < info.startsAt) info.startsAt = e.startDate.toJSDate();
      if (info.endsAt && e.endDate && e.endDate.toJSDate() > info.endsAt) info.endsAt = e.endDate.toJSDate();
    }
  }
  return info;
}

export interface Occurrence {
  uid: string;
  /** ISO string of the RECURRENCE-ID for recurring events, else null. */
  recurrenceId: string | null;
  start: Date;
  end: Date;
  allDay: boolean;
  summary: string;
  location: string;
  description: string;
  status: string | null;
  transparent: boolean;
  organizer: string | null;
  attendees: Attendee[];
  meetingUrl: string | null;
}

function occurrenceFrom(comp: Comp, start: Time, end: Time, recurrenceId: string | null): Occurrence {
  return {
    uid: String(comp.getFirstPropertyValue('uid')),
    recurrenceId,
    start: start.toJSDate(),
    end: end.toJSDate(),
    allDay: start.isDate,
    summary: String(comp.getFirstPropertyValue('summary') ?? ''),
    location: String(comp.getFirstPropertyValue('location') ?? ''),
    description: String(comp.getFirstPropertyValue('description') ?? ''),
    status: (comp.getFirstPropertyValue('status') as string | null)?.toUpperCase() ?? null,
    transparent: String(comp.getFirstPropertyValue('transp') ?? '').toUpperCase() === 'TRANSPARENT',
    organizer: mailto(comp.getFirstPropertyValue('organizer')) || null,
    attendees: attendeesOf(comp),
    meetingUrl: (comp.getFirstPropertyValue('x-forge-meeting-url') as string | null) ?? null,
  };
}

const MAX_OCCURRENCES = 2000;

/** Expand an object into concrete occurrences that overlap [from, to). */
export function expandOccurrences(ics: string, from: Date, to: Date): Occurrence[] {
  const root = loadCalendar(ics);
  const events = root.getAllSubcomponents('vevent');
  const master = events.find((c) => !c.hasProperty('recurrence-id'));
  const out: Occurrence[] = [];
  if (!master) {
    // Only overridden instances were sent (e.g. an invitation to one occurrence).
    for (const c of events) {
      const e = new ICAL.Event(c);
      if (e.startDate.toJSDate() < to && e.endDate.toJSDate() > from) out.push(occurrenceFrom(c, e.startDate, e.endDate, (c.getFirstPropertyValue('recurrence-id') as Time)?.toString() ?? null));
    }
    return out;
  }
  const event = new ICAL.Event(master);
  for (const ex of events) if (ex !== master) event.relateException(ex);
  if (!event.isRecurring()) {
    if (event.startDate.toJSDate() < to && event.endDate.toJSDate() > from) out.push(occurrenceFrom(master, event.startDate, event.endDate, null));
    return out;
  }
  const it = event.iterator();
  for (let next = it.next(), n = 0; next && n < MAX_OCCURRENCES * 10; next = it.next(), n++) {
    const details = event.getOccurrenceDetails(next);
    const start = details.startDate.toJSDate();
    if (start >= to) break;
    if (details.endDate.toJSDate() <= from) continue;
    out.push(occurrenceFrom(details.item.component, details.startDate, details.endDate, details.recurrenceId.toString()));
    if (out.length >= MAX_OCCURRENCES) break;
  }
  return out;
}

export interface EventInput {
  uid?: string;
  summary: string;
  start: Date;
  end: Date;
  allDay?: boolean;
  location?: string;
  description?: string;
  /** Simple recurrence: FREQ plus optional COUNT/UNTIL/BYDAY. */
  recurrence?: { freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'; interval?: number; count?: number; until?: Date; byDay?: string[] } | null;
  /** sentBy: the person acting for a shared mailbox (iCalendar SENT-BY). */
  organizer?: { email: string; name?: string; sentBy?: string } | null;
  attendees?: { email: string; name?: string; partstat?: PartStat; cutype?: 'INDIVIDUAL' | 'ROOM' | 'RESOURCE'; rsvp?: boolean }[];
  status?: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';
  transparent?: boolean;
  meetingUrl?: string | null;
  sequence?: number;
  reminderMinutes?: number | null;
}

function dateTime(d: Date, allDay: boolean): Time {
  if (allDay) {
    return ICAL.Time.fromData({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), isDate: true });
  }
  return ICAL.Time.fromJSDate(d, true);
}

function addProp(comp: Comp, name: string, value: unknown, params: Record<string, string | undefined> = {}) {
  const prop = new ICAL.Property(name);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') prop.setParameter(k, v);
  prop.setValue(value as string);
  comp.addProperty(prop);
  return prop;
}

/** Build a complete VCALENDAR containing one VEVENT. */
export function buildEventIcs(input: EventInput, method?: string): string {
  const cal = new ICAL.Component(['vcalendar', [], []]);
  cal.addPropertyWithValue('prodid', PRODID);
  cal.addPropertyWithValue('version', '2.0');
  cal.addPropertyWithValue('calscale', 'GREGORIAN');
  if (method) cal.addPropertyWithValue('method', method);
  const ev = new ICAL.Component('vevent');
  const now = ICAL.Time.fromJSDate(new Date(), true);
  ev.addPropertyWithValue('uid', input.uid ?? `${randomUUID()}@forgeoffice`);
  ev.addPropertyWithValue('dtstamp', now);
  ev.addPropertyWithValue('created', now);
  ev.addPropertyWithValue('last-modified', now);
  ev.addPropertyWithValue('sequence', input.sequence ?? 0);
  ev.addPropertyWithValue('dtstart', dateTime(input.start, !!input.allDay));
  ev.addPropertyWithValue('dtend', dateTime(input.end, !!input.allDay));
  ev.addPropertyWithValue('summary', input.summary);
  if (input.location) ev.addPropertyWithValue('location', input.location);
  if (input.description) ev.addPropertyWithValue('description', input.description);
  if (input.status) ev.addPropertyWithValue('status', input.status);
  ev.addPropertyWithValue('transp', input.transparent ? 'TRANSPARENT' : 'OPAQUE');
  if (input.recurrence) {
    const r = input.recurrence;
    const data: Record<string, unknown> = { freq: r.freq };
    if (r.interval && r.interval > 1) data.interval = r.interval;
    if (r.count) data.count = r.count;
    if (r.until) data.until = dateTime(r.until, !!input.allDay);
    if (r.byDay?.length) data.byday = r.byDay;
    ev.addPropertyWithValue('rrule', ICAL.Recur.fromData(data as never));
  }
  if (input.meetingUrl) {
    ev.addPropertyWithValue('x-forge-meeting-url', input.meetingUrl);
    ev.addPropertyWithValue('url', input.meetingUrl);
  }
  if (input.organizer) addProp(ev, 'organizer', `mailto:${input.organizer.email}`, { cn: input.organizer.name, 'sent-by': input.organizer.sentBy ? `mailto:${input.organizer.sentBy}` : undefined });
  for (const a of input.attendees ?? []) {
    addProp(ev, 'attendee', `mailto:${a.email}`, {
      cn: a.name,
      role: 'REQ-PARTICIPANT',
      partstat: a.partstat ?? 'NEEDS-ACTION',
      rsvp: a.rsvp === false ? 'FALSE' : 'TRUE',
      cutype: a.cutype ?? 'INDIVIDUAL',
    });
  }
  if (input.reminderMinutes != null) {
    const alarm = new ICAL.Component('valarm');
    alarm.addPropertyWithValue('action', 'DISPLAY');
    alarm.addPropertyWithValue('description', input.summary);
    alarm.addPropertyWithValue('trigger', ICAL.Duration.fromSeconds(-input.reminderMinutes * 60));
    ev.addSubcomponent(alarm);
  }
  cal.addSubcomponent(ev);
  return cal.toString() + '\r\n';
}

/** Set (or remove with null) the METHOD of a calendar. */
export function withMethod(ics: string, method: string | null): string {
  const root = loadCalendar(ics);
  root.removeAllProperties('method');
  if (method) root.addPropertyWithValue('method', method);
  return root.toString() + '\r\n';
}

/** Update one attendee's PARTSTAT on every VEVENT in the object. */
export function setAttendeePartstat(ics: string, email: string, partstat: PartStat): { ics: string; changed: boolean } {
  const root = loadCalendar(ics);
  let changed = false;
  for (const ev of root.getAllSubcomponents('vevent')) {
    for (const p of ev.getAllProperties('attendee')) {
      if (mailto(p.getFirstValue()) === email.toLowerCase()) {
        if (String(p.getParameter('partstat') ?? '').toUpperCase() !== partstat) changed = true;
        p.setParameter('partstat', partstat);
        p.removeParameter('rsvp');
      }
    }
    if (changed) ev.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
  }
  return { ics: root.toString() + '\r\n', changed };
}

/** iTIP REPLY from one attendee (RFC 5546 §3.2.3). */
export function buildReply(ics: string, attendeeEmail: string, partstat: PartStat, attendeeName?: string): string {
  const root = loadCalendar(ics);
  const master = masterComponent(root);
  if (!master) throw new InvalidIcsError();
  const cal = new ICAL.Component(['vcalendar', [], []]);
  cal.addPropertyWithValue('prodid', PRODID);
  cal.addPropertyWithValue('version', '2.0');
  cal.addPropertyWithValue('method', 'REPLY');
  const ev = new ICAL.Component('vevent');
  for (const name of ['uid', 'sequence', 'dtstart', 'dtend', 'summary', 'recurrence-id']) {
    const p = master.getFirstProperty(name);
    if (p) ev.addProperty(ICAL.Property.fromString(p.toICALString()));
  }
  ev.addPropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
  const org = master.getFirstProperty('organizer');
  if (org) ev.addProperty(ICAL.Property.fromString(org.toICALString()));
  addProp(ev, 'attendee', `mailto:${attendeeEmail}`, { cn: attendeeName, partstat });
  cal.addSubcomponent(ev);
  return cal.toString() + '\r\n';
}

/** Replace the attendee list and bump SEQUENCE (organiser edits). */
export function bumpSequence(ics: string): string {
  const root = loadCalendar(ics);
  for (const ev of root.getAllSubcomponents('vevent')) {
    ev.updatePropertyWithValue('sequence', Number(ev.getFirstPropertyValue('sequence') ?? 0) + 1);
    ev.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
  }
  return root.toString() + '\r\n';
}

export function cancelIcs(ics: string): string {
  const root = loadCalendar(ics);
  root.removeAllProperties('method');
  root.addPropertyWithValue('method', 'CANCEL');
  for (const ev of root.getAllSubcomponents('vevent')) {
    ev.updatePropertyWithValue('status', 'CANCELLED');
    ev.updatePropertyWithValue('sequence', Number(ev.getFirstPropertyValue('sequence') ?? 0) + 1);
  }
  return root.toString() + '\r\n';
}

/** Read the editable fields of an event for the web UI. */
export function eventFields(ics: string) {
  const info = describeObject(ics);
  const root = loadCalendar(ics);
  const comp = masterComponent(root)!;
  const ev = new ICAL.Event(comp);
  const rrule = comp.getFirstPropertyValue('rrule') as { freq: string; interval?: number; count?: number; until?: Time; parts?: Record<string, string[]> } | null;
  return {
    uid: info.uid,
    summary: info.summary,
    start: ev.startDate.toJSDate().toISOString(),
    end: ev.endDate.toJSDate().toISOString(),
    allDay: ev.startDate.isDate,
    location: String(comp.getFirstPropertyValue('location') ?? ''),
    description: String(comp.getFirstPropertyValue('description') ?? ''),
    organizer: info.organizer,
    organizerName: info.organizerName,
    attendees: info.attendees,
    status: info.status,
    transparent: info.transparent,
    sequence: info.sequence,
    meetingUrl: (comp.getFirstPropertyValue('x-forge-meeting-url') as string | null) ?? null,
    recurrence: rrule
      ? {
          freq: rrule.freq,
          interval: rrule.interval ?? 1,
          count: rrule.count ?? null,
          until: rrule.until ? rrule.until.toJSDate().toISOString() : null,
          byDay: rrule.parts?.BYDAY ?? [],
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Reminders (VALARM) are per person on shared calendars
// ---------------------------------------------------------------------------

const keyOf = (c: Comp) => `${c.getFirstPropertyValue('uid')}|${(c.getFirstPropertyValue('recurrence-id') as Time | null)?.toString() ?? ''}`;

/** Remove every VALARM (served to people who opted out of a calendar's reminders). */
export function stripAlarms(ics: string): string {
  if (!/BEGIN:VALARM/i.test(ics)) return ics;
  const root = loadCalendar(ics);
  for (const c of [...root.getAllSubcomponents('vevent'), ...root.getAllSubcomponents('vtodo')]) c.removeAllSubcomponents('valarm');
  return root.toString() + '\r\n';
}

/**
 * Put back the alarms stored on `previous` into `incoming` (whose sender could
 * not see them), dropping any alarms the sender added, so one person's edit
 * never adds or removes reminders for everyone else.
 */
export function mergeAlarms(incoming: string, previous: string | null): string {
  const next = loadCalendar(incoming);
  const comps = [...next.getAllSubcomponents('vevent'), ...next.getAllSubcomponents('vtodo')];
  for (const c of comps) c.removeAllSubcomponents('valarm');
  if (previous) {
    const prev = loadCalendar(previous);
    const alarms = new Map<string, Comp[]>();
    for (const c of [...prev.getAllSubcomponents('vevent'), ...prev.getAllSubcomponents('vtodo')]) alarms.set(keyOf(c), c.getAllSubcomponents('valarm'));
    for (const c of comps) for (const a of alarms.get(keyOf(c)) ?? []) c.addSubcomponent(new ICAL.Component(a.toJSON()));
  }
  return next.toString() + '\r\n';
}
