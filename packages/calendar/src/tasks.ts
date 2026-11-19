import { randomUUID } from 'node:crypto';
import ICAL from 'ical.js';
import { InvalidIcsError, PRODID, loadCalendar } from './ics';

type Comp = InstanceType<typeof ICAL.Component>;
type Time = InstanceType<typeof ICAL.Time>;

export type TaskStatus = 'NEEDS-ACTION' | 'IN-PROCESS' | 'COMPLETED';
export type TaskImportance = 'low' | 'normal' | 'high';
export type TaskRepeat = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly';

/** A task as the web app sees it (stored as an iCalendar VTODO). */
export interface TaskFields {
  title: string;
  notes: string;
  /** Due date, YYYY-MM-DD (tasks are due on a day, as in Outlook). */
  due: string | null;
  /** Reminder time (ISO 8601). */
  reminder: string | null;
  importance: TaskImportance;
  status: TaskStatus;
  completedAt: string | null;
  repeat: TaskRepeat | null;
}

export interface TaskPerson {
  email: string;
  name: string;
}
export type TaskResponse = 'NEEDS-ACTION' | 'ACCEPTED' | 'DECLINED';

export interface TaskInfo extends TaskFields {
  uid: string;
  /** Assigned tasks: who assigned it (ORGANIZER). */
  assignedBy: TaskPerson | null;
  /** Assigned tasks: who it is assigned to (the single ATTENDEE) and their answer. */
  assignee: (TaskPerson & { response: TaskResponse }) | null;
  sequence: number;
  createdAt: string | null;
  /** Flagged-email tasks: the message they belong to. */
  messageId: string | null;
  /** Flagged-email tasks: who sent the message. */
  from: string | null;
}

const FLAG_UID = /^forge-flag-([0-9a-f-]{36})$/i;
export const flagTaskUid = (messageId: string) => `forge-flag-${messageId}`;
export const messageIdFromTaskUid = (uid: string) => FLAG_UID.exec(uid)?.[1]?.toLowerCase() ?? null;

const RRULES: Record<TaskRepeat, string> = {
  daily: 'FREQ=DAILY',
  weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  weekly: 'FREQ=WEEKLY',
  monthly: 'FREQ=MONTHLY',
  yearly: 'FREQ=YEARLY',
};

function repeatOf(comp: Comp): TaskRepeat | null {
  const rule = comp.getFirstPropertyValue('rrule') as { toString(): string } | null;
  if (!rule) return null;
  const r = rule.toString().toUpperCase();
  if (r.includes('FREQ=DAILY')) return 'daily';
  if (r.includes('FREQ=WEEKLY')) return /BYDAY=MO,TU,WE,TH,FR(;|$)/.test(r) ? 'weekdays' : 'weekly';
  if (r.includes('FREQ=MONTHLY')) return 'monthly';
  if (r.includes('FREQ=YEARLY')) return 'yearly';
  return null;
}

const dateOnly = (t: Time | null) => (t ? `${String(t.year).padStart(4, '0')}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}` : null);

function vtodoOf(root: Comp): Comp {
  const comp = root.getAllSubcomponents('vtodo').find((c) => !c.hasProperty('recurrence-id')) ?? root.getFirstSubcomponent('vtodo');
  if (!comp) throw new InvalidIcsError('No VTODO component');
  return comp;
}

