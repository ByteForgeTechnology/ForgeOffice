import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff, Bold, Code, Download, File as FileIcon, FileText, Italic, Link2, MessageSquareReply, MoreHorizontal, Paperclip, Pencil, Play, Send, Smile, Trash2, Video, X } from 'lucide-react';
import { Avatar, Badge, Button, EmptyState, PageSpinner, cn, formatBytes, formatDateTime, formatRelative, useToast } from '@forge/ui';
import { api, errorMessage } from '../../lib/api';
import { Markdown, type MentionNames } from './markdown';
import { PRESENCE, ask, teamSocket, uploadForChannel, usePresence, useTeamEvent, type Attachment, type ChannelSummary, type Message, type Notify, type Presence } from './team-api';

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];
const EMOJI = ['😀', '😄', '😂', '🙂', '😉', '😍', '🤔', '😮', '😢', '😡', '👍', '👎', '👏', '🙏', '💪', '🎉', '🔥', '✅', '❌', '⚠️', '❤️', '👀', '🚀', '💡', '📌', '📎', '☕', '🍕', '🙌', '👋'];

interface ChannelDetail {
  channel: ChannelSummary;
  team: { id: string; name: string; color: string } | null;
  members: { id: string; name: string }[];
  canManage: boolean;
  teamRole: 'owner' | 'member' | null;
  notify: Notify;
  lastReadAt: string | null;
}
type Page = { items: Message[]; more: boolean };

export function PresenceDot({ p, className }: { p?: Presence; className?: string }) {
  const s = PRESENCE[p?.status ?? 'offline'];
  return <span title={p?.message ? `${s.label} · ${p.message}` : s.label} className={cn('block size-2.5 rounded-full ring-2 ring-white dark:ring-zinc-900', s.color, className)} />;
}

export function PersonAvatar({ name, presence, size = 'md', src }: { name: string; presence?: Presence; size?: 'sm' | 'md'; src?: string | null }) {
  return (
    <span className="relative inline-block shrink-0">
      <Avatar name={name} size={size} src={src} />
      {presence && <PresenceDot p={presence} className="absolute -right-0.5 -bottom-0.5" />}
    </span>
  );
}

const sameDay = (a: string, b: string) => new Date(a).toDateString() === new Date(b).toDateString();
const dayLabel = (d: string) => {
  const date = new Date(d);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
};
const time = (d: string) => new Date(d).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const duration = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 1 ? 'less than a minute' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

/** People who can be mentioned here (team members, or the chat's members). */
function useMentionables(detail?: ChannelDetail) {
  const team = useQuery({
    queryKey: ['team', 'team', detail?.team?.id],
    queryFn: () => api<{ members: { id: string; name: string; jobTitle: string | null }[] }>(`/api/v1/team/teams/${detail!.team!.id}`),
    enabled: !!detail?.team && detail.channel.kind === 'standard',
    staleTime: 60_000,
  });
  return useMemo(() => (detail?.channel.kind === 'standard' ? (team.data?.members ?? []) : (detail?.members ?? [])), [detail, team.data]);
}

// ---------------------------------------------------------------------------
// A conversation: header, posts or files, composer, thread
// ---------------------------------------------------------------------------

