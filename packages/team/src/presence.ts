import type { Redis } from 'ioredis';
import { orm, userPresence, users, type Database } from '@forge/db';
import { freeBusy } from '@forge/calendar';

const { eq, inArray } = orm;

/**
 * Presence: Available, Busy, Do not disturb, Away, In a call, In a meeting
 * (calendar) and Offline. Worked out from:
 *   - heartbeats from open ForgeOffice tabs (Redis keys with a TTL: no
 *     heartbeat for 90 seconds means offline; "idle" means away),
 *   - being in a ForgeTeam call (also a TTL key),
 *   - the calendar (a busy event now means "In a meeting"),
 *   - a status someone set themselves, optionally until a time.
 */
export type PresenceStatus = 'available' | 'busy' | 'dnd' | 'away' | 'in_call' | 'in_meeting' | 'offline';

export interface Presence {
  status: PresenceStatus;
  /** The status was set by the person (not worked out). */
  manual: boolean;
  until: string | null;
  message: string;
}

export const PRESENCE_LABELS: Record<PresenceStatus, string> = {
  available: 'Available',
  busy: 'Busy',
  dnd: 'Do not disturb',
  away: 'Away',
  in_call: 'In a call',
  in_meeting: 'In a meeting',
  offline: 'Offline',
};

const HEARTBEAT_TTL_S = 90;
const CALL_TTL_S = 60;

/** Where heartbeats and calls are kept: Redis, or memory when running without it. */
export interface PresenceStore {
  heartbeat(userId: string, active: boolean): Promise<void>;
  setInCall(userId: string, inCall: boolean): Promise<void>;
  signals(userIds: string[]): Promise<Map<string, { online: 'active' | 'idle' | null; inCall: boolean }>>;
}

export function redisPresenceStore(redis: Redis): PresenceStore {
  return {
    async heartbeat(userId, active) {
      await redis.set(`forge:presence:hb:${userId}`, active ? 'active' : 'idle', 'EX', HEARTBEAT_TTL_S);
    },
    async setInCall(userId, inCall) {
      if (inCall) await redis.set(`forge:presence:call:${userId}`, '1', 'EX', CALL_TTL_S);
      else await redis.del(`forge:presence:call:${userId}`);
    },
    async signals(userIds) {
      const out = new Map<string, { online: 'active' | 'idle' | null; inCall: boolean }>();
      if (!userIds.length) return out;
      const hb = await redis.mget(userIds.map((id) => `forge:presence:hb:${id}`));
      const calls = await redis.mget(userIds.map((id) => `forge:presence:call:${id}`));
      userIds.forEach((id, i) => out.set(id, { online: (hb[i] as 'active' | 'idle' | null) ?? null, inCall: !!calls[i] }));
      return out;
    },
  };
}

export function memoryPresenceStore(now: () => number = Date.now): PresenceStore {
  const hb = new Map<string, { value: 'active' | 'idle'; exp: number }>();
  const calls = new Map<string, number>();
  return {
    async heartbeat(userId, active) {
      hb.set(userId, { value: active ? 'active' : 'idle', exp: now() + HEARTBEAT_TTL_S * 1000 });
    },
    async setInCall(userId, inCall) {
      if (inCall) calls.set(userId, now() + CALL_TTL_S * 1000);
      else calls.delete(userId);
    },
    async signals(userIds) {
      const out = new Map<string, { online: 'active' | 'idle' | null; inCall: boolean }>();
      for (const id of userIds) {
        const h = hb.get(id);
        const c = calls.get(id);
        out.set(id, { online: h && h.exp > now() ? h.value : null, inCall: !!c && c > now() });
      }
      return out;
    },
  };
}

/** Everyone's presence, worked out now. */
export async function computePresence(db: Database, store: PresenceStore, userIds: string[], now = new Date()): Promise<Record<string, Presence>> {
  const ids = [...new Set(userIds)];
  const out: Record<string, Presence> = {};
  if (!ids.length) return out;
  const signals = await store.signals(ids);
  const manual = await db.select().from(userPresence).where(inArray(userPresence.userId, ids));
  const people = await db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, ids));
  // Calendar: only for people who are online and haven't set a status.
  const calendarFor = people.filter((p) => signals.get(p.id)?.online && !manual.find((m) => m.userId === p.id && m.status && (!m.until || m.until > now)));
  let busy: Record<string, unknown[] | null> = {};
  if (calendarFor.length) {
    try {
      busy = await freeBusy(db, calendarFor.map((p) => p.email), now, new Date(now.getTime() + 60_000));
    } catch {
      busy = {};
    }
  }
  for (const id of ids) {
    const s = signals.get(id) ?? { online: null, inCall: false };
    const m = manual.find((x) => x.userId === id);
    const set = m?.status && (!m.until || m.until > now) ? m.status : null;
    const email = people.find((p) => p.id === id)?.email;
    const inMeeting = !!email && !!busy[email]?.length;
    let status: PresenceStatus;
    if (!s.online) status = 'offline';
    else if (set === 'offline') status = 'offline'; // "appear offline"
    else if (set === 'dnd') status = 'dnd';
    else if (s.inCall) status = 'in_call';
    else if (set) status = set;
    else if (inMeeting) status = 'in_meeting';
    else status = s.online === 'idle' ? 'away' : 'available';
    out[id] = { status, manual: !!set, until: set && m?.until ? m.until.toISOString() : null, message: m?.message ?? '' };
  }
  return out;
}

export async function setManualPresence(db: Database, userId: string, input: { status: 'available' | 'busy' | 'dnd' | 'away' | 'offline' | null; until?: Date | null; message?: string }) {
  await db
    .insert(userPresence)
    .values({ userId, status: input.status, until: input.until ?? null, message: input.message ?? '', updatedAt: new Date() })
    .onConflictDoUpdate({ target: userPresence.userId, set: { status: input.status, until: input.until ?? null, ...(input.message !== undefined ? { message: input.message } : {}), updatedAt: new Date() } });
  return (await db.select().from(userPresence).where(eq(userPresence.userId, userId)).limit(1))[0];
}