/** Read a VTODO into task fields. */
export function parseTask(ics: string): TaskInfo {
  const comp = vtodoOf(loadCalendar(ics));
  const priority = Number(comp.getFirstPropertyValue('priority') ?? 0);
  const status = String(comp.getFirstPropertyValue('status') ?? 'NEEDS-ACTION').toUpperCase();
  const completed = comp.getFirstPropertyValue('completed') as Time | null;
  const alarm = comp.getFirstSubcomponent('valarm');
  const trigger = alarm?.getFirstProperty('trigger');
  const triggerValue = trigger?.getFirstValue() as Time | { toSeconds(): number } | null | undefined;
  const due = comp.getFirstPropertyValue('due') as Time | null;
  let reminder: string | null = null;
  if (triggerValue && 'toJSDate' in triggerValue) reminder = triggerValue.toJSDate().toISOString();
  else if (triggerValue && 'toSeconds' in triggerValue && due) reminder = new Date(due.toJSDate().getTime() + triggerValue.toSeconds() * 1000).toISOString();
  const uid = String(comp.getFirstPropertyValue('uid') ?? '');
  const created = comp.getFirstPropertyValue('created') as Time | null;
  const org = comp.getFirstProperty('organizer');
  const att = comp.getFirstProperty('attendee');
  const person = (p: NonNullable<typeof org>) => ({ email: String(p.getFirstValue()).replace(/^mailto:/i, '').toLowerCase(), name: String(p.getParameter('cn') ?? '') });
  const partstat = String(att?.getParameter('partstat') ?? 'NEEDS-ACTION').toUpperCase();
  return {
    uid,
    assignedBy: org && att ? person(org) : null,
    assignee: att ? { ...person(att), response: partstat === 'ACCEPTED' || partstat === 'DECLINED' ? partstat : partstat === 'COMPLETED' || partstat === 'IN-PROCESS' ? 'ACCEPTED' : 'NEEDS-ACTION' } : null,
    sequence: Number(comp.getFirstPropertyValue('sequence') ?? 0),
    title: String(comp.getFirstPropertyValue('summary') ?? ''),
    notes: String(comp.getFirstPropertyValue('description') ?? ''),
    due: dateOnly(due),
    reminder,
    importance: priority >= 1 && priority <= 4 ? 'high' : priority >= 6 ? 'low' : 'normal',
    status: status === 'COMPLETED' || completed ? 'COMPLETED' : status === 'IN-PROCESS' ? 'IN-PROCESS' : 'NEEDS-ACTION',
    completedAt: completed?.toJSDate().toISOString() ?? null,
    repeat: repeatOf(comp),
    createdAt: created?.toJSDate().toISOString() ?? null,
    messageId: messageIdFromTaskUid(uid),
    from: (comp.getFirstPropertyValue('x-forge-flag-from') as string | null) ?? null,
  };
}

const utc = (d: Date) => ICAL.Time.fromJSDate(d, true);
const day = (ymd: string) => ICAL.Time.fromDateString(ymd);

function setOrRemove(comp: Comp, name: string, value: unknown) {
  if (value === null || value === undefined || value === '') comp.removeAllProperties(name);
  else comp.updatePropertyWithValue(name, value);
}

/**
 * Create a VTODO, or apply changes to an existing one. Properties the web app
 * does not manage (categories, X- properties set by phone apps…) are kept.
 */