export function ConversationView({ channelId, meId, title, onManage }: { channelId: string; meId: string; title: string; onManage: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'posts' | 'files'>('posts');
  const [thread, setThread] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ['team', 'channel', channelId], queryFn: () => api<ChannelDetail>(`/api/v1/team/channels/${channelId}`), retry: false });
  const mentionables = useMentionables(detail.data);
  const names: MentionNames = useMemo(() => Object.fromEntries(mentionables.map((m) => [m.id.toLowerCase(), m.name])), [mentionables]);
  const isChat = detail.data?.channel.kind === 'dm' || detail.data?.channel.kind === 'group';
  useEffect(() => {
    setThread(null);
    setTab('posts');
  }, [channelId]);

  const meet = useMutation({
    mutationFn: () => api<{ meeting: { code: string } }>('/api/v1/team/meetings', { body: { channelId } }),
    onSuccess: (r) => navigate(`/team/meet/${r.meeting.code}`),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const notify = useMutation({
    mutationFn: (n: Notify | null) => api<{ notify: Notify }>(`/api/v1/team/channels/${channelId}/notify`, { method: 'PUT', body: { notify: n } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['team', 'channel', channelId] });
      void qc.invalidateQueries({ queryKey: ['team', 'home'] });
    },
  });

  if (detail.error) return <EmptyState icon={<MessageSquareReply />} title="Conversation not found" description="It was deleted, or you’re no longer in it." />;
  if (!detail.data) return <PageSpinner />;
  const d = detail.data;
  const nextNotify: Record<Notify, Notify> = { all: 'mentions', mentions: 'muted', muted: 'all' };
  const NOTIFY_LABEL: Record<Notify, string> = { all: 'Every message', mentions: 'Only @mentions', muted: 'Muted' };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-semibold">{title}</h1>
            {d.team && <p className="truncate text-xs text-zinc-500">{d.team.name}{d.channel.description ? ` · ${d.channel.description}` : ''}</p>}
            {isChat && d.members.length > 2 && <p className="truncate text-xs text-zinc-500">{d.members.length} people</p>}
          </div>
          <div role="tablist" className="flex gap-1">
            {(['posts', 'files'] as const).map((t) => (
              <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)} className={cn('rounded-md px-3 py-1.5 text-sm', tab === t ? 'bg-zinc-100 font-medium dark:bg-zinc-800' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200')}>
                {t === 'posts' ? (isChat ? 'Chat' : 'Posts') : 'Files'}
              </button>
            ))}
          </div>
          <Button size="sm" variant="primary" icon={<Video className="size-4" />} loading={meet.isPending} onClick={() => meet.mutate()}>
            Meet
          </Button>
          <button type="button" title={`Notifications: ${NOTIFY_LABEL[d.notify]} (click to change)`} aria-label={`Notifications: ${NOTIFY_LABEL[d.notify]}`} onClick={() => notify.mutate(nextNotify[d.notify])} className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            {d.notify === 'muted' ? <BellOff className="size-4" /> : <Bell className={cn('size-4', d.notify === 'all' && 'fill-current')} />}
          </button>
          <button type="button" aria-label="Conversation settings" onClick={onManage} className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <MoreHorizontal className="size-4" />
          </button>
        </header>
        {tab === 'posts' ? (
          <>
            <MessageList channelId={channelId} detail={d} meId={meId} names={names} onThread={isChat ? null : setThread} />
            <Composer channelId={channelId} parentId={null} mentionables={mentionables} meId={meId} placeholder={isChat ? 'Type a message' : 'Start a new conversation. Type @ to mention someone.'} />
          </>
        ) : (
          <FilesTab channelId={channelId} />
        )}
      </div>
      {thread && <ThreadPanel channelId={channelId} messageId={thread} meId={meId} names={names} mentionables={mentionables} canModerate={d.canManage && !isChat} onClose={() => setThread(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function MessageList({ channelId, detail, meId, names, onThread }: { channelId: string; detail: ChannelDetail; meId: string; names: MentionNames; onThread: ((id: string) => void) | null }) {
  const qc = useQueryClient();
  const key = ['team', 'messages', channelId];
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [typing, setTyping] = useState<Record<string, { name: string; at: number }>>({});
  const q = useQuery({ queryKey: key, queryFn: () => api<Page>(`/api/v1/team/channels/${channelId}/messages?limit=50`) });
  const firstUnread = useRef<string | null>(detail.lastReadAt);
  useEffect(() => {
    firstUnread.current = detail.lastReadAt;
  }, [channelId]); // eslint-disable-line react-hooks/exhaustive-deps

  const markRead = useCallback(() => {
    if (document.visibilityState !== 'visible') return;
    void api(`/api/v1/team/channels/${channelId}/read`, { body: {} }).then(() => {
      qc.setQueryData<{ teams: { channels: ChannelSummary[] }[]; chats: ChannelSummary[] }>(['team', 'home'], (h) =>
        h
          ? {
              ...h,
              teams: h.teams.map((t) => ({ ...t, channels: t.channels.map((c) => (c.id === channelId ? { ...c, unread: 0, mentions: 0 } : c)) })),
              chats: h.chats.map((c) => (c.id === channelId ? { ...c, unread: 0, mentions: 0 } : c)),
            }
          : h,
      );
    });
  }, [channelId, qc]);
  useEffect(() => {
    markRead();
    const v = () => markRead();
    document.addEventListener('visibilitychange', v);
    return () => document.removeEventListener('visibilitychange', v);
  }, [markRead]);

  // Live updates
  useTeamEvent<{ message: Message }>('message:new', ({ message }) => {
    if (message.channelId !== channelId) return;
    qc.setQueryData<Page>(key, (p) => {
      if (!p) return p;
      if (message.parentId) return { ...p, items: p.items.map((m) => (m.id === message.parentId ? { ...m, replyCount: m.replyCount + 1, lastReplyAt: message.createdAt } : m)) };
      if (p.items.some((m) => m.id === message.id)) return p;
      return { ...p, items: [...p.items, message] };
    });
    if (message.author) setTyping((t) => Object.fromEntries(Object.entries(t).filter(([id]) => id !== message.author!.id)));
    markRead();
  });
  useTeamEvent<{ message: Message }>('message:updated', ({ message }) => {
    if (message.channelId !== channelId) return;
    qc.setQueryData<Page>(key, (p) => (p ? { ...p, items: p.items.map((m) => (m.id === message.id ? message : m)) } : p));
    qc.setQueryData<{ message: Message; replies: Message[] }>(['team', 'thread', message.parentId ?? message.id], (t) =>
      t ? (t.message.id === message.id ? { ...t, message } : { ...t, replies: t.replies.map((r) => (r.id === message.id ? message : r)) }) : t,
    );
  });
  useTeamEvent<{ channelId: string; userId: string; name: string }>('typing', (e) => {
    if (e.channelId === channelId) setTyping((t) => ({ ...t, [e.userId]: { name: e.name, at: Date.now() } }));
  });
  useEffect(() => {
    const t = setInterval(() => setTyping((all) => Object.fromEntries(Object.entries(all).filter(([, v]) => Date.now() - v.at < 6000))), 2000);
    return () => clearInterval(t);
  }, []);

  // Stay at the bottom as messages arrive (unless reading older ones).
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [q.data?.items.length]);
  useEffect(() => {
    atBottom.current = true;
  }, [channelId]);

  const loadOlder = async () => {
    const p = qc.getQueryData<Page>(key);
    if (!p?.more || loadingOlder || !p.items.length) return;
    setLoadingOlder(true);
    const el = scroller.current!;
    const before = el.scrollHeight;
    try {
      const older = await api<Page>(`/api/v1/team/channels/${channelId}/messages?limit=50&before=${encodeURIComponent(p.items[0]!.createdAt)}`);
      qc.setQueryData<Page>(key, (cur) => (cur ? { items: [...older.items, ...cur.items], more: older.more } : cur));
      requestAnimationFrame(() => (el.scrollTop = el.scrollHeight - before));
    } finally {
      setLoadingOlder(false);
    }
  };

  const authorIds = useMemo(() => [...new Set((q.data?.items ?? []).map((m) => m.author?.id).filter(Boolean) as string[])], [q.data]);
  const presence = usePresence(authorIds);
  const typingNames = Object.entries(typing).filter(([id]) => id !== meId).map(([, v]) => v.name);

  if (!q.data) return <div className="flex-1"><PageSpinner /></div>;
  const items = q.data.items;
  return (
    <div
      ref={scroller}
      className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        if (el.scrollTop < 200) void loadOlder();
      }}
    >
      {q.data.more ? <p className="py-2 text-center text-xs text-zinc-500">{loadingOlder ? 'Loading…' : 'Scroll up for older messages'}</p> : <ConversationStart detail={detail} />}
      {items.map((m, i) => {
        const prev = items[i - 1];
        const newDay = !prev || !sameDay(prev.createdAt, m.createdAt);
        const grouped = !newDay && prev && prev.kind === 'message' && m.kind === 'message' && prev.author?.id === m.author?.id && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000 && !prev.replyCount;
        const showUnread = firstUnread.current && m.author?.id !== meId && new Date(m.createdAt) > new Date(firstUnread.current) && (!prev || new Date(prev.createdAt) <= new Date(firstUnread.current));
        return (
          <Fragment key={m.id}>
            {newDay && (
              <div className="my-3 flex items-center gap-3 text-xs text-zinc-500">
                <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
                {dayLabel(m.createdAt)}
                <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
              </div>
            )}
            {showUnread && (
              <div className="my-2 flex items-center gap-3 text-xs font-medium text-red-600">
                <span className="h-px flex-1 bg-red-300" />
                New
                <span className="h-px flex-1 bg-red-300" />
              </div>
            )}
            <MessageItem message={m} channelId={channelId} meId={meId} names={names} grouped={!!grouped} presence={m.author ? presence[m.author.id] : undefined} canModerate={detail.canManage && detail.channel.kind !== 'dm' && detail.channel.kind !== 'group'} onThread={onThread} />
          </Fragment>
        );
      })}
      <p className="h-5 px-12 text-xs text-zinc-500" aria-live="polite">
        {typingNames.length ? `${typingNames.slice(0, 3).join(', ')}${typingNames.length > 3 ? ' and others' : ''} ${typingNames.length === 1 ? 'is' : 'are'} typing…` : ''}
      </p>
    </div>
  );
}

function ConversationStart({ detail }: { detail: ChannelDetail }) {
  const c = detail.channel;
  return (
    <div className="py-6 text-center text-sm text-zinc-500">
      {c.kind === 'dm' ? 'This is the start of your chat.' : c.kind === 'group' ? 'This is the start of the group chat.' : `Welcome to ${c.isGeneral ? `${detail.team?.name ?? 'the team'}` : c.name}${c.kind === 'private' ? ' (private channel)' : ''}.`}
    </div>
  );
}

function MessageItem({ message: m, channelId, meId, names, grouped, presence, canModerate, onThread, inThread }: { message: Message; channelId: string; meId: string; names: MentionNames; grouped: boolean; presence?: Presence; canModerate: boolean; onThread: ((id: string) => void) | null; inThread?: boolean }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [picker, setPicker] = useState(false);
  const base = `/api/v1/team/channels/${channelId}/messages/${m.id}`;
  const react = (emoji: string) => {
    const mine = m.reactions.find((r) => r.emoji === emoji)?.userIds.includes(meId);
    setPicker(false);
    api(`${base}/reactions`, { method: 'PUT', body: { emoji, on: !mine } }).catch((e) => toast.error(errorMessage(e)));
  };

  if (m.kind === 'system') return <p className="my-2 text-center text-xs text-zinc-500">{m.body} · {time(m.createdAt)}</p>;
  const mine = m.author?.id === meId;
  return (
    <div className={cn('group relative flex gap-3 rounded-lg px-2 hover:bg-zinc-50 dark:hover:bg-zinc-900/60', grouped ? 'py-0.5' : 'mt-2 pt-1.5 pb-0.5', m.mentions.includes(meId) && 'bg-amber-50/60 dark:bg-amber-950/20')}>
      <div className="w-9 shrink-0">{!grouped && (m.author ? <PersonAvatar name={m.author.name} src={m.author.avatarUrl} presence={presence} /> : <span className="flex size-9 items-center justify-center rounded-full bg-violet-600 text-white"><Video className="size-4" /></span>)}</div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <p className="flex items-baseline gap-2 text-sm">
            <span className="font-semibold">{m.author?.name ?? 'ForgeTeam'}</span>
            <time className="text-xs text-zinc-500" dateTime={m.createdAt} title={formatDateTime(m.createdAt)}>
              {time(m.createdAt)}
            </time>
          </p>
        )}
        {m.deleted ? (
          <p className="text-sm text-zinc-400 italic">This message was deleted.</p>
        ) : editing ? (
          <Composer channelId={channelId} parentId={null} mentionables={Object.entries(names).map(([id, name]) => ({ id, name }))} meId={meId} editing={m} onDone={() => setEditing(false)} placeholder="Edit message" />
        ) : m.kind === 'meeting' ? (
          <MeetingCard message={m} />
        ) : m.kind === 'recording' ? (
          <RecordingCard message={m} />
        ) : (
          <>
            {m.body && <Markdown text={m.body} names={names} me={meId} />}
            {m.editedAt && <span className="text-xs text-zinc-400">(edited)</span>}
            {m.attachments.length > 0 && <Attachments items={m.attachments} />}
          </>
        )}
        {!m.deleted && m.reactions.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {m.reactions.map((r) => (
              <button key={r.emoji} type="button" title={r.userIds.map((id) => (id === meId ? 'You' : (names[id] ?? 'Someone'))).join(', ')} onClick={() => react(r.emoji)} className={cn('flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ring-1', r.userIds.includes(meId) ? 'bg-brand/10 ring-brand' : 'ring-zinc-200 hover:ring-zinc-400 dark:ring-zinc-700')}>
                {r.emoji} <span>{r.count}</span>
              </button>
            ))}
          </div>
        )}
        {!inThread && onThread && m.replyCount > 0 && (
          <button type="button" onClick={() => onThread(m.id)} className="mt-1 text-xs font-medium text-brand hover:underline">
            {m.replyCount} {m.replyCount === 1 ? 'reply' : 'replies'} · last {formatRelative(m.lastReplyAt)}
          </button>
        )}
      </div>
      {!m.deleted && !editing && m.kind !== 'meeting' && (
        <div className="absolute -top-3 right-2 hidden items-center gap-0.5 rounded-lg bg-white p-0.5 shadow ring-1 ring-zinc-200 group-hover:flex group-focus-within:flex dark:bg-zinc-900 dark:ring-zinc-700">
          {QUICK_REACTIONS.slice(0, 3).map((e) => (
            <button key={e} type="button" aria-label={`React with ${e}`} onClick={() => react(e)} className="rounded px-1 py-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800">
              {e}
            </button>
          ))}
          <button type="button" aria-label="More reactions" onClick={() => setPicker((p) => !p)} className="rounded p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <Smile className="size-4" />
          </button>
          {!inThread && onThread && (
            <button type="button" aria-label="Reply in thread" onClick={() => onThread(m.id)} className="rounded p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800">
              <MessageSquareReply className="size-4" />
            </button>
          )}
          {mine && m.kind === 'message' && (
            <button type="button" aria-label="Edit" onClick={() => setEditing(true)} className="rounded p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800">
              <Pencil className="size-4" />
            </button>
          )}
          {(mine || canModerate) && (
            <button type="button" aria-label="Delete" onClick={() => window.confirm('Delete this message?') && api(base, { method: 'DELETE' }).catch((e) => toast.error(errorMessage(e)))} className="rounded p-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-950">
              <Trash2 className="size-4" />
            </button>
          )}
        </div>
      )}
      {picker && (
        <div className="absolute top-6 right-2 z-10 grid grid-cols-8 gap-0.5 rounded-lg bg-white p-1.5 shadow-lg ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-700">
          {EMOJI.map((e) => (
            <button key={e} type="button" onClick={() => react(e)} className="rounded p-1 text-lg hover:bg-zinc-100 dark:hover:bg-zinc-800">
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Attachments({ items }: { items: Attachment[] }) {
  return (
    <ul className="mt-1 flex flex-wrap gap-2">
      {items.map((a) => (
        <li key={a.itemId}>
          {a.mime?.startsWith('image/') ? <ImageAttachment a={a} /> : <FileChip a={a} />}
        </li>
      ))}
    </ul>
  );
}

function FileChip({ a }: { a: Attachment }) {
  const Icon = a.mime === 'application/pdf' || a.mime?.startsWith('text/') ? FileText : FileIcon;
  return (
    <a href={`/drive?item=${a.itemId}`} className="flex max-w-72 items-center gap-2 rounded-lg px-3 py-2 text-sm ring-1 ring-zinc-200 hover:ring-brand dark:ring-zinc-700">
      <Icon className="size-5 shrink-0 text-zinc-400" />
      <span className="min-w-0">
        <span className="block truncate font-medium">{a.name}</span>
        <span className="block text-xs text-zinc-500">{formatBytes(a.size)}</span>
      </span>
    </a>
  );
}

function ImageAttachment({ a }: { a: Attachment }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    void import('../drive/drive-api').then((m) => m.contentUrl(a.itemId)).then(setUrl, () => setUrl(null));
  }, [a.itemId]);
  if (!url) return <FileChip a={a} />;
  return (
    <a href={`/drive?item=${a.itemId}`} title={a.name}>
      <img src={url} alt={a.name} className="max-h-60 max-w-80 rounded-lg object-cover ring-1 ring-zinc-200 dark:ring-zinc-700" loading="lazy" />
    </a>
  );
}

function MeetingCard({ message: m }: { message: Message }) {
  const navigate = useNavigate();
  const meta = m.meta ?? {};
  const ended = !!meta.endedAt;
  return (
    <div className="mt-1 flex max-w-md items-center gap-3 rounded-xl p-3 ring-1 ring-zinc-200 dark:ring-zinc-700">
      <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg text-white', ended ? 'bg-zinc-400' : 'bg-violet-600')}>
        <Video className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{meta.title ?? 'Meeting'}</p>
        <p className="text-xs text-zinc-500">{ended ? `Ended · ${duration(meta.durationMs ?? 0)}${meta.participants?.length ? ` · ${meta.participants.join(', ')}` : ''}` : `Started by ${m.author?.name ?? 'someone'}`}</p>
      </div>
      {!ended && (
        <Button size="sm" variant="primary" onClick={() => navigate(`/team/meet/${meta.code}`)}>
          Join
        </Button>
      )}
    </div>
  );
}

function RecordingCard({ message: m }: { message: Message }) {
  const toast = useToast();
  const meta = m.meta ?? {};
  const [url, setUrl] = useState<string | null>(null);
  const load = async (download = false) => {
    try {
      const r = await api<{ url: string }>(`/api/v1/team/recordings/${meta.recordingId}/url`);
      if (download) window.location.assign(`${r.url}?download=true`);
      else setUrl(r.url);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <div className="mt-1 max-w-xl rounded-xl p-3 ring-1 ring-zinc-200 dark:ring-zinc-700">
      <p className="text-sm font-medium">Recording: {meta.title ?? 'Meeting'}</p>
      <p className="mb-2 text-xs text-zinc-500">
        {duration(meta.durationMs ?? 0)} · {formatBytes(meta.size ?? 0)}
      </p>
      {url ? (
        <video src={url} controls autoPlay className="w-full rounded-lg bg-black" />
      ) : (
        <div className="flex gap-2">
          <Button size="sm" icon={<Play className="size-4" />} onClick={() => void load()}>
            Play
          </Button>
          <Button size="sm" variant="ghost" icon={<Download className="size-4" />} onClick={() => void load(true)}>
            Download
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------

function ThreadPanel({ channelId, messageId, meId, names, mentionables, canModerate, onClose }: { channelId: string; messageId: string; meId: string; names: MentionNames; mentionables: { id: string; name: string }[]; canModerate: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const key = ['team', 'thread', messageId];
  const q = useQuery({ queryKey: key, queryFn: () => api<{ message: Message; replies: Message[] }>(`/api/v1/team/channels/${channelId}/messages/${messageId}/replies`) });
  useTeamEvent<{ message: Message }>('message:new', ({ message }) => {
    if (message.parentId === messageId) qc.setQueryData<{ message: Message; replies: Message[] }>(key, (t) => (t && !t.replies.some((r) => r.id === message.id) ? { ...t, replies: [...t.replies, message] } : t));
  });
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [q.data?.replies.length]);
  return (
    <aside aria-label="Thread" className="fixed inset-0 z-30 flex w-full flex-col border-l border-zinc-200 bg-white md:static md:z-auto md:w-96 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <p className="font-medium">Thread</p>
        <button type="button" aria-label="Close thread" onClick={onClose} className="rounded p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800">
          <X className="size-4" />
        </button>
      </div>
      {!q.data ? (
        <PageSpinner />
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            <MessageItem message={q.data.message} channelId={channelId} meId={meId} names={names} grouped={false} canModerate={canModerate} onThread={null} inThread />
            <p className="my-2 px-2 text-xs text-zinc-500">{q.data.replies.length} {q.data.replies.length === 1 ? 'reply' : 'replies'}</p>
            {q.data.replies.map((r, i) => (
              <MessageItem key={r.id} message={r} channelId={channelId} meId={meId} names={names} grouped={i > 0 && q.data!.replies[i - 1]!.author?.id === r.author?.id} canModerate={canModerate} onThread={null} inThread />
            ))}
            <div ref={end} />
          </div>
          <Composer channelId={channelId} parentId={messageId} mentionables={mentionables} meId={meId} placeholder="Reply" />
        </>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Composer: markdown, @mentions, emoji, files
// ---------------------------------------------------------------------------

/** In the editor mentions read "@Name"; they are sent as <@id>. */
const toEditor = (body: string, names: Record<string, string>) => body.replace(/<@([0-9a-f-]{36})>/gi, (_, id: string) => `@${names[id.toLowerCase()] ?? 'someone'}`);
function toWire(text: string, people: { id: string; name: string }[]) {
  let out = text;
  // Longest names first, so "@Ann Lee" wins over "@Ann".
  for (const p of [...people].sort((a, b) => b.name.length - a.name.length)) out = out.split(`@${p.name}`).join(`<@${p.id}>`);
  return out;
}

function Composer({ channelId, parentId, mentionables, meId, placeholder, editing, onDone }: { channelId: string; parentId: string | null; mentionables: { id: string; name: string }[]; meId: string; placeholder: string; editing?: Message; onDone?: () => void }) {
  const toast = useToast();
  const names = useMemo(() => Object.fromEntries(mentionables.map((m) => [m.id.toLowerCase(), m.name])), [mentionables]);
  const draftKey = `forge:team:draft:${channelId}:${parentId ?? ''}`;
  const [text, setText] = useState(() => (editing ? toEditor(editing.body, names) : (() => { try { return localStorage.getItem(draftKey) ?? ''; } catch { return ''; } })()));
  const [files, setFiles] = useState<{ file: File; sent: number }[]>([]);
  const [sending, setSending] = useState(false);
  const [emoji, setEmoji] = useState(false);
  const [mention, setMention] = useState<{ query: string; start: number; index: number } | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) return;
    try {
      if (text) localStorage.setItem(draftKey, text);
      else localStorage.removeItem(draftKey);
    } catch {
      /* drafts are a convenience */
    }
  }, [text, draftKey, editing]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);
  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  const candidates = mention ? mentionables.filter((p) => p.id !== meId && p.name.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 6) : [];
  const insert = (snippet: string, cursorOffset = snippet.length, replaceFrom?: number) => {
    const el = ref.current!;
    const start = replaceFrom ?? el.selectionStart;
    const end = el.selectionEnd;
    const next = text.slice(0, start) + snippet + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + cursorOffset, start + cursorOffset);
    });
  };
  const wrap = (before: string, after = before) => {
    const el = ref.current!;
    const sel = text.slice(el.selectionStart, el.selectionEnd) || 'text';
    insert(`${before}${sel}${after}`, before.length + sel.length + after.length);
  };
  const pick = (p: { id: string; name: string }) => {
    if (!mention) return;
    insert(`@${p.name} `, p.name.length + 2, mention.start);
    setMention(null);
  };
  const addFiles = (list: File[]) => setFiles((f) => [...f, ...list.slice(0, 20 - f.length).map((file) => ({ file, sent: 0 }))]);

  const send = async () => {
    const body = toWire(text.trim(), mentionables);
    if ((!body && !files.length) || sending) return;
    setSending(true);
    try {
      if (editing) {
        await api(`/api/v1/team/channels/${channelId}/messages/${editing.id}`, { method: 'PATCH', body: { body } });
        onDone?.();
        return;
      }
      const attachments = files.length ? await uploadForChannel(channelId, files.map((f) => f.file), (name, sent) => setFiles((fs) => fs.map((f) => (f.file.name === name ? { ...f, sent } : f)))) : [];
      await api(`/api/v1/team/channels/${channelId}/messages`, { body: { body, parentId: parentId ?? undefined, attachments: attachments.map((a) => a.itemId) } });
      setText('');
      setFiles([]);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className={cn(editing ? 'mt-1' : 'border-t border-zinc-200 px-4 py-3 dark:border-zinc-800')}
      onDragOver={(e: DragEvent) => !editing && e.dataTransfer.types.includes('Files') && e.preventDefault()}
      onDrop={(e: DragEvent) => {
        if (editing || !e.dataTransfer.files.length) return;
        e.preventDefault();
        addFiles([...e.dataTransfer.files]);
      }}
    >
      <div className="relative rounded-xl ring-1 ring-zinc-300 focus-within:ring-2 focus-within:ring-brand dark:ring-zinc-700">
        {files.length > 0 && (
          <ul className="flex flex-wrap gap-2 px-3 pt-2">
            {files.map((f, i) => (
              <li key={i} className="flex items-center gap-2 rounded-lg bg-zinc-100 px-2 py-1 text-xs dark:bg-zinc-800">
                <Paperclip className="size-3.5" />
                <span className="max-w-40 truncate">{f.file.name}</span>
                {sending ? <span className="text-zinc-500">{Math.round((100 * f.sent) / Math.max(1, f.file.size))}%</span> : <span className="text-zinc-500">{formatBytes(f.file.size)}</span>}
                {!sending && (
                  <button type="button" aria-label={`Remove ${f.file.name}`} onClick={() => setFiles((fs) => fs.filter((_, n) => n !== i))}>
                    <X className="size-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label={placeholder}
          className="block max-h-60 w-full resize-none border-0 bg-transparent px-3 py-2.5 text-sm focus:ring-0"
          onChange={(e) => {
            setText(e.target.value);
            const caret = e.target.selectionStart;
            const m = /(^|\s)@([^\s@]{0,30}(?: [^\s@]{0,30})?)$/.exec(e.target.value.slice(0, caret));
            setMention(m ? { query: m[2]!, start: caret - m[2]!.length - 1, index: 0 } : null);
            if (!editing && e.target.value) teamSocket().emit('typing', { channelId });
          }}
          onPaste={(e: ClipboardEvent) => {
            const pasted = [...e.clipboardData.files];
            if (pasted.length && !editing) {
              e.preventDefault();
              addFiles(pasted);
            }
          }}
          onKeyDown={(e) => {
            if (mention && candidates.length) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setMention({ ...mention, index: (mention.index + (e.key === 'ArrowDown' ? 1 : candidates.length - 1)) % candidates.length });
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                pick(candidates[mention.index]!);
                return;
              }
              if (e.key === 'Escape') return setMention(null);
            }
            if (e.key === 'Escape' && editing) return onDone?.();
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {mention && candidates.length > 0 && (
          <ul role="listbox" className="absolute bottom-full left-2 z-20 mb-1 w-64 overflow-hidden rounded-lg bg-white py-1 shadow-lg ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-700">
            {candidates.map((p, i) => (
              <li key={p.id} role="option" aria-selected={i === mention.index}>
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(p)} className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm', i === mention.index ? 'bg-zinc-100 dark:bg-zinc-800' : '')}>
                  <Avatar name={p.name} size="sm" /> {p.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-0.5 px-2 pb-1.5">
          <ToolButton label="Bold" onClick={() => wrap('**')}>
            <Bold className="size-4" />
          </ToolButton>
          <ToolButton label="Italic" onClick={() => wrap('*')}>
            <Italic className="size-4" />
          </ToolButton>
          <ToolButton label="Code" onClick={() => (text.slice(ref.current!.selectionStart, ref.current!.selectionEnd).includes('\n') ? wrap('```\n', '\n```') : wrap('`'))}>
            <Code className="size-4" />
          </ToolButton>
          <ToolButton
            label="Link"
            onClick={() => {
              const url = window.prompt('Link address', 'https://');
              if (url && /^(https?:|mailto:)/i.test(url)) wrap('[', `](${url})`);
            }}
          >
            <Link2 className="size-4" />
          </ToolButton>
          <span className="relative">
            <ToolButton label="Emoji" onClick={() => setEmoji((v) => !v)}>
              <Smile className="size-4" />
            </ToolButton>
            {emoji && (
              <div className="absolute bottom-full left-0 z-20 mb-1 grid w-64 grid-cols-8 gap-0.5 rounded-lg bg-white p-1.5 shadow-lg ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-700">
                {EMOJI.map((e) => (
                  <button key={e} type="button" onClick={() => (insert(e), setEmoji(false))} className="rounded p-1 text-lg hover:bg-zinc-100 dark:hover:bg-zinc-800">
                    {e}
                  </button>
                ))}
              </div>
            )}
          </span>
          {!editing && (
            <>
              <ToolButton label="Attach files" onClick={() => fileInput.current?.click()}>
                <Paperclip className="size-4" />
              </ToolButton>
              <input ref={fileInput} type="file" multiple hidden onChange={(e) => (addFiles([...(e.target.files ?? [])]), (e.target.value = ''))} />
            </>
          )}
          <span className="flex-1" />
          {editing && (
            <Button size="sm" variant="ghost" onClick={onDone}>
              Cancel
            </Button>
          )}
          <Button size="sm" variant="primary" icon={editing ? undefined : <Send className="size-4" />} loading={sending} disabled={!text.trim() && !files.length} onClick={() => void send()} aria-label={editing ? 'Save' : 'Send'}>
            {editing ? 'Save' : ''}
          </Button>
        </div>
      </div>
      {!editing && <p className="mt-1 hidden text-xs text-zinc-400 sm:block">Enter to send · Shift+Enter for a new line · **bold**, *italic*, `code`</p>}
    </div>
  );
}

function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} onMouseDown={(e) => e.preventDefault()} onClick={onClick} className="rounded p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200">
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Files shared in the conversation
// ---------------------------------------------------------------------------

function FilesTab({ channelId }: { channelId: string }) {
  const q = useQuery({ queryKey: ['team', 'files', channelId], queryFn: () => api<{ folder: { libraryId: string; folderId: string } | null; items: (Attachment & { messageId: string; sharedBy: string | null; sharedAt: string })[] }>(`/api/v1/team/channels/${channelId}/files`) });
  if (!q.data) return <PageSpinner />;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      {q.data.folder && (
        <a href={`/drive?library=${q.data.folder.libraryId}&folder=${q.data.folder.folderId}`} className="mb-4 inline-flex items-center gap-2 text-sm text-brand hover:underline">
          Open this channel’s folder in Drive
        </a>
      )}
      {!q.data.items.length ? (
        <EmptyState icon={<Paperclip />} title="No files yet" description="Files shared here appear in this list (and in Drive)." />
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {q.data.items.map((f) => (
            <li key={`${f.messageId}${f.itemId}`} className="flex items-center gap-3 py-2 text-sm">
              <FileIcon className="size-5 shrink-0 text-zinc-400" />
              <a href={`/drive?item=${f.itemId}`} className="min-w-0 flex-1 truncate font-medium hover:underline">
                {f.name}
              </a>
              <span className="hidden text-zinc-500 sm:inline">{f.sharedBy}</span>
              <span className="text-zinc-500">{formatRelative(f.sharedAt)}</span>
              <Badge>{formatBytes(f.size)}</Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}


