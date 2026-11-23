import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff, Check, ChevronLeft, ChevronRight, Clock, MapPin, Plus, Repeat, Settings2, Trash2, Users, Video, X } from 'lucide-react';
import { Alert, Badge, Button, Dialog, Field, Input, PageSpinner, Select, Switch, Textarea, cn, useToast } from '@forge/ui';
import { RecipientInput } from '../../components/mail/Composer';
import { ShareDialog, toGrants } from '../../components/ShareDialog';
import { api, errorMessage } from '../../lib/api';
import { useMe } from '../../lib/hooks';
import type { Addr } from '../../lib/mail-types';
import { useSocketEvent } from '../../lib/realtime';

interface CalendarInfo {
  id: string;
  name: string;
  color: string;
  isDefault: boolean;
  ownerType: 'user' | 'group' | 'resource' | 'shared';
  owner: string | null;
  ownerEmail: string | null;
  access: 'owner' | 'write' | 'read' | 'freebusy';
  /** Whether this calendar's reminders reach your devices (your personal setting). */
  reminders: boolean;
  canShare: boolean;
}

interface Occurrence {
  objectId: string;
  calendarId: string;
  color: string;
  uid: string;
  recurrenceId: string | null;
  start: string;
  end: string;
  allDay: boolean;
  summary: string;
  location: string;
  status: string | null;
  organizer: string | null;
  isOrganizer: boolean;
  myStatus: string | null;
  attendeeCount: number;
  meetingUrl: string | null;
  recurring: boolean;
  canEdit: boolean;
}

interface EventDetail {
  id: string;
  calendarId: string;
  uid: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  description: string;
  organizer: string | null;
  organizerName: string | null;
  attendees: { email: string; name: string; partstat: string; cutype: string }[];
  meetingUrl: string | null;
  recurrence: { freq: string; interval: number; count: number | null; until: string | null; byDay: string[] } | null;
  canEdit: boolean;
}

interface Resource {
  id: string;
  name: string;
  email: string;
  capacity: number | null;
  location: string;
}

type View = 'day' | 'week' | 'month';

/** "Sales" for a shared mailbox's default calendar, "Sales · Projects" for its others, plain name for your own. */
function calendarLabel(c: CalendarInfo): string {
  if (!c.owner) return c.name;
  return c.name && c.name !== 'Calendar' && c.name !== c.owner ? `${c.owner} · ${c.name}` : c.owner;
}

const OWNER_KIND: Record<CalendarInfo['ownerType'], string> = { user: 'Person', shared: 'Shared mailbox', group: 'Team', resource: 'Room' };

const HOUR_PX = 48;
const DAY_MS = 86400_000;

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function startOfWeek(d: Date) {
  const x = startOfDay(d);
  const day = (x.getDay() + 6) % 7; // Monday first
  return addDays(x, -day);
}
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const timeLabel = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

function loadHidden(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem('forge.calendar.hidden') ?? '[]'));
  } catch {
    return new Set();
  }
}