export function buildTask(
  changes: Partial<TaskFields> & { uid?: string; url?: string; from?: string; assign?: { organizer: TaskPerson; assignee: TaskPerson } | null },
  existing?: string,
): string {
  let root: Comp;
  let comp: Comp;
  if (existing) {
    root = loadCalendar(existing);
    comp = vtodoOf(root);
  } else {
    root = new ICAL.Component(['vcalendar', [], []]);
    root.updatePropertyWithValue('version', '2.0');
    root.updatePropertyWithValue('prodid', PRODID);
    comp = new ICAL.Component('vtodo');
    comp.updatePropertyWithValue('uid', changes.uid ?? randomUUID());
    comp.updatePropertyWithValue('created', utc(new Date()));
    root.addSubcomponent(comp);
  }
  const now = utc(new Date());
  comp.updatePropertyWithValue('dtstamp', now);
  comp.updatePropertyWithValue('last-modified', now);
  if (changes.title !== undefined) comp.updatePropertyWithValue('summary', changes.title);
  if (changes.notes !== undefined) setOrRemove(comp, 'description', changes.notes);
  if (changes.url !== undefined) setOrRemove(comp, 'url', changes.url);
  if (changes.from !== undefined) setOrRemove(comp, 'x-forge-flag-from', changes.from);
  if (changes.importance !== undefined) setOrRemove(comp, 'priority', changes.importance === 'high' ? 1 : changes.importance === 'low' ? 9 : null);
  if (changes.due !== undefined) {
    setOrRemove(comp, 'due', changes.due ? day(changes.due) : null);
    // Repeating tasks need a start; keep it on the due date.
    if (comp.hasProperty('dtstart') || (changes.due && (changes.repeat ?? repeatOf(comp)))) setOrRemove(comp, 'dtstart', changes.due ? day(changes.due) : null);
  }
  if (changes.repeat !== undefined) {
    comp.removeAllProperties('rrule');
    const due = comp.getFirstPropertyValue('due') as Time | null;
    if (changes.repeat && due) {
      comp.addPropertyWithValue('rrule', ICAL.Recur.fromString(RRULES[changes.repeat]));
      comp.updatePropertyWithValue('dtstart', due);
    }
  }
  if (changes.status !== undefined) {
    comp.updatePropertyWithValue('status', changes.status);
    if (changes.status === 'COMPLETED') {
      comp.updatePropertyWithValue('completed', changes.completedAt ? utc(new Date(changes.completedAt)) : now);
      comp.updatePropertyWithValue('percent-complete', 100);
    } else {
      comp.removeAllProperties('completed');
      comp.removeAllProperties('percent-complete');
    }
  }
  if (changes.assign !== undefined) {
    comp.removeAllProperties('organizer');
    comp.removeAllProperties('attendee');
    if (changes.assign) {
      const org = new ICAL.Property('organizer');
      org.setValue(`mailto:${changes.assign.organizer.email}`);
      if (changes.assign.organizer.name) org.setParameter('cn', changes.assign.organizer.name);
      comp.addProperty(org);
      const att = new ICAL.Property('attendee');
      att.setValue(`mailto:${changes.assign.assignee.email}`);
      if (changes.assign.assignee.name) att.setParameter('cn', changes.assign.assignee.name);
      att.setParameter('partstat', 'NEEDS-ACTION');
      att.setParameter('role', 'REQ-PARTICIPANT');
      att.setParameter('rsvp', 'TRUE');
      comp.addProperty(att);
    }
  }
  if (changes.reminder !== undefined) {
    for (const a of comp.getAllSubcomponents('valarm')) comp.removeSubcomponent(a);
    if (changes.reminder) {
      const alarm = new ICAL.Component('valarm');
      alarm.updatePropertyWithValue('action', 'DISPLAY');
      alarm.updatePropertyWithValue('description', String(comp.getFirstPropertyValue('summary') ?? 'Reminder'));
      const trigger = new ICAL.Property('trigger');
      trigger.setParameter('value', 'DATE-TIME');
      trigger.setValue(utc(new Date(changes.reminder)));
      alarm.addProperty(trigger);
      comp.addSubcomponent(alarm);
    }
  }
  return root.toString();
}

/** The next due date of a repeating task, or null. */
export function nextDue(due: string, repeat: TaskRepeat): string {
  const d = new Date(`${due}T12:00:00Z`);
  if (repeat === 'daily') d.setUTCDate(d.getUTCDate() + 1);
  else if (repeat === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (repeat === 'weekdays') {
    do d.setUTCDate(d.getUTCDate() + 1);
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  } else if (repeat === 'monthly') {
    const dom = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(dom, last));
  } else {
    const dom = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCFullYear(d.getUTCFullYear() + 1);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(dom, last));
  }
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Assigned tasks (iTIP for VTODO, RFC 5546 §3.4): the assigner (ORGANIZER)
// owns the details; the assignee (ATTENDEE) owns the answer and progress.
// ---------------------------------------------------------------------------

