import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Hash, Lock, LogOut, Menu, MessageSquarePlus, Plus, Search, Trash2, UserPlus, Users, X } from 'lucide-react';
import { Alert, Avatar, Badge, Button, Dialog, EmptyState, Field, Input, PageSpinner, Select, Switch, Textarea, cn, useToast } from '@forge/ui';
import { api, errorMessage } from '../../lib/api';
import { useMe } from '../../lib/hooks';
import { ConversationView, PersonAvatar, PresenceDot } from './Conversation';
import { plainText } from './markdown';
import { PRESENCE, chatTitle, usePresence, usePresenceHeartbeat, useTeamEvent, type ChannelSummary, type Home, type Message, type Presence, type PresenceStatus, type TeamSummary } from './team-api';

/** The Team app: chats and teams on the left, the conversation on the right. */
export function TeamPage() {
  const { channelId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [sidebar, setSidebar] = useState(false);
  const [dialog, setDialog] = useState<null | 'chat' | 'team' | 'join' | { channel: TeamSummary } | { manage: string }>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('forge:team:collapsed') ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const [filter, setFilter] = useState('');
  usePresenceHeartbeat();
  const home = useQuery({ queryKey: ['team', 'home'], queryFn: () => api<Home>('/api/v1/team/home') });
  const h = home.data;
  const refresh = () => void qc.invalidateQueries({ queryKey: ['team', 'home'] });

  // Keep the sidebar live.
  useTeamEvent('team:changed', refresh);
  useTeamEvent('chat:changed', refresh);
  useTeamEvent<{ channelId: string }>('channel:read', ({ channelId: id }) => bump(id, () => ({ unread: 0, mentions: 0 })));
  useTeamEvent<{ message: Message }>('message:new', ({ message }) => {
    if (!h) return;
    const known = [...h.teams.flatMap((t) => t.channels), ...h.chats].find((c) => c.id === message.channelId);
    if (!known) return refresh(); // a new chat
    const mine = message.author?.id === h.me.id;
    const viewing = message.channelId === channelId && document.visibilityState === 'visible';
    if (!mine && !viewing && !message.parentId) bump(message.channelId, (c) => ({ unread: c.unread + 1, mentions: c.mentions + (message.mentions.includes(h.me.id) ? 1 : 0), lastMessageAt: message.createdAt }));
    else bump(message.channelId, () => ({ lastMessageAt: message.createdAt }));
    // Desktop notification, as the conversation's notification level says.
    const mentioned = message.mentions.includes(h.me.id);
    const alert = known.notify === 'all' || mentioned;
    if (!mine && !viewing && alert && message.kind !== 'system' && 'Notification' in window && Notification.permission === 'granted') {
      const where = known.teamId ? `${h.teams.find((t) => t.id === known.teamId)?.name ?? ''} › ${known.name}` : chatTitle(known, h.me.id);
      const n = new Notification(`${message.author?.name ?? 'ForgeTeam'}${mentioned ? ' mentioned you' : ''}`, { body: `${where}\n${plainText(message.body, {}) || (message.attachments.length ? 'Sent a file' : message.kind === 'meeting' ? 'Started a meeting' : '')}`, tag: message.channelId });
      n.onclick = () => {
        window.focus();
        navigate(`/team/c/${message.channelId}`);
      };
    }
  });
  const bump = (id: string, patch: (c: ChannelSummary) => Partial<ChannelSummary>) =>
    qc.setQueryData<Home>(['team', 'home'], (cur) =>
      cur
        ? {
            ...cur,
            teams: cur.teams.map((t) => ({ ...t, channels: t.channels.map((c) => (c.id === id ? { ...c, ...patch(c) } : c)) })),
            chats: cur.chats.map((c) => (c.id === id ? { ...c, ...patch(c) } : c)).sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '')),
          }
        : cur,
    );

  // Unread count in the tab title.
  const unread = useMemo(() => (h ? [...h.teams.flatMap((t) => t.channels), ...h.chats].reduce((n, c) => n + (c.notify === 'muted' ? 0 : c.kind === 'dm' || c.kind === 'group' ? c.unread : c.mentions), 0) : 0), [h]);
  useEffect(() => {
    document.title = `${unread ? `(${unread}) ` : ''}Team · ForgeOffice`;
  }, [unread]);

  const dmPeople = useMemo(() => (h ? h.chats.filter((c) => c.kind === 'dm').flatMap((c) => (c.members ?? []).filter((m) => m.id !== h.me.id).map((m) => m.id)) : []), [h]);
  const presence = usePresence(h ? [h.me.id, ...dmPeople] : []);

  if (home.error) return <EmptyState icon={<Users />} title="ForgeTeam isn’t available" description={errorMessage(home.error)} />;
  if (!h) return <PageSpinner />;
  const all = [...h.teams.flatMap((t) => t.channels.map((c) => ({ ...c, team: t }))), ...h.chats.map((c) => ({ ...c, team: null as TeamSummary | null }))];
  const current = all.find((c) => c.id === channelId);
  const title = current ? (current.team ? (current.isGeneral ? `${current.team.name} › General` : `${current.team.name} › ${current.name}`) : chatTitle(current, h.me.id)) : '';
  const q = filter.trim().toLowerCase();
  const go = (id: string) => {
    navigate(`/team/c/${id}`);
    setSidebar(false);
  };
  const toggle = (id: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem('forge:team:collapsed', JSON.stringify([...next]));
      } catch {
        /* remembered per browser only */
      }
      return next;
    });

  return (
    <div className="flex h-full">
      <aside className={cn('w-72 shrink-0 flex-col overflow-y-auto border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950', sidebar ? 'fixed inset-y-0 left-0 z-30 flex shadow-xl' : 'hidden md:flex')}>
        <div className="flex items-center gap-2 p-3">
          <StatusPicker me={h.me} presence={presence[h.me.id]} />
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-zinc-400" />
            <input aria-label="Find a chat or channel" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find" className="h-8 w-full rounded-lg border-0 bg-white pr-2 pl-8 text-sm ring-1 ring-zinc-200 focus:ring-2 focus:ring-brand dark:bg-zinc-900 dark:ring-zinc-800" />
          </div>
        </div>

        <SectionHeader title="Chat" action={{ label: 'New chat', icon: MessageSquarePlus, onClick: () => setDialog('chat') }} />
        <ul className="space-y-0.5 px-2">
          {h.chats
            .filter((c) => !q || chatTitle(c, h.me.id).toLowerCase().includes(q))
            .map((c) => {
              const other = c.kind === 'dm' ? (c.members ?? []).find((m) => m.id !== h.me.id) : null;
              return (
                <li key={c.id}>
                  <NavRow active={c.id === channelId} unread={c.unread} mentions={c.mentions} muted={c.notify === 'muted'} onClick={() => go(c.id)}>
                    {other ? <PersonAvatar name={other.name} src={other.avatarUrl} presence={presence[other.id]} size="sm" /> : <span className="flex size-6 items-center justify-center rounded-full bg-zinc-300 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200"><Users className="size-3.5" /></span>}
                    <span className="min-w-0 flex-1 truncate">{chatTitle(c, h.me.id)}</span>
                  </NavRow>
                </li>
              );
            })}
          {!h.chats.length && <li className="px-2 py-1 text-xs text-zinc-500">No chats yet.</li>}
        </ul>

        <SectionHeader title="Teams" action={h.canCreateTeams ? { label: 'Create a team', icon: Plus, onClick: () => setDialog('team') } : undefined} />
        <ul className="space-y-0.5 px-2 pb-2">
          {h.teams.map((t) => {
            const open = !collapsed.has(t.id) || !!q;
            const channels = t.channels.filter((c) => !q || c.name.toLowerCase().includes(q) || t.name.toLowerCase().includes(q));
            if (q && !channels.length) return null;
            return (
              <li key={t.id}>
                <div className="group flex items-center">
                  <button type="button" aria-expanded={open} onClick={() => toggle(t.id)} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800">
                    {open ? <ChevronDown className="size-3.5 shrink-0 text-zinc-400" /> : <ChevronRight className="size-3.5 shrink-0 text-zinc-400" />}
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-semibold text-white" style={{ background: t.color }}>
                      {t.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{t.name}</span>
                    {!open && t.channels.some((c) => c.mentions) && <Badge tone="danger">@</Badge>}
                  </button>
                  <button type="button" aria-label={`Add a channel to ${t.name}`} title="Add a channel" onClick={() => setDialog({ channel: t })} className="rounded p-1 text-zinc-400 opacity-0 group-hover:opacity-100 hover:bg-zinc-100 focus:opacity-100 dark:hover:bg-zinc-800">
                    <Plus className="size-4" />
                  </button>
                </div>
                {open && (
                  <ul className="ml-6 space-y-0.5">
                    {channels.map((c) => (
                      <li key={c.id}>
                        <NavRow active={c.id === channelId} unread={c.unread} mentions={c.mentions} muted={c.notify === 'muted'} onClick={() => go(c.id)}>
                          {c.kind === 'private' ? <Lock className="size-3.5 shrink-0 text-zinc-400" /> : <Hash className="size-3.5 shrink-0 text-zinc-400" />}
                          <span className="min-w-0 flex-1 truncate">{c.name}</span>
                        </NavRow>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
          <li>
            <button type="button" onClick={() => setDialog('join')} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
              <UserPlus className="size-4" /> Join a team
            </button>
          </li>
        </ul>
        <NotificationPrompt />
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <button type="button" aria-label="Chats and teams" onClick={() => setSidebar(true)} className="m-2 self-start rounded-lg p-1.5 hover:bg-zinc-100 md:hidden dark:hover:bg-zinc-800">
          <Menu className="size-5" />
        </button>
        {current ? (
          <ConversationView key={current.id} channelId={current.id} meId={h.me.id} title={title} onManage={() => setDialog({ manage: current.id })} />
        ) : channelId ? (
          <EmptyState icon={<Hash />} title="Conversation not found" description="It was deleted, or you’re no longer in it." />
        ) : (
          <Welcome home={h} onChat={() => setDialog('chat')} onTeam={() => setDialog('team')} onJoin={() => setDialog('join')} />
        )}
      </section>

      {dialog === 'chat' && <NewChatDialog meId={h.me.id} onClose={() => setDialog(null)} onOpen={(id) => (setDialog(null), go(id))} />}
      {dialog === 'team' && <CreateTeamDialog onClose={() => setDialog(null)} onCreated={(id) => (setDialog(null), go(id))} />}
      {dialog === 'join' && <JoinTeamDialog onClose={() => setDialog(null)} onJoined={() => (setDialog(null), refresh())} />}
      {dialog && typeof dialog === 'object' && 'channel' in dialog && <NewChannelDialog team={dialog.channel} meId={h.me.id} onClose={() => setDialog(null)} onCreated={(id) => (setDialog(null), go(id))} />}
      {dialog && typeof dialog === 'object' && 'manage' in dialog && current && (
        <ManageDialog
          channel={current}
          team={current.team}
          meId={h.me.id}
          onClose={() => setDialog(null)}
          onGone={() => {
            setDialog(null);
            refresh();
            navigate('/team');
          }}
        />
      )}
    </div>
  );
}

function SectionHeader({ title, action }: { title: string; action?: { label: string; icon: typeof Plus; onClick: () => void } }) {
  return (
    <div className="flex items-center justify-between px-4 pt-3 pb-1">
      <p className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">{title}</p>
      {action && (
        <button type="button" aria-label={action.label} title={action.label} onClick={action.onClick} className="rounded p-1 text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800">
          <action.icon className="size-4" />
        </button>
      )}
    </div>
  );
}

function NavRow({ active, unread, mentions, muted, onClick, children }: { active: boolean; unread: number; mentions: number; muted: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm',
        active ? 'bg-white font-medium shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800',
        unread > 0 && !muted && !active && 'font-semibold text-zinc-900 dark:text-white',
        muted && 'text-zinc-500',
      )}
    >
      {children}
      {mentions > 0 ? <Badge tone="danger">@{mentions > 1 ? mentions : ''}</Badge> : unread > 0 && !muted && !active ? <span className="size-2 shrink-0 rounded-full bg-brand" aria-label={`${unread} unread`} /> : null}
    </button>
  );
}

function StatusPicker({ me, presence }: { me: { id: string; name: string }; presence?: Presence }) {
  const qc = useQueryClient();
  const profile = useMe();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState(presence?.message ?? '');
  const set = async (status: PresenceStatus | null, untilHours?: number) => {
    try {
      await api('/api/v1/team/presence', { method: 'PUT', body: { status, until: untilHours ? new Date(Date.now() + untilHours * 3_600_000).toISOString() : null, message } });
      void qc.invalidateQueries({ queryKey: ['team', 'presence'] });
      setOpen(false);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const choices: { status: PresenceStatus | null; label: string }[] = [
    { status: null, label: 'Automatic' },
    { status: 'available', label: 'Available' },
    { status: 'busy', label: 'Busy' },
    { status: 'dnd', label: 'Do not disturb' },
    { status: 'away', label: 'Appear away' },
    { status: 'offline', label: 'Appear offline' },
  ];
  return (
    <div className="relative">
      <button type="button" aria-label={`Your status: ${PRESENCE[presence?.status ?? 'offline'].label}`} onClick={() => setOpen((o) => !o)} className="rounded-full">
        <PersonAvatar name={me.name} src={profile.data?.user.avatarUrl} presence={presence} />
      </button>
      {open && (
        <div className="absolute top-11 left-0 z-30 w-64 rounded-xl bg-white p-2 shadow-xl ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-700">
          <p className="px-2 pb-1 text-sm font-medium">{me.name}</p>
          {choices.map((c) => (
            <button key={c.label} type="button" onClick={() => void set(c.status)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
              {c.status ? <PresenceDot p={{ status: c.status === 'offline' ? 'offline' : c.status, manual: true, until: null, message: '' }} /> : <span className="block size-2.5 rounded-full ring-2 ring-zinc-300" />}
              {c.label}
              {(presence?.manual ? presence.status === c.status : !c.status) && <span className="ml-auto text-xs text-zinc-500">current</span>}
            </button>
          ))}
          <div className="mt-1 border-t border-zinc-100 pt-2 dark:border-zinc-800">
            <Input aria-label="Status message" placeholder="Status message" value={message} onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void set(presence?.manual ? presence.status : null)} />
            <p className="mt-1 px-1 text-xs text-zinc-500">Automatic follows your activity, calls and calendar.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function NotificationPrompt() {
  const [perm, setPerm] = useState(() => ('Notification' in window ? Notification.permission : 'denied'));
  if (perm !== 'default') return null;
  return (
    <div className="m-3 mt-auto rounded-lg bg-white p-3 text-xs ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
      Get desktop notifications for chats and @mentions.
      <Button size="sm" className="mt-2 w-full" onClick={() => void Notification.requestPermission().then(setPerm)}>
        Turn on notifications
      </Button>
    </div>
  );
}

function Welcome({ home, onChat, onTeam, onJoin }: { home: Home; onChat: () => void; onTeam: () => void; onJoin: () => void }) {
  return (
    <div className="m-auto max-w-md p-6 text-center">
      <Users className="mx-auto mb-3 size-10 text-brand" />
      <h1 className="text-xl font-semibold">Welcome to Team, {home.me.name.split(' ')[0]}</h1>
      <p className="mt-1 text-sm text-zinc-500">Chat with colleagues, work in channels with your teams, and meet with audio, video and screen sharing.</p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <Button variant="primary" icon={<MessageSquarePlus className="size-4" />} onClick={onChat}>
          New chat
        </Button>
        {home.canCreateTeams && (
          <Button icon={<Plus className="size-4" />} onClick={onTeam}>
            Create a team
          </Button>
        )}
        <Button icon={<UserPlus className="size-4" />} onClick={onJoin}>
          Join a team
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// People picker and dialogs
// ---------------------------------------------------------------------------

type Person = { id: string; name: string };

function PeoplePicker({ value, onChange, exclude = [], label = 'People', restrictTo }: { value: Person[]; onChange: (p: Person[]) => void; exclude?: string[]; label?: string; restrictTo?: Person[] }) {
  const [text, setText] = useState('');
  const term = text.trim();
  const results = useQuery({
    queryKey: ['directory', 'people', term],
    queryFn: () => api<{ people: { id: string; displayName: string; jobTitle?: string | null }[] }>(`/api/v1/directory/search?q=${encodeURIComponent(term)}&limit=8`),
    enabled: term.length > 0 && !restrictTo,
  });
  const options = (restrictTo ? restrictTo.filter((p) => p.name.toLowerCase().includes(term.toLowerCase())) : (results.data?.people ?? []).map((p) => ({ id: p.id, name: p.displayName }))).filter((p) => !exclude.includes(p.id) && !value.some((v) => v.id === p.id));
  return (
    <Field label={label} htmlFor="people-picker">
      <div className="rounded-lg p-1.5 ring-1 ring-zinc-300 focus-within:ring-2 focus-within:ring-brand dark:ring-zinc-700">
        <div className="flex flex-wrap gap-1">
          {value.map((p) => (
            <span key={p.id} className="flex items-center gap-1 rounded-full bg-zinc-100 py-0.5 pr-1 pl-2 text-sm dark:bg-zinc-800">
              {p.name}
              <button type="button" aria-label={`Remove ${p.name}`} onClick={() => onChange(value.filter((v) => v.id !== p.id))} className="rounded-full p-0.5 hover:bg-zinc-200 dark:hover:bg-zinc-700">
                <X className="size-3" />
              </button>
            </span>
          ))}
          <input id="people-picker" value={text} onChange={(e) => setText(e.target.value)} placeholder={value.length ? '' : 'Type a name'} className="min-w-32 flex-1 border-0 bg-transparent p-1 text-sm focus:ring-0" autoComplete="off" />
        </div>
      </div>
      {(term || restrictTo) && options.length > 0 && (
        <ul className="mt-1 max-h-48 overflow-y-auto rounded-lg ring-1 ring-zinc-200 dark:ring-zinc-700">
          {options.slice(0, 8).map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => (onChange([...value, p]), setText(''))} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
                <Avatar name={p.name} size="sm" /> {p.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Field>
  );
}

function NewChatDialog({ meId, onClose, onOpen }: { meId: string; onClose: () => void; onOpen: (id: string) => void }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const open = useMutation({
    mutationFn: () => api<{ channel: { id: string } }>('/api/v1/team/chats', { body: { userIds: people.map((p) => p.id), name: people.length > 1 && name.trim() ? name.trim() : undefined } }),
    onSuccess: (r) => onOpen(r.channel.id),
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Dialog open onClose={onClose} title="New chat" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!people.length} loading={open.isPending} onClick={() => open.mutate()}>Chat</Button></>}>
      {error && <Alert tone="danger" className="mb-3">{error}</Alert>}
      <div className="space-y-3">
        <PeoplePicker label="To" value={people} onChange={setPeople} exclude={[meId]} />
        {people.length > 1 && (
          <Field label="Group name (optional)" htmlFor="chat-name">
            <Input id="chat-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        )}
      </div>
    </Dialog>
  );
}

function CreateTeamDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (generalId: string) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: '', description: '', visibility: 'private' as 'private' | 'public', color: '#7c3aed' });
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api<{ generalChannelId: string }>('/api/v1/team/teams', { body: { ...f, name: f.name.trim(), memberIds: people.map((p) => p.id) } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['team', 'home'] });
      onCreated(r.generalChannelId);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Dialog open onClose={onClose} title="Create a team" description="A team gets a General channel, a document library in Drive, and can hold meetings." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.name.trim()} loading={create.isPending} onClick={() => create.mutate()}>Create</Button></>}>
      {error && <Alert tone="danger" className="mb-3">{error}</Alert>}
      <div className="space-y-3">
        <Field label="Name" htmlFor="t-name">
          <Input id="t-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Marketing" />
        </Field>
        <Field label="Description" htmlFor="t-desc">
          <Textarea id="t-desc" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field label="Privacy" htmlFor="t-vis">
          <Select id="t-vis" value={f.visibility} onChange={(e) => setF({ ...f, visibility: e.target.value as 'private' | 'public' })}>
            <option value="private">Private: owners add people</option>
            <option value="public">Public: anyone in the organisation can join</option>
          </Select>
        </Field>
        <PeoplePicker label="Members" value={people} onChange={setPeople} />
        <Field label="Colour" htmlFor="t-color">
          <input id="t-color" type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} className="h-9 w-14 rounded" />
        </Field>
      </div>
    </Dialog>
  );
}

function JoinTeamDialog({ onClose, onJoined }: { onClose: () => void; onJoined: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const list = useQuery({ queryKey: ['team', 'discover', q], queryFn: () => api<{ items: { id: string; name: string; description: string; color: string; members: number }[] }>(`/api/v1/team/teams/discover?q=${encodeURIComponent(q)}`) });
  return (
    <Dialog open onClose={onClose} title="Join a public team" footer={<Button onClick={onClose}>Close</Button>}>
      <Input aria-label="Search teams" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className="mb-3" />
      {!list.data ? (
        <PageSpinner />
      ) : !list.data.items.length ? (
        <p className="text-sm text-zinc-500">No public teams to join. Private teams are joined by invitation from their owners.</p>
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {list.data.items.map((t) => (
            <li key={t.id} className="flex items-center gap-3 py-2">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md font-semibold text-white" style={{ background: t.color }}>
                {t.name.slice(0, 1)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{t.name}</span>
                <span className="block truncate text-xs text-zinc-500">{t.description || `${t.members} members`}</span>
              </span>
              <Button size="sm" onClick={() => api(`/api/v1/team/teams/${t.id}/join`, { body: {} }).then(onJoined, (e) => toast.error(errorMessage(e)))}>
                Join
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function NewChannelDialog({ team, meId, onClose, onCreated }: { team: TeamSummary; meId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: '', description: '', private: false });
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState<string | null>(null);
  const members = useQuery({ queryKey: ['team', 'team', team.id], queryFn: () => api<{ members: Person[] }>(`/api/v1/team/teams/${team.id}`), enabled: f.private });
  const create = useMutation({
    mutationFn: () => api<{ channel: { id: string } }>(`/api/v1/team/teams/${team.id}/channels`, { body: { ...f, name: f.name.trim(), memberIds: people.map((p) => p.id) } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['team', 'home'] });
      onCreated(r.channel.id);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Dialog open onClose={onClose} title={`Add a channel to ${team.name}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.name.trim()} loading={create.isPending} onClick={() => create.mutate()}>Add</Button></>}>
      {error && <Alert tone="danger" className="mb-3">{error}</Alert>}
      <div className="space-y-3">
        <Field label="Channel name" htmlFor="c-name">
          <Input id="c-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Launch planning" />
        </Field>
        <Field label="Description" htmlFor="c-desc">
          <Input id="c-desc" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Switch checked={f.private} onChange={(v) => setF({ ...f, private: v })} label="Private channel" description="Only the people you add can see it and its files." />
        {f.private && <PeoplePicker label="Members (from the team)" value={people} onChange={setPeople} exclude={[meId]} restrictTo={members.data?.members ?? []} />}
      </div>
    </Dialog>
  );
}

function ManageDialog({ channel, team, meId, onClose, onGone }: { channel: ChannelSummary; team: TeamSummary | null; meId: string; onClose: () => void; onGone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const detail = useQuery({ queryKey: ['team', 'channel', channel.id], queryFn: () => api<{ members: Person[]; canManage: boolean }>(`/api/v1/team/channels/${channel.id}`) });
  const teamInfo = useQuery({ queryKey: ['team', 'team', team?.id], queryFn: () => api<{ team: { name: string; description: string; visibility: 'public' | 'private' }; role: string; members: (Person & { role: 'owner' | 'member'; jobTitle: string | null })[] }>(`/api/v1/team/teams/${team!.id}`), enabled: !!team });
  const [adding, setAdding] = useState<Person[]>([]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['team'] });
  };
  const run = (p: Promise<unknown>, then?: () => void) => p.then(() => (refresh(), then?.()), (e) => toast.error(errorMessage(e)));
  const isOwner = teamInfo.data?.role === 'owner';
  const isChat = channel.kind === 'dm' || channel.kind === 'group';
  const listed = channel.kind === 'private' || channel.kind === 'group';

  return (
    <Dialog open onClose={onClose} size="lg" title={isChat ? 'Chat settings' : `${team?.name} › ${channel.name}`} footer={<Button onClick={onClose}>Close</Button>}>
      <div className="space-y-5">
        {listed && detail.data && (
          <section>
            <h3 className="mb-2 font-medium">People in this {isChat ? 'chat' : 'channel'}</h3>
            <ul className="mb-2 space-y-1 text-sm">
              {detail.data.members.map((m) => (
                <li key={m.id} className="flex items-center gap-2">
                  <Avatar name={m.name} size="sm" /> <span className="flex-1">{m.name}{m.id === meId ? ' (you)' : ''}</span>
                  {(detail.data!.canManage || isChat) && m.id !== meId && (
                    <button type="button" aria-label={`Remove ${m.name}`} onClick={() => void run(api(`/api/v1/team/channels/${channel.id}/members`, { body: { remove: [m.id] } }))} className="rounded p-1 text-zinc-400 hover:text-red-600">
                      <X className="size-4" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {(detail.data.canManage || isChat) && (
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <PeoplePicker label="Add people" value={adding} onChange={setAdding} exclude={detail.data.members.map((m) => m.id)} restrictTo={channel.kind === 'private' ? teamInfo.data?.members : undefined} />
                </div>
                <Button disabled={!adding.length} onClick={() => void run(api(`/api/v1/team/channels/${channel.id}/members`, { body: { add: adding.map((a) => a.id) } }), () => setAdding([]))}>
                  Add
                </Button>
              </div>
            )}
          </section>
        )}

        {team && teamInfo.data && (
          <section>
            <h3 className="mb-2 font-medium">Team members ({teamInfo.data.members.length})</h3>
            <ul className="mb-2 max-h-60 space-y-1 overflow-y-auto text-sm">
              {teamInfo.data.members.map((m) => (
                <li key={m.id} className="flex items-center gap-2">
                  <Avatar name={m.name} size="sm" />
                  <span className="min-w-0 flex-1 truncate">
                    {m.name}
                    {m.jobTitle && <span className="text-zinc-500"> · {m.jobTitle}</span>}
                  </span>
                  {isOwner && m.id !== meId ? (
                    <>
                      <Select aria-label={`Role of ${m.name}`} value={m.role} onChange={(e) => void run(api(`/api/v1/team/teams/${team.id}/members`, { body: { add: [{ userId: m.id, role: e.target.value }] } }))} className="h-8 w-28 py-0 text-sm">
                        <option value="member">Member</option>
                        <option value="owner">Owner</option>
                      </Select>
                      <button type="button" aria-label={`Remove ${m.name} from the team`} onClick={() => window.confirm(`Remove ${m.name} from ${team.name}?`) && void run(api(`/api/v1/team/teams/${team.id}/members`, { body: { remove: [m.id] } }))} className="rounded p-1 text-zinc-400 hover:text-red-600">
                        <X className="size-4" />
                      </button>
                    </>
                  ) : (
                    <Badge>{m.role === 'owner' ? 'Owner' : 'Member'}</Badge>
                  )}
                </li>
              ))}
            </ul>
            {isOwner && (
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <PeoplePicker label="Add to the team" value={adding} onChange={setAdding} exclude={teamInfo.data.members.map((m) => m.id)} />
                </div>
                <Button disabled={!adding.length} onClick={() => void run(api(`/api/v1/team/teams/${team.id}/members`, { body: { add: adding.map((a) => ({ userId: a.id, role: 'member' })) } }), () => setAdding([]))}>
                  Add
                </Button>
              </div>
            )}
          </section>
        )}

        <section className="flex flex-wrap gap-2 border-t border-zinc-100 pt-4 dark:border-zinc-800">
          {isChat && (
            <Button icon={<LogOut className="size-4" />} onClick={() => void run(channel.kind === 'group' ? api(`/api/v1/team/channels/${channel.id}/members`, { body: { remove: [meId] } }) : api(`/api/v1/team/channels/${channel.id}`, { method: 'DELETE' }), onGone)}>
              {channel.kind === 'group' ? 'Leave the chat' : 'Hide this chat'}
            </Button>
          )}
          {channel.kind === 'private' && (
            <Button icon={<LogOut className="size-4" />} onClick={() => void run(api(`/api/v1/team/channels/${channel.id}/members`, { body: { remove: [meId] } }), onGone)}>
              Leave the channel
            </Button>
          )}
          {!isChat && !channel.isGeneral && detail.data?.canManage && (
            <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={() => window.confirm(`Delete the ${channel.name} channel? Its files stay in the team’s library.`) && void run(api(`/api/v1/team/channels/${channel.id}`, { method: 'DELETE' }), onGone)}>
              Delete channel
            </Button>
          )}
          {team && (
            <Button icon={<LogOut className="size-4" />} onClick={() => window.confirm(`Leave ${team.name}?`) && void run(api(`/api/v1/team/teams/${team.id}/leave`, { body: {} }), onGone)}>
              Leave the team
            </Button>
          )}
          {team && isOwner && (
            <Button variant="danger" onClick={() => window.confirm(`Archive ${team.name}? Members can no longer see it; an administrator can restore it.`) && void run(api(`/api/v1/team/teams/${team.id}`, { method: 'DELETE' }), onGone)}>
              Archive the team
            </Button>
          )}
        </section>
      </div>
    </Dialog>
  );
}