export function CalendarPage() {
  const qc = useQueryClient();
  const isNarrow = typeof window !== 'undefined' && window.innerWidth < 768;
  const [view, setView] = useState<View>(isNarrow ? 'day' : 'week');
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [hidden, setHidden] = useState<Set<string>>(loadHidden);
  const [editing, setEditing] = useState<{ event?: EventDetail; start?: Date; end?: Date; allDay?: boolean } | null>(null);
  const [selected, setSelected] = useState<Occurrence | null>(null);

  const range = useMemo(() => {
    if (view === 'day') return { from: anchor, to: addDays(anchor, 1) };
    if (view === 'week') {
      const s = startOfWeek(anchor);
      return { from: s, to: addDays(s, 7) };
    }
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const s = startOfWeek(first);
    return { from: s, to: addDays(s, 42) };
  }, [view, anchor]);

  const calendars = useQuery({ queryKey: ['calendar', 'calendars'], queryFn: () => api<{ items: CalendarInfo[] }>('/api/v1/calendar/calendars') });
  const events = useQuery({
    queryKey: ['calendar', 'events', range.from.toISOString(), range.to.toISOString()],
    queryFn: () => api<{ items: Occurrence[] }>(`/api/v1/calendar/events?from=${range.from.toISOString()}&to=${range.to.toISOString()}`),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['calendar'] });
  useSocketEvent('calendar:changed', refresh);
  useSocketEvent('mail:changed', refresh);

  const visible = (events.data?.items ?? []).filter((e) => !hidden.has(e.calendarId) && e.status !== 'CANCELLED');
  const toggleCalendar = (id: string) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setHidden(next);
    try {
      localStorage.setItem('forge.calendar.hidden', JSON.stringify([...next]));
    } catch {
      /* ignore */
    }
  };

  const step = (dir: number) => setAnchor((a) => (view === 'day' ? addDays(a, dir) : view === 'week' ? addDays(a, 7 * dir) : new Date(a.getFullYear(), a.getMonth() + dir, 1)));
  const title =
    view === 'month'
      ? anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
      : view === 'week'
        ? `${range.from.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${addDays(range.to, -1).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
        : anchor.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

  if (calendars.isLoading) return <PageSpinner />;

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r border-zinc-200 bg-white p-3 lg:flex dark:border-zinc-800 dark:bg-zinc-900">
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({ start: nextHalfHour(), end: new Date(nextHalfHour().getTime() + 3600_000) })}>
          New event
        </Button>
        <MiniMonth anchor={anchor} onPick={(d) => setAnchor(d)} />
        <CalendarList calendars={calendars.data?.items ?? []} hidden={hidden} onToggle={toggleCalendar} />
      </aside>
      <section className="flex min-w-0 flex-1 flex-col bg-white dark:bg-zinc-900">
        <header className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <Button size="sm" onClick={() => setAnchor(startOfDay(new Date()))}>
            Today
          </Button>
          <button type="button" aria-label="Previous" className="rounded-lg p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={() => step(-1)}>
            <ChevronLeft className="size-5" />
          </button>
          <button type="button" aria-label="Next" className="rounded-lg p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={() => step(1)}>
            <ChevronRight className="size-5" />
          </button>
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{title}</h1>
          <div role="tablist" className="inline-flex rounded-lg bg-zinc-100 p-0.5 text-sm dark:bg-zinc-800">
            {(['day', 'week', 'month'] as View[]).map((v) => (
              <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)} className={cn('rounded-md px-3 py-1 capitalize', view === v && 'bg-white shadow-sm dark:bg-zinc-700')}>
                {v}
              </button>
            ))}
          </div>
          <Button size="sm" variant="primary" className="lg:hidden" aria-label="New event" icon={<Plus className="size-4" />} onClick={() => setEditing({ start: nextHalfHour(), end: new Date(nextHalfHour().getTime() + 3600_000) })} />
        </header>
        {view === 'month' ? (
          <MonthGrid from={range.from} anchor={anchor} events={visible} onPickDay={(d) => (setAnchor(d), setView('day'))} onSelect={setSelected} />
        ) : (
          <TimeGrid days={view === 'day' ? [anchor] : Array.from({ length: 7 }, (_, i) => addDays(range.from, i))} events={visible} onSelect={setSelected} onCreate={(start, end, allDay) => setEditing({ start, end, allDay })} />
        )}
      </section>
      {selected && <EventSummary occ={selected} calendars={calendars.data?.items ?? []} onClose={() => setSelected(null)} onEdit={(ev) => (setSelected(null), setEditing({ event: ev }))} />}
      {editing && <EventDialog calendars={calendars.data?.items ?? []} initial={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function nextHalfHour() {
  const d = new Date();
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return d;
}

function MiniMonth({ anchor, onPick }: { anchor: Date; onPick: (d: Date) => void }) {
  const [month, setMonth] = useState(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  useEffect(() => setMonth(new Date(anchor.getFullYear(), anchor.getMonth(), 1)), [anchor]);
  const start = startOfWeek(month);
  const today = new Date();
  return (
    <div className="text-xs">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-semibold">{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
        <span>
          <button type="button" aria-label="Previous month" className="p-1" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>
            <ChevronLeft className="size-3.5" />
          </button>
          <button type="button" aria-label="Next month" className="p-1" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>
            <ChevronRight className="size-3.5" />
          </button>
        </span>
      </div>
      <div className="grid grid-cols-7 text-center">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
          <span key={i} className="py-1 text-zinc-400">
            {d}
          </span>
        ))}
        {Array.from({ length: 42 }, (_, i) => addDays(start, i)).map((d) => (
          <button
            key={d.toISOString()}
            type="button"
            onClick={() => onPick(startOfDay(d))}
            className={cn(
              'mx-auto flex size-7 items-center justify-center rounded-full',
              d.getMonth() !== month.getMonth() && 'text-zinc-400',
              sameDay(d, today) && 'bg-brand font-semibold text-white',
              sameDay(d, anchor) && !sameDay(d, today) && 'bg-brand/15 font-semibold',
              'hover:bg-zinc-100 dark:hover:bg-zinc-800',
            )}
          >
            {d.getDate()}
          </button>
        ))}
      </div>
    </div>
  );
}

function CalendarList({ calendars, hidden, onToggle }: { calendars: CalendarInfo[]; hidden: Set<string>; onToggle: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [settings, setSettings] = useState<CalendarInfo | null>(null);
  const create = async () => {
    const name = window.prompt('Calendar name');
    if (!name) return;
    try {
      await api('/api/v1/calendar/calendars', { body: { name } });
      void qc.invalidateQueries({ queryKey: ['calendar', 'calendars'] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const groups = [
    { label: 'My calendars', items: calendars.filter((c) => !c.owner) },
    { label: 'Shared mailboxes', items: calendars.filter((c) => c.owner && c.ownerType === 'shared') },
    { label: 'Team calendars', items: calendars.filter((c) => c.owner && c.ownerType === 'group') },
    { label: 'Rooms', items: calendars.filter((c) => c.owner && c.ownerType === 'resource') },
    { label: 'Other people', items: calendars.filter((c) => c.owner && c.ownerType === 'user') },
  ].filter((g) => g.items.length);
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <div key={g.label}>
          <p className="mb-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">{g.label}</p>
          <ul className="space-y-0.5">
            {g.items.map((c) => (
              <li key={c.id} className="group relative">
                <button
                  type="button"
                  aria-label={`Settings for ${calendarLabel(c)}`}
                  title="Reminders and sharing"
                  onClick={() => setSettings(c)}
                  className="absolute top-1.5 right-1 z-10 hidden rounded p-1 text-zinc-400 group-hover:block hover:bg-zinc-200 hover:text-zinc-700 focus:block dark:hover:bg-zinc-700"
                >
                  <Settings2 className="size-3.5" />
                </button>
                <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 pr-7 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
                  <input type="checkbox" className="sr-only" checked={!hidden.has(c.id)} onChange={() => onToggle(c.id)} />
                  <span className="flex size-4 items-center justify-center rounded" style={{ background: hidden.has(c.id) ? 'transparent' : c.color, border: `2px solid ${c.color}` }}>
                    {!hidden.has(c.id) && <Check className="size-3 text-white" />}
                  </span>
                  <span className="min-w-0 leading-tight" title={c.owner ? `${OWNER_KIND[c.ownerType]}: ${c.owner}${c.ownerEmail ? ` <${c.ownerEmail}>` : ''}` : undefined}>
                    <span className="flex items-center gap-1 truncate">
                      {calendarLabel(c)}
                      {c.reminders && c.owner && <Bell className="size-3 shrink-0 text-zinc-400" aria-label="Reminders on" />}
                      {!c.reminders && !c.owner && <BellOff className="size-3 shrink-0 text-zinc-400" aria-label="Reminders off" />}
                    </span>
                    {(c.ownerEmail || c.access === 'read') && (
                      <span className="block truncate text-xs text-zinc-500">
                        {c.ownerEmail}
                        {c.ownerEmail && c.access === 'read' && ' · '}
                        {c.access === 'read' && 'read-only'}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <button type="button" onClick={() => void create()} className="flex items-center gap-2 px-2 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
        <Plus className="size-4" /> Add calendar
      </button>
      {settings && <CalendarSettings calendar={settings} onClose={() => setSettings(null)} />}
    </div>
  );
}

/** Side-by-side lanes for overlapping timed events in one day. */
function layoutDay(events: Occurrence[], day: Date) {
  const dayStart = startOfDay(day).getTime();
  const items = events
    .map((e) => ({ e, start: Math.max(new Date(e.start).getTime(), dayStart), end: Math.min(new Date(e.end).getTime(), dayStart + DAY_MS) }))
    .filter((x) => x.end > x.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const lanes: number[] = [];
  const placed = items.map((x) => {
    let lane = lanes.findIndex((end) => end <= x.start);
    if (lane < 0) lane = lanes.push(0) - 1;
    lanes[lane] = x.end;
    return { ...x, lane };
  });
  return placed.map((p) => ({ ...p, lanes: Math.max(1, ...placed.filter((o) => o.start < p.end && o.end > p.start).map((o) => o.lane + 1)) }));
}

function TimeGrid({ days, events, onSelect, onCreate }: { days: Date[]; events: Occurrence[]; onSelect: (e: Occurrence) => void; onCreate: (start: Date, end: Date, allDay?: boolean) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    scroller.current?.scrollTo({ top: HOUR_PX * 7.5 });
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  const allDay = events.filter((e) => e.allDay || new Date(e.end).getTime() - new Date(e.start).getTime() >= DAY_MS);
  const timed = events.filter((e) => !allDay.includes(e));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid border-b border-zinc-200 dark:border-zinc-800" style={{ gridTemplateColumns: `3.5rem repeat(${days.length}, minmax(0, 1fr))` }}>
        <div />
        {days.map((d) => (
          <div key={d.toISOString()} className="border-l border-zinc-100 px-2 py-1.5 text-center dark:border-zinc-800">
            <p className="text-xs text-zinc-500">{d.toLocaleDateString(undefined, { weekday: 'short' })}</p>
            <p className={cn('mx-auto flex size-8 items-center justify-center rounded-full text-lg', sameDay(d, now) && 'bg-brand font-semibold text-white')}>{d.getDate()}</p>
          </div>
        ))}
        <div className="py-1 pr-1 text-right text-[10px] text-zinc-400">all-day</div>
        {days.map((d) => (
          <div key={d.toISOString()} className="min-h-6 space-y-0.5 border-l border-zinc-100 p-0.5 dark:border-zinc-800" onDoubleClick={() => onCreate(d, addDays(d, 1), true)}>
            {allDay
              .filter((e) => new Date(e.start) < addDays(d, 1) && new Date(e.end) > d)
              .map((e) => (
                <button key={e.objectId + e.start} type="button" onClick={() => onSelect(e)} className="block w-full truncate rounded px-1.5 text-left text-xs text-white" style={{ background: e.color }}>
                  {e.summary}
                </button>
              ))}
          </div>
        ))}
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="relative grid" style={{ gridTemplateColumns: `3.5rem repeat(${days.length}, minmax(0, 1fr))`, height: HOUR_PX * 24 }}>
          <div>
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="relative text-right text-[10px] text-zinc-400" style={{ height: HOUR_PX }}>
                <span className="absolute -top-1.5 right-1">{h === 0 ? '' : new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' })}</span>
              </div>
            ))}
          </div>
          {days.map((d) => (
            <div
              key={d.toISOString()}
              className="relative border-l border-zinc-100 dark:border-zinc-800"
              onClick={(ev) => {
                if (ev.target !== ev.currentTarget) return;
                const rect = ev.currentTarget.getBoundingClientRect();
                const minutes = Math.floor(((ev.clientY - rect.top) / HOUR_PX) * 2) * 30;
                const start = new Date(startOfDay(d).getTime() + minutes * 60_000);
                onCreate(start, new Date(start.getTime() + 3600_000));
              }}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <div key={h} className="pointer-events-none border-t border-zinc-100 dark:border-zinc-800" style={{ height: HOUR_PX }} />
              ))}
              {sameDay(d, now) && <div className="pointer-events-none absolute right-0 left-0 z-10 border-t-2 border-red-500" style={{ top: ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX }} />}
              {layoutDay(timed, d).map(({ e, start, end, lane, lanes }) => {
                const top = ((start - startOfDay(d).getTime()) / 3600_000) * HOUR_PX;
                const height = Math.max(((end - start) / 3600_000) * HOUR_PX - 2, 18);
                const tentative = e.myStatus === 'NEEDS-ACTION' || e.myStatus === 'TENTATIVE';
                return (
                  <button
                    key={e.objectId + e.start}
                    type="button"
                    onClick={() => onSelect(e)}
                    className={cn('absolute overflow-hidden rounded-md px-1.5 py-0.5 text-left text-xs leading-tight shadow-sm', tentative ? 'border-2 border-dashed bg-white dark:bg-zinc-900' : 'text-white', e.myStatus === 'DECLINED' && 'line-through opacity-50')}
                    style={{ top, height, left: `calc(${(lane / lanes) * 100}% + 2px)`, width: `calc(${100 / lanes}% - 4px)`, background: tentative ? undefined : e.color, borderColor: e.color, color: tentative ? e.color : undefined }}
                  >
                    <p className="truncate font-medium">{e.summary || '(no title)'}</p>
                    {height > 30 && <p className="truncate opacity-90">{timeLabel(new Date(e.start))}{e.location ? ` · ${e.location}` : ''}</p>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MonthGrid({ from, anchor, events, onPickDay, onSelect }: { from: Date; anchor: Date; events: Occurrence[]; onPickDay: (d: Date) => void; onSelect: (e: Occurrence) => void }) {
  const today = new Date();
  return (
    <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-[auto_repeat(6,minmax(0,1fr))] overflow-y-auto">
      {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
        <div key={d} className="border-b border-zinc-200 py-1 text-center text-xs text-zinc-500 dark:border-zinc-800">
          {d}
        </div>
      ))}
      {Array.from({ length: 42 }, (_, i) => addDays(from, i)).map((d) => {
        const dayEvents = events.filter((e) => new Date(e.start) < addDays(d, 1) && new Date(e.end) > d);
        return (
          <div key={d.toISOString()} className={cn('min-h-24 border-r border-b border-zinc-100 p-1 dark:border-zinc-800', d.getMonth() !== anchor.getMonth() && 'bg-zinc-50 dark:bg-zinc-950')}>
            <button type="button" onClick={() => onPickDay(d)} className={cn('mb-0.5 flex size-6 items-center justify-center rounded-full text-xs', sameDay(d, today) && 'bg-brand font-semibold text-white')}>
              {d.getDate()}
            </button>
            {dayEvents.slice(0, 3).map((e) => (
              <button key={e.objectId + e.start} type="button" onClick={() => onSelect(e)} className="flex w-full items-center gap-1 truncate rounded px-1 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800">
                <span className="size-2 shrink-0 rounded-full" style={{ background: e.color }} />
                {!e.allDay && <span className="text-zinc-500">{timeLabel(new Date(e.start))}</span>}
                <span className="truncate">{e.summary}</span>
              </button>
            ))}
            {dayEvents.length > 3 && (
              <button type="button" onClick={() => onPickDay(d)} className="px-1 text-xs text-zinc-500 hover:underline">
                +{dayEvents.length - 3} more
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

const STATUS_LABEL: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  ACCEPTED: { label: 'Accepted', tone: 'success' },
  TENTATIVE: { label: 'Tentative', tone: 'warning' },
  DECLINED: { label: 'Declined', tone: 'danger' },
  'NEEDS-ACTION': { label: 'Awaiting reply', tone: 'neutral' },
};

function EventSummary({ occ, calendars, onClose, onEdit }: { occ: Occurrence; calendars: CalendarInfo[]; onClose: () => void; onEdit: (ev: EventDetail) => void }) {
  const cal = calendars.find((c) => c.id === occ.calendarId);
  const qc = useQueryClient();
  const toast = useToast();
  const { data: me } = useMe();
  const detail = useQuery({ queryKey: ['calendar', 'event', occ.objectId], queryFn: () => api<{ event: EventDetail }>(`/api/v1/calendar/events/${occ.objectId}`), enabled: occ.summary !== 'Busy' || occ.canEdit });
  const rsvp = useMutation({
    mutationFn: (status: string) => api(`/api/v1/calendar/events/${occ.objectId}/rsvp`, { body: { status } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['calendar'] });
      toast.success('Response sent');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/v1/calendar/events/${occ.objectId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['calendar'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const ev = detail.data?.event;
  const start = new Date(occ.start);
  const end = new Date(occ.end);
  // myStatus is computed for whoever you act as in this calendar (you, or a shared mailbox).
  const invited = occ.myStatus !== null && !occ.isOrganizer && occ.canEdit;
  void me;
  return (
    <Dialog
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <span className="size-3 rounded-full" style={{ background: occ.color }} /> {occ.summary || '(no title)'}
        </span>
      }
      footer={
        ev?.canEdit && (
          <>
            <Button variant="ghost" icon={<Trash2 className="size-4" />} loading={remove.isPending} onClick={() => remove.mutate()}>
              {occ.isOrganizer && occ.attendeeCount > 0 ? 'Cancel meeting' : 'Delete'}
            </Button>
            {occ.isOrganizer && <Button onClick={() => onEdit(ev)}>Edit</Button>}
          </>
        )
      }
    >
      <div className="space-y-3 text-sm">
        {cal && (
          <p className="flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
            <span className="size-3 shrink-0 rounded-sm" style={{ background: cal.color }} />
            {cal.owner ? (
              <span>
                {calendarLabel(cal)} <span className="text-zinc-500">· {OWNER_KIND[cal.ownerType]}{cal.ownerEmail ? ` · ${cal.ownerEmail}` : ''}</span>
              </span>
            ) : (
              <span>{cal.name} <span className="text-zinc-500">· your calendar</span></span>
            )}
          </p>
        )}
        <p className="flex items-center gap-2">
          <Clock className="size-4 text-zinc-400" />
          {occ.allDay ? start.toLocaleDateString(undefined, { dateStyle: 'full' }) : `${start.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })} – ${timeLabel(end)}`}
          {occ.recurring && <Repeat className="size-3.5 text-zinc-400" aria-label="Repeats" />}
        </p>
        {occ.location && (
          <p className="flex items-center gap-2">
            <MapPin className="size-4 text-zinc-400" /> {occ.location}
          </p>
        )}
        {occ.meetingUrl && (
          <a href={occ.meetingUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-3 py-1.5 font-medium text-white hover:bg-violet-500">
            <Video className="size-4" /> Join ForgeTeam meeting
          </a>
        )}
        {ev && ev.attendees.length > 0 && (
          <div>
            <p className="mb-1 flex items-center gap-2 font-medium">
              <Users className="size-4 text-zinc-400" /> {ev.attendees.length} participants
            </p>
            <ul className="space-y-1 pl-6">
              {ev.attendees.map((a) => (
                <li key={a.email} className="flex items-center justify-between gap-2">
                  <span className="truncate">
                    {a.name || a.email}
                    {a.email === ev.organizer && <span className="text-zinc-500"> · organiser</span>}
                    {a.cutype === 'ROOM' && <span className="text-zinc-500"> · room</span>}
                  </span>
                  <Badge tone={STATUS_LABEL[a.partstat]?.tone ?? 'neutral'}>{STATUS_LABEL[a.partstat]?.label ?? a.partstat}</Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
        {ev?.description && <p className="whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">{ev.description}</p>}
        {invited && (
          <div className="flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
            <span className="mr-auto text-zinc-500">Going?</span>
            {(['ACCEPTED', 'TENTATIVE', 'DECLINED'] as const).map((s) => (
              <Button key={s} size="sm" variant={occ.myStatus === s ? 'primary' : 'secondary'} onClick={() => rsvp.mutate(s)}>
                {s === 'ACCEPTED' ? 'Yes' : s === 'TENTATIVE' ? 'Maybe' : 'No'}
              </Button>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function EventDialog({ calendars, initial, onClose }: { calendars: CalendarInfo[]; initial: { event?: EventDetail; start?: Date; end?: Date; allDay?: boolean }; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: me } = useMe();
  const ev = initial.event;
  const writable = calendars.filter((c) => c.access === 'owner' || c.access === 'write');
  const resources = useQuery({ queryKey: ['calendar', 'resources'], queryFn: () => api<{ items: Resource[] }>('/api/v1/calendar/resources') });
  const [f, setF] = useState(() => ({
    calendarId: ev?.calendarId ?? writable.find((c) => c.isDefault)?.id ?? writable[0]?.id ?? '',
    summary: ev?.summary ?? '',
    start: toLocalInput(new Date(ev?.start ?? initial.start ?? nextHalfHour())),
    end: toLocalInput(new Date(ev?.end ?? initial.end ?? new Date(nextHalfHour().getTime() + 3600_000))),
    allDay: ev?.allDay ?? initial.allDay ?? false,
    location: ev?.location ?? '',
    description: ev?.description ?? '',
    attendees: (ev?.attendees ?? []).filter((a) => a.cutype !== 'ROOM' && a.email !== me?.user.email && a.email !== ev?.organizer).map((a) => ({ name: a.name, address: a.email })) as Addr[],
    resourceIds: [] as string[],
    repeat: ev?.recurrence?.freq ?? '',
    count: ev?.recurrence?.count ?? 10,
    addMeeting: !!ev?.meetingUrl,
    reminder: '15',
  }));
  useEffect(() => {
    if (!ev || !resources.data) return;
    const roomEmails = ev.attendees.filter((a) => a.cutype === 'ROOM').map((a) => a.email);
    setF((x) => ({ ...x, resourceIds: resources.data!.items.filter((r) => roomEmails.includes(r.email)).map((r) => r.id), location: x.location.split(', ').filter((p) => !resources.data!.items.some((r) => r.name === p)).join(', ') }));
  }, [ev, resources.data]);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  const startDate = new Date(f.start);
  const endDate = new Date(f.end);
  const roomEmails = (resources.data?.items ?? []).filter((r) => f.resourceIds.includes(r.id)).map((r) => r.email);
  const selfEmail = calendars.find((c) => c.id === f.calendarId)?.ownerEmail ?? me?.user.email ?? '';
  const people = [selfEmail, ...f.attendees.map((a) => a.address), ...roomEmails].filter(Boolean);
  const dayStart = startOfDay(startDate);

  const save = useMutation({
    mutationFn: () => {
      const start = f.allDay ? new Date(Date.UTC(startDate.getFullYear(), startDate.getMonth(), startDate.getDate())) : startDate;
      const end = f.allDay ? new Date(Date.UTC(endDate.getFullYear(), endDate.getMonth(), endDate.getDate()) + DAY_MS) : endDate;
      const body = {
        calendarId: f.calendarId,
        summary: f.summary,
        start: start.toISOString(),
        end: end.toISOString(),
        allDay: f.allDay,
        location: f.location,
        description: f.description,
        attendees: f.attendees.map((a) => ({ email: a.address, name: a.name })),
        resourceIds: f.resourceIds,
        recurrence: f.repeat ? { freq: f.repeat, count: f.count } : null,
        addMeeting: f.addMeeting,
        reminderMinutes: f.reminder === '' ? null : Number(f.reminder),
        transparent: false,
      };
      return ev ? api(`/api/v1/calendar/events/${ev.id}`, { method: 'PUT', body }) : api('/api/v1/calendar/events', { body });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['calendar'] });
      toast.success(f.attendees.length || f.resourceIds.length ? 'Saved and invitations sent' : 'Event saved');
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={ev ? 'Edit event' : 'New event'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!f.summary || !f.calendarId || endDate <= startDate} onClick={() => save.mutate()}>
            {f.attendees.length || f.resourceIds.length ? 'Send' : 'Save'}
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      <div className="space-y-4">
        <Input aria-label="Title" placeholder="Add a title" value={f.summary} onChange={(e) => set('summary', e.target.value)} autoFocus className="text-base font-medium" />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Starts" htmlFor="ev-start">
            <Input id="ev-start" type={f.allDay ? 'date' : 'datetime-local'} value={f.allDay ? f.start.slice(0, 10) : f.start} onChange={(e) => {
              const v = f.allDay ? `${e.target.value}T00:00` : e.target.value;
              const duration = endDate.getTime() - startDate.getTime();
              setF((x) => ({ ...x, start: v, end: toLocalInput(new Date(new Date(v).getTime() + Math.max(duration, 0))) }));
            }} />
          </Field>
          <Field label="Ends" htmlFor="ev-end">
            <Input id="ev-end" type={f.allDay ? 'date' : 'datetime-local'} value={f.allDay ? f.end.slice(0, 10) : f.end} onChange={(e) => set('end', f.allDay ? `${e.target.value}T00:00` : e.target.value)} />
          </Field>
        </div>
        <div className="flex flex-wrap gap-6">
          <Switch checked={f.allDay} onChange={(v) => set('allDay', v)} label="All day" />
          <Switch checked={f.addMeeting} onChange={(v) => set('addMeeting', v)} label="ForgeTeam meeting link" />
        </div>
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
          <RecipientInput label="With" value={f.attendees} onChange={(v) => set('attendees', v)} />
        </div>
        {(() => {
          const cal = calendars.find((c) => c.id === f.calendarId);
          return cal?.ownerType === 'shared' && (f.attendees.length > 0 || f.resourceIds.length > 0) ? (
            <p className="text-xs text-zinc-500">Invitations are sent from the shared mailbox {cal.ownerEmail}; replies arrive there.</p>
          ) : null;
        })()}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Room" htmlFor="ev-room">
            <Select
              id="ev-room"
              value=""
              onChange={(e) => e.target.value && set('resourceIds', [...new Set([...f.resourceIds, e.target.value])])}
            >
              <option value="">{resources.data?.items.length ? 'Add a room…' : 'No rooms set up'}</option>
              {resources.data?.items.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {r.capacity ? ` (${r.capacity})` : ''}
                </option>
              ))}
            </Select>
            {f.resourceIds.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {f.resourceIds.map((id) => (
                  <Badge key={id}>
                    {resources.data?.items.find((r) => r.id === id)?.name}
                    <button type="button" aria-label="Remove room" onClick={() => set('resourceIds', f.resourceIds.filter((x) => x !== id))}>
                      <X className="size-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </Field>
          <Field label="Location" htmlFor="ev-loc">
            <Input id="ev-loc" value={f.location} onChange={(e) => set('location', e.target.value)} />
          </Field>
        </div>
        {people.length > 1 && !f.allDay && <SchedulingAssistant emails={people} day={dayStart} start={startDate} end={endDate} />}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Calendar" htmlFor="ev-cal">
            <Select id="ev-cal" value={f.calendarId} onChange={(e) => set('calendarId', e.target.value)}>
              {writable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.owner ? `${calendarLabel(c)} (${c.ownerEmail ?? OWNER_KIND[c.ownerType]})` : c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Repeat" htmlFor="ev-repeat">
            <Select id="ev-repeat" value={f.repeat} onChange={(e) => set('repeat', e.target.value)}>
              <option value="">Does not repeat</option>
              <option value="DAILY">Daily</option>
              <option value="WEEKLY">Weekly</option>
              <option value="MONTHLY">Monthly</option>
              <option value="YEARLY">Yearly</option>
            </Select>
          </Field>
          <Field label="Reminder" htmlFor="ev-rem">
            <Select id="ev-rem" value={f.reminder} onChange={(e) => set('reminder', e.target.value)}>
              <option value="">None</option>
              <option value="0">At start</option>
              <option value="5">5 minutes before</option>
              <option value="15">15 minutes before</option>
              <option value="60">1 hour before</option>
              <option value="1440">1 day before</option>
            </Select>
          </Field>
        </div>
        {f.repeat && (
          <Field label="Number of occurrences" htmlFor="ev-count">
            <Input id="ev-count" type="number" min={1} max={999} value={f.count} onChange={(e) => set('count', Number(e.target.value))} className="w-32" />
          </Field>
        )}
        <Field label="Description" htmlFor="ev-desc">
          <Textarea id="ev-desc" rows={4} value={f.description} onChange={(e) => set('description', e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

/** Busy blocks for everyone involved, 07:00–20:00 on the chosen day. */
function SchedulingAssistant({ emails, day, start, end }: { emails: string[]; day: Date; start: Date; end: Date }) {
  const from = new Date(day.getTime() + 7 * 3600_000);
  const to = new Date(day.getTime() + 20 * 3600_000);
  const span = to.getTime() - from.getTime();
  const fb = useQuery({
    queryKey: ['calendar', 'freebusy', emails.join(','), day.toISOString()],
    queryFn: () => api<{ busy: Record<string, { start: string; end: string; status: string; summary?: string; location?: string }[] | null> }>('/api/v1/calendar/freebusy', { body: { emails, from: from.toISOString(), to: to.toISOString() } }),
  });
  const pct = (t: number) => `${Math.min(100, Math.max(0, ((t - from.getTime()) / span) * 100))}%`;
  return (
    <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <p className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Availability · {day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })}</p>
      <div className="space-y-1.5">
        {emails.map((email) => {
          const blocks = fb.data?.busy[email];
          return (
            <div key={email} className="flex items-center gap-2 text-xs">
              <span className="w-36 shrink-0 truncate" title={email}>
                {email}
              </span>
              <div className="relative h-5 flex-1 rounded bg-zinc-100 dark:bg-zinc-800">
                <div className="absolute inset-y-0 rounded bg-brand/25 ring-1 ring-brand" style={{ left: pct(start.getTime()), width: `calc(${pct(end.getTime())} - ${pct(start.getTime())})` }} />
                {blocks === null ? (
                  <span className="absolute inset-0 flex items-center px-2 text-zinc-400">No information</span>
                ) : (
                  blocks?.map((b, i) => (
                    <div
                      key={i}
                      title={`${b.summary ? `${b.summary} · ` : ''}${timeLabel(new Date(b.start))} – ${timeLabel(new Date(b.end))}${b.location ? ` · ${b.location}` : ''}`}
                      className={cn('absolute inset-y-0.5 overflow-hidden rounded-sm', b.status === 'tentative' ? 'bg-amber-400/70' : 'bg-zinc-500/70')}
                      style={{ left: pct(new Date(b.start).getTime()), width: `calc(${pct(new Date(b.end).getTime())} - ${pct(new Date(b.start).getTime())})` }}
                    >
                      {b.summary && <span className="block truncate px-1 text-[10px] leading-4 text-white">{b.summary}</span>}
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between pl-38 text-[10px] text-zinc-400">
        {[7, 10, 13, 16, 19].map((h) => (
          <span key={h}>{new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' })}</span>
        ))}
      </div>
    </div>
  );
}

function CalendarSettings({ calendar, onClose }: { calendar: CalendarInfo; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [sharing, setSharing] = useState(false);
  const reminders = useMutation({
    mutationFn: (enabled: boolean) => api(`/api/v1/calendar/calendars/${calendar.id}/reminders`, { method: 'PUT', body: { enabled } }),
    onSuccess: (_r, enabled) => {
      toast.success(enabled ? 'You will get reminders for this calendar' : 'Reminders turned off for you');
      void qc.invalidateQueries({ queryKey: ['calendar', 'calendars'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const [on, setOn] = useState(calendar.reminders);
  if (sharing) {
    return (
      <ShareDialog
        title={`Share “${calendarLabel(calendar)}”`}
        description="Only this calendar is shared. People see it in their calendar list and in calendar apps."
        levels={[
          { value: 'freebusy', label: 'Free/busy', description: 'See when you are busy, without details.' },
          { value: 'read', label: 'Read', description: 'See event titles, times and locations.' },
          { value: 'write', label: 'Write', description: 'Also create, change and delete events.' },
        ]}
        load={async () =>
          toGrants(
            (await api<{ items: { principalType: 'user' | 'group'; principalId: string; name: string; email?: string | null; access: string }[] }>(`/api/v1/calendar/calendars/${calendar.id}/shares`)).items.map((i) => ({ ...i, email: i.email ?? null })),
          )
        }
        save={(grants) =>
          api(`/api/v1/calendar/calendars/${calendar.id}/shares`, {
            method: 'PUT',
            body: { shares: grants.map(({ principalType, principalId, access }) => ({ principalType, principalId, access })) },
          })
        }
        onClose={onClose}
      />
    );
  }
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={calendarLabel(calendar)}
      description={calendar.owner ? `${OWNER_KIND[calendar.ownerType]}${calendar.ownerEmail ? ` · ${calendar.ownerEmail}` : ''}` : 'Your calendar'}
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <div className="space-y-5">
        <Switch
          checked={on}
          onChange={(v) => {
            setOn(v);
            reminders.mutate(v);
          }}
          label="Reminders on my devices"
          description="Only affects you. Phones and desktop calendar apps receive this calendar’s alerts only when this is on."
        />
        {calendar.canShare && (
          <div className="border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <p className="text-sm font-medium">Sharing</p>
            <p className="mb-3 text-sm text-zinc-500">Give specific people or groups free/busy, read or write access to just this calendar.</p>
            <Button icon={<Users className="size-4" />} onClick={() => setSharing(true)}>
              Share calendar…
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