/** The assigner changed the details: bump SEQUENCE so the assignee's copy updates. */
export function bumpTaskSequence(ics: string): string {
  const root = loadCalendar(ics);
  const comp = vtodoOf(root);
  comp.updatePropertyWithValue('sequence', Number(comp.getFirstPropertyValue('sequence') ?? 0) + 1);
  comp.updatePropertyWithValue('dtstamp', utc(new Date()));
  return root.toString();
}

/** Record the assignee's answer on a copy of the task. */
export function setTaskResponse(ics: string, response: TaskResponse): string {
  const root = loadCalendar(ics);
  const att = vtodoOf(root).getFirstProperty('attendee');
  if (att) {
    att.setParameter('partstat', response);
    att.removeParameter('rsvp');
  }
  return root.toString();
}

const PROGRESS = ['status', 'completed', 'percent-complete'];

/** The assignee's REPLY: their answer plus progress (status, completion). */
export function taskReply(ics: string): string {
  const src = vtodoOf(loadCalendar(ics));
  const cal = new ICAL.Component(['vcalendar', [], []]);
  cal.addPropertyWithValue('prodid', PRODID);
  cal.addPropertyWithValue('version', '2.0');
  cal.addPropertyWithValue('method', 'REPLY');
  const todo = new ICAL.Component('vtodo');
  for (const name of ['uid', 'sequence', 'summary', 'organizer', 'attendee', ...PROGRESS]) {
    const p = src.getFirstProperty(name);
    if (p) todo.addProperty(ICAL.Property.fromString(p.toICALString()));
  }
  todo.addPropertyWithValue('dtstamp', utc(new Date()));
  cal.addSubcomponent(todo);
  return cal.toString();
}

/** Assigner side: apply a REPLY to their copy (answer and progress). */
export function applyTaskReply(organizerIcs: string, replyIcs: string): string {
  const reply = vtodoOf(loadCalendar(replyIcs));
  const root = loadCalendar(organizerIcs);
  const comp = vtodoOf(root);
  const theirs = reply.getFirstProperty('attendee');
  const mine = comp.getFirstProperty('attendee');
  if (theirs && mine && String(theirs.getFirstValue()).toLowerCase() === String(mine.getFirstValue()).toLowerCase()) mine.setParameter('partstat', String(theirs.getParameter('partstat') ?? 'NEEDS-ACTION'));
  for (const name of PROGRESS) {
    comp.removeAllProperties(name);
    const p = reply.getFirstProperty(name);
    if (p) comp.addProperty(ICAL.Property.fromString(p.toICALString()));
  }
  comp.updatePropertyWithValue('dtstamp', utc(new Date()));
  return root.toString();
}

/**
 * Assignee side: a (new or updated) REQUEST from the assigner. Details come
 * from the request; the assignee keeps their own answer, progress and reminders.
 */
export function mergeTaskRequest(requestIcs: string, existingIcs: string | null): string {
  const root = loadCalendar(requestIcs);
  root.removeAllProperties('method');
  const comp = vtodoOf(root);
  for (const a of comp.getAllSubcomponents('valarm')) comp.removeSubcomponent(a);
  if (!existingIcs) {
    for (const name of PROGRESS) comp.removeAllProperties(name);
    comp.updatePropertyWithValue('status', 'NEEDS-ACTION');
    return root.toString();
  }
  const prev = vtodoOf(loadCalendar(existingIcs));
  for (const name of PROGRESS) {
    comp.removeAllProperties(name);
    const p = prev.getFirstProperty(name);
    if (p) comp.addProperty(ICAL.Property.fromString(p.toICALString()));
  }
  for (const a of prev.getAllSubcomponents('valarm')) comp.addSubcomponent(new ICAL.Component(a.toJSON()));
  const partstat = prev.getFirstProperty('attendee')?.getParameter('partstat');
  const att = comp.getFirstProperty('attendee');
  if (att && partstat) {
    att.setParameter('partstat', String(partstat));
    att.removeParameter('rsvp');
  }
  return root.toString();
}
