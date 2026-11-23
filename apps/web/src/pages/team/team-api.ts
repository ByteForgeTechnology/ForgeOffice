import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { api } from '../../lib/api';
import { getAccessToken } from '../../lib/auth';

export type Notify = 'all' | 'mentions' | 'muted';

export interface ChannelSummary {
  id: string;
  teamId: string | null;
  kind: 'standard' | 'private' | 'dm' | 'group';
  name: string;
  description: string;
  isGeneral: boolean;
  folderId: string | null;
  lastMessageAt: string | null;
  unread: number;
  mentions: number;
  notify: Notify;
  members?: { id: string; name: string; avatarUrl?: string | null }[];
}

export interface TeamSummary {
  id: string;
  name: string;
  description: string;
  color: string;
  visibility: 'public' | 'private';
  groupId: string;
  role: 'owner' | 'member';
  channels: ChannelSummary[];
}

export interface Home {
  me: { id: string; name: string };
  canCreateTeams: boolean;
  teams: TeamSummary[];
  chats: ChannelSummary[];
}

export interface Attachment {
  itemId: string;
  name: string;
  size: number;
  mime: string | null;
}

export interface Message {
  id: string;
  channelId: string;
  parentId: string | null;
  kind: 'message' | 'meeting' | 'recording' | 'system';
  author: { id: string; name: string; avatarUrl?: string | null } | null;
  body: string;
  mentions: string[];
  attachments: Attachment[];
  meta: Record<string, any> | null;
  reactions: { emoji: string; count: number; userIds: string[] }[];
  replyCount: number;
  lastReplyAt: string | null;
  editedAt: string | null;
  deleted: boolean;
  createdAt: string;
}

export type PresenceStatus = 'available' | 'busy' | 'dnd' | 'away' | 'in_call' | 'in_meeting' | 'offline';
export interface Presence {
  status: PresenceStatus;
  manual: boolean;
  until: string | null;
  message: string;
}

export const PRESENCE: Record<PresenceStatus, { label: string; color: string }> = {
  available: { label: 'Available', color: 'bg-emerald-500' },
  busy: { label: 'Busy', color: 'bg-red-500' },
  dnd: { label: 'Do not disturb', color: 'bg-red-600' },
  away: { label: 'Away', color: 'bg-amber-400' },
  in_call: { label: 'In a call', color: 'bg-red-500' },
  in_meeting: { label: 'In a meeting', color: 'bg-red-500' },
  offline: { label: 'Offline', color: 'bg-zinc-400' },
};

/** A chat's title: its name, or the other people in it. */
export const chatTitle = (c: Pick<ChannelSummary, 'kind' | 'name' | 'members'>, meId: string) =>
  c.name || (c.members ?? []).filter((m) => m.id !== meId).map((m) => m.name).join(', ') || 'Just you';

// ---------------------------------------------------------------------------
// The Team socket (messages, typing, presence, meetings)
// ---------------------------------------------------------------------------

let socket: Socket | null = null;

export function teamSocket(): Socket {
  socket ??= io({
    path: '/team-socket',
    transports: ['websocket'],
    auth: (cb) => void getAccessToken().then((token) => cb({ token })),
  });
  return socket;
}

/** A separate connection for a guest in a meeting (with their guest pass). */
export function guestSocket(pass: string): Socket {
  return io({ path: '/team-socket', transports: ['websocket'], auth: { guest: pass }, forceNew: true });
}

export function useTeamEvent<T>(event: string, handler: (payload: T) => void, s: Socket | null = null) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const sock = s ?? teamSocket();
    const listener = (p: T) => ref.current(p);
    sock.on(event, listener);
    return () => void sock.off(event, listener);
  }, [event, s]);
}

/** Ask the server something over the socket (with an acknowledgement). */
export function ask<T = Record<string, any>>(s: Socket, event: string, payload: unknown = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    s.timeout(15_000).emit(event, payload, (err: Error | null, res: { ok: boolean; error?: string } & T) => {
      if (err) return reject(new Error('The server did not answer'));
      if (!res.ok) return reject(new Error(res.error ?? 'Something went wrong'));
      resolve(res);
    });
  });
}

/**
 * Tell the server we're here: a heartbeat every minute, "away" after five
 * minutes without keyboard or mouse activity (or when the tab is hidden).
 */
export function usePresenceHeartbeat() {
  useEffect(() => {
    const s = teamSocket();
    let last = Date.now();
    const activity = () => {
      const wasIdle = Date.now() - last > 5 * 60_000;
      last = Date.now();
      if (wasIdle) beat();
    };
    const beat = () => s.emit('presence:heartbeat', { active: Date.now() - last < 5 * 60_000 && document.visibilityState === 'visible' });
    const timer = setInterval(beat, 60_000);
    const events = ['keydown', 'mousemove', 'pointerdown', 'focus'] as const;
    for (const e of events) window.addEventListener(e, activity, { passive: true });
    document.addEventListener('visibilitychange', beat);
    s.on('connect', beat);
    return () => {
      clearInterval(timer);
      for (const e of events) window.removeEventListener(e, activity);
      document.removeEventListener('visibilitychange', beat);
      s.off('connect', beat);
    };
  }, []);
}

/** Presence of people, kept live by the socket. */
export function usePresence(ids: string[]) {
  const qc = useQueryClient();
  const key = [...new Set(ids)].sort().join(',');
  const q = useQuery({
    queryKey: ['team', 'presence', key],
    queryFn: () => api<{ items: Record<string, Presence> }>(`/api/v1/team/presence?ids=${key}`),
    enabled: !!key,
    staleTime: 60_000,
  });
  useTeamEvent<{ userId: string } & Presence>('presence', (p) => {
    for (const [k, v] of qc.getQueriesData<{ items: Record<string, Presence> }>({ queryKey: ['team', 'presence'] })) {
      if (v?.items[p.userId]) qc.setQueryData(k, { items: { ...v.items, [p.userId]: { status: p.status, manual: p.manual, until: p.until, message: p.message } } });
    }
  });
  return q.data?.items ?? {};
}

export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Upload files for a conversation (into its folder) and return their Drive ids. */
export async function uploadForChannel(channelId: string, files: File[], onProgress: (name: string, sent: number, size: number) => void) {
  const { uploadFile } = await import('../drive/drive-api');
  const target = await api<{ libraryId: string; parentId: string }>(`/api/v1/team/channels/${channelId}/upload-target`);
  const out = [];
  for (const f of files) {
    const item = await uploadFile(f, target, (sent) => onProgress(f.name, sent, f.size), { conflict: 'rename' });
    out.push({ itemId: item.id, name: item.name, size: item.size, mime: item.mime });
  }
  return out;
}
