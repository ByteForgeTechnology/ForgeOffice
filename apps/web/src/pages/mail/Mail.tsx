import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArrowLeft,
  Ban,
  Download,
  File,
  FileText,
  Flag,
  Folder,
  FolderPlus,
  Forward,
  ImageOff,
  Inbox,
  Mail,
  MailOpen,
  Menu,
  Paperclip,
  PenSquare,
  Reply,
  ReplyAll,
  Search,
  Send,
  Settings,
  Share2,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { Avatar, Button, EmptyState, PageSpinner, Spinner, cn, formatBytes, useToast } from '@forge/ui';
import { Composer } from '../../components/mail/Composer';
import { ShareDialog, toGrants } from '../../components/ShareDialog';
import { api, errorMessage } from '../../lib/api';
import { getAccessToken } from '../../lib/auth';
import { useDebounced, useMe } from '../../lib/hooks';
import { formatAddr, listDate, mailboxHeader, type Addr, type ComposeState, type FullMessage, type MailAccount, type MailboxInfo, type ThreadSummary } from '../../lib/mail-types';
import { useSocketEvent } from '../../lib/realtime';

const FOLDER_ICONS: Record<string, typeof Inbox> = {
  '\\Inbox': Inbox,
  '\\Drafts': FileText,
  '\\Sent': Send,
  '\\Archive': Archive,
  '\\Junk': ShieldAlert,
  '\\Trash': Trash2,
};

interface MailSettings {
  identities: string[];
  onBehalfOf: string[];
  undoSendSeconds: number;
}

const emptyCompose = (): ComposeState => ({ to: [], cc: [], bcc: [], subject: '', html: '', attachments: [] });

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export function MailPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: me } = useMe();
  const [params, setParams] = useSearchParams();
  const [compose, setCompose] = useState<ComposeState | null>(null);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebounced(search.trim(), 300);

  const accounts = useQuery({ queryKey: ['mail', 'accounts'], queryFn: () => api<{ items: MailAccount[] }>('/api/v1/mail/accounts') });
  const account = accounts.data?.items.find((a) => a.id === params.get('account')) ?? accounts.data?.items[0];
  const headers = mailboxHeader(account);
  const [sharing, setSharing] = useState<MailboxInfo | null>(null);
  // Whole-mailbox rights let you manage folders and share them.
  const canManageMailbox = account?.access === 'owner' || account?.access === 'full';
  const accountKey = account?.id ?? 'me';
  const mailboxes = useQuery({
    queryKey: ['mail', accountKey, 'mailboxes'],
    queryFn: () => api<{ items: MailboxInfo[] }>('/api/v1/mail/mailboxes', { headers }),
    enabled: !!account,
  });
  const settings = useQuery({ queryKey: ['mail', 'settings'], queryFn: () => api<MailSettings>('/api/v1/mail/settings') });
  const inbox = mailboxes.data?.items.find((b) => b.specialUse === '\\Inbox');
  const folderId = params.get('folder') ?? inbox?.id;
  const folder = mailboxes.data?.items.find((b) => b.id === folderId);
  // Access is per folder: read = view only; write = flag and file; full/owner = also delete.
  const readOnly = folder?.access === 'read';
  const threadId = params.get('thread');

  const setParam = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) (v === null ? next.delete(k) : next.set(k, v));
    setParams(next, { replace: false });
  };

  // Compose from links such as /mail?compose=1&to=someone@example.com
  useEffect(() => {
    const to = params.get('to');
    if (params.get('compose') || to) {
      setCompose({ ...emptyCompose(), to: to ? [{ name: params.get('name') ?? '', address: to }] : [] });
      setParam({ compose: null, to: null, name: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live updates from delivery, IMAP clients and other tabs.
  const pending = useRef<NodeJS.Timeout | null>(null);
  useSocketEvent('mail:changed', () => {
    if (pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      void qc.invalidateQueries({ queryKey: ['mail'] });
    }, 300);
  });

  const threads = useInfiniteQuery({
    queryKey: ['mail', accountKey, 'threads', q ? `search:${q}` : folderId],
    enabled: !!account && (!!folderId || !!q),
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      api<{ items: ThreadSummary[]; nextCursor: string | null }>(
        `/api/v1/mail/threads?${q ? `q=${encodeURIComponent(q)}` : `mailboxId=${folderId}`}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ''}`,
        { headers },
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = useMemo(() => threads.data?.pages.flatMap((p) => p.items) ?? [], [threads.data]);

  const act = useMutation({
    mutationFn: (v: { ids: string[]; action: string; mailboxId?: string }) => api('/api/v1/mail/messages/actions', { body: v, headers }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['mail'] }),
    onError: (e) => toast.error(errorMessage(e)),
  });

  const selectedIds = items.filter((t) => selected.has(t.threadId)).flatMap((t) => t.messageIds);
  const bulk = (action: string, mailboxId?: string) => {
    if (!selectedIds.length) return;
    act.mutate({ ids: selectedIds, action, mailboxId });
    if (['archive', 'delete', 'junk', 'notJunk', 'move'].includes(action) && threadId && selected.has(threadId)) setParam({ thread: null });
    setSelected(new Set());
  };

  const openThread = async (t: ThreadSummary) => {
    if (folder?.specialUse === '\\Drafts' && t.latest.draft) {
      try {
        const { draft } = await api<{ draft: { id: string; to: Addr[]; cc: Addr[]; bcc: Addr[]; subject: string; html: string; attachments: ComposeState['attachments'] } }>(`/api/v1/mail/drafts/${t.latest.id}`, { headers });
        setCompose({ ...draft, draftId: draft.id });
      } catch (err) {
        toast.error(errorMessage(err));
      }
      return;
    }
    setParam({ thread: t.threadId });
    if (t.unread && !readOnly) act.mutate({ ids: t.messageIds, action: 'read' });
  };

  const createFolder = async () => {
    const name = window.prompt('Folder name');
    if (!name) return;
    try {
      await api('/api/v1/mail/mailboxes', { body: { path: name }, headers });
      void qc.invalidateQueries({ queryKey: ['mail', accountKey, 'mailboxes'] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  if (accounts.isLoading || mailboxes.isLoading) return <PageSpinner />;

  // New messages from a shared mailbox default to its address when the user may send from it.
  const defaultFrom = account?.shared && (account.sendAs || account.sendOnBehalf) ? account.address : undefined;
  const newMessage = (): ComposeState => ({ ...emptyCompose(), from: defaultFrom });

  const folderNav = (
    <nav aria-label="Mail folders" className="flex h-full flex-col gap-1 p-3">
      {(accounts.data?.items.length ?? 0) > 1 && (
        <label className="mb-2 block">
          <span className="sr-only">Mailbox</span>
          <select
            value={account?.id}
            onChange={(e) => {
              setSearch('');
              setSelected(new Set());
              setFoldersOpen(false);
              setParams(new URLSearchParams(e.target.value === accounts.data?.items[0]?.id ? {} : { account: e.target.value }));
            }}
            className="w-full rounded-lg border-zinc-200 bg-zinc-50 py-2 text-sm font-medium dark:border-zinc-700 dark:bg-zinc-800"
          >
            {accounts.data?.items.map((a) => (
              <option key={a.id} value={a.id}>
                {!a.shared ? `${a.name} — my mailbox` : a.access === 'folders' ? `${a.name} (shared folders)` : `${a.name} (shared${a.access === 'read' ? ', read-only' : ''})`}
              </option>
            ))}
          </select>
        </label>
      )}
      <Button variant="primary" className="mb-3 w-full" icon={<PenSquare className="size-4" />} onClick={() => setCompose(newMessage())}>
        New message
      </Button>
      <ul className="space-y-0.5">
        {mailboxes.data?.items.map((b) => {
          const Icon = (b.specialUse && FOLDER_ICONS[b.specialUse]) || Folder;
          const active = !q && b.id === folderId;
          return (
            <li key={b.id} className="group relative">
              {canManageMailbox && (
                <button
                  type="button"
                  aria-label={`Share ${b.name}`}
                  title="Share this folder"
                  onClick={() => setSharing(b)}
                  className="absolute top-1/2 right-1 z-10 hidden -translate-y-1/2 rounded p-1 text-zinc-400 group-hover:block hover:bg-zinc-200 hover:text-zinc-700 focus:block dark:hover:bg-zinc-700"
                >
                  <Share2 className="size-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setSearch('');
                  setSelected(new Set());
                  setFoldersOpen(false);
                  setParam({ folder: b.id, thread: null });
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const ids = e.dataTransfer.getData('application/x-forge-messages');
                  if (ids) act.mutate({ ids: ids.split(','), action: 'move', mailboxId: b.id });
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm',
                  active ? 'bg-brand/10 font-semibold text-brand' : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800',
                )}
                style={{ paddingLeft: `${0.75 + (b.path.split('/').length - 1) * 0.75}rem` }}
              >
                <Icon className="size-4 shrink-0" />
                <span className="flex-1 truncate">{b.name}</span>
                {b.unread > 0 && b.specialUse !== '\\Sent' && b.specialUse !== '\\Trash' && <span className="text-xs font-semibold">{b.unread}</span>}
                {b.specialUse === '\\Drafts' && b.total > 0 && <span className="text-xs text-zinc-500">{b.total}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      <button type="button" onClick={() => void createFolder()} className="mt-2 flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
        <FolderPlus className="size-4" /> New folder
      </button>
      <span className="flex-1" />
      <Link to="/mail/settings" className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
        <Settings className="size-4" /> Mail settings
      </Link>
    </nav>
  );

  return (
    <div className="flex h-full">
      {/* Folders */}
      <aside className="hidden w-60 shrink-0 border-r border-zinc-200 bg-white lg:block dark:border-zinc-800 dark:bg-zinc-900">{folderNav}</aside>
      {foldersOpen && (
        <div className="fixed inset-0 z-30 lg:hidden" onClick={() => setFoldersOpen(false)}>
          <div className="absolute inset-0 bg-zinc-950/40" />
          <aside className="absolute inset-y-0 left-0 w-72 bg-white dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
            {folderNav}
          </aside>
        </div>
      )}

      {/* Conversation list */}
      <section className={cn('flex min-w-0 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900', threadId ? 'hidden md:flex md:w-96 xl:w-[28rem]' : 'flex-1 md:w-96 md:flex-none xl:w-[28rem]')}>
        <div className="flex items-center gap-2 border-b border-zinc-200 p-2 dark:border-zinc-800">
          <button type="button" className="rounded-lg p-2 hover:bg-zinc-100 lg:hidden dark:hover:bg-zinc-800" aria-label="Folders" onClick={() => setFoldersOpen(true)}>
            <Menu className="size-5" />
          </button>
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-zinc-400" />
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setParam({ thread: null });
              }}
              placeholder="Search mail"
              aria-label="Search mail"
              className="h-9 w-full rounded-lg border-0 bg-zinc-100 pr-8 pl-8 text-sm focus:ring-2 focus:ring-brand dark:bg-zinc-800"
            />
            {search && (
              <button type="button" aria-label="Clear search" className="absolute top-1/2 right-2 -translate-y-1/2 text-zinc-400" onClick={() => setSearch('')}>
                <X className="size-4" />
              </button>
            )}
          </div>
        </div>
        <div className="flex h-11 items-center gap-1 border-b border-zinc-200 px-2 text-sm dark:border-zinc-800">
          <input
            type="checkbox"
            aria-label="Select all"
            className="mx-2 accent-[var(--brand)]"
            checked={items.length > 0 && selected.size === items.length}
            onChange={(e) => setSelected(e.target.checked ? new Set(items.map((t) => t.threadId)) : new Set())}
          />
          {selected.size > 0 && !readOnly ? (
            <>
              <IconButton label="Archive" icon={Archive} onClick={() => bulk('archive')} />
              <IconButton label="Delete" icon={Trash2} onClick={() => bulk('delete')} />
              <IconButton label="Mark read" icon={MailOpen} onClick={() => bulk('read')} />
              <IconButton label="Mark unread" icon={Mail} onClick={() => bulk('unread')} />
              <IconButton label="Flag" icon={Flag} onClick={() => bulk('flag')} />
              <IconButton label={folder?.specialUse === '\\Junk' ? 'Not junk' : 'Junk'} icon={ShieldAlert} onClick={() => bulk(folder?.specialUse === '\\Junk' ? 'notJunk' : 'junk')} />
              <span className="ml-auto pr-2 text-xs text-zinc-500">{selected.size} selected</span>
            </>
          ) : (
            <span className="font-semibold">{q ? `Results for “${q}”` : (folder?.name ?? '')}</span>
          )}
          {!selected.size && folder?.specialUse && ['\\Trash', '\\Junk'].includes(folder.specialUse) && folder.total > 0 && !q && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={async () => {
                if (!window.confirm(`Permanently delete everything in ${folder.name}?`)) return;
                await api(`/api/v1/mail/mailboxes/${folder.id}/empty`, { body: {}, headers });
                void qc.invalidateQueries({ queryKey: ['mail'] });
              }}
            >
              Empty
            </Button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {threads.isLoading ? (
            <PageSpinner />
          ) : items.length === 0 ? (
            <EmptyState icon={q ? <Search /> : <Inbox />} title={q ? 'No messages match' : 'Nothing here'} description={q ? 'Try different words or a sender’s address.' : undefined} />
          ) : (
            <ul>
              {items.map((t) => (
                <ThreadRow
                  key={t.threadId}
                  thread={t}
                  me={me?.user.email ?? ''}
                  inSent={folder?.specialUse === '\\Sent'}
                  active={t.threadId === threadId}
                  checked={selected.has(t.threadId)}
                  onCheck={(on) => setSelected((s) => {
                    const n = new Set(s);
                    if (on) n.add(t.threadId);
                    else n.delete(t.threadId);
                    return n;
                  })}
                  onOpen={() => void openThread(t)}
                />
              ))}
            </ul>
          )}
          {threads.hasNextPage && (
            <div className="p-3 text-center">
              <Button size="sm" loading={threads.isFetchingNextPage} onClick={() => void threads.fetchNextPage()}>
                Load more
              </Button>
            </div>
          )}
        </div>
      </section>

      {/* Reading pane */}
      <section className={cn('min-w-0 flex-1 bg-zinc-50 dark:bg-zinc-950', threadId ? 'flex' : 'hidden md:flex')}>
        {threadId ? (
          <ThreadView
            key={threadId}
            threadId={threadId}
            headers={headers}
            readOnly={readOnly}
            defaultFrom={defaultFrom}
            accountKey={accountKey}
            mailboxes={mailboxes.data?.items ?? []}
            myEmail={me?.user.email ?? ''}
            onBack={() => setParam({ thread: null })}
            onCompose={setCompose}
            onAction={(ids, action, mailboxId) => {
              act.mutate({ ids, action, mailboxId });
              if (action !== 'unread' && action !== 'flag' && action !== 'unflag' && action !== 'read') setParam({ thread: null });
              if (action === 'unread') setParam({ thread: null });
            }}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState icon={<Mail />} title="Select a conversation" description="Choose a message to read it here." />
          </div>
        )}
      </section>

      {sharing && (
        <ShareDialog
          title={`Share “${sharing.name}”`}
          description={`Only this folder is shared${account?.shared ? ` (from ${account.address})` : ''}. People see it in their mailbox switcher and in mail apps under Shared/.`}
          levels={[
            { value: 'read', label: 'Read', description: 'See messages in this folder.' },
            { value: 'write', label: 'Write', description: 'Also flag, mark read and file messages in or out.' },
            { value: 'full', label: 'Full', description: 'Also delete messages.' },
          ]}
          load={async () => toGrants((await api<{ items: Parameters<typeof toGrants>[0] }>(`/api/v1/mail/mailboxes/${sharing.id}/shares`, { headers })).items)}
          save={(grants) =>
            api(`/api/v1/mail/mailboxes/${sharing.id}/shares`, {
              method: 'PUT',
              headers,
              body: { grants: grants.map(({ principalType, principalId, access }) => ({ principalType, principalId, access })) },
            })
          }
          onClose={() => setSharing(null)}
        />
      )}

      {compose && settings.data && (
        <Composer
          key={compose.draftId ?? compose.replyToMessageId ?? compose.forwardMessageId ?? 'new'}
          initial={compose}
          identities={settings.data.identities}
          onBehalfOf={settings.data.onBehalfOf}
          headers={headers}
          undoSeconds={settings.data.undoSendSeconds}
          onClose={() => setCompose(null)}
        />
      )}
    </div>
  );
}

function IconButton({ label, icon: Icon, onClick }: { label: string; icon: typeof Inbox; onClick: () => void }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} className="rounded-lg p-2 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800">
      <Icon className="size-4" />
    </button>
  );
}

function ThreadRow({ thread: t, me, inSent, active, checked, onCheck, onOpen }: { thread: ThreadSummary; me: string; inSent: boolean; active: boolean; checked: boolean; onCheck: (on: boolean) => void; onOpen: () => void }) {
  const unread = t.unread > 0;
  const who = inSent
    ? `To: ${t.latest.to.map((a) => formatAddr(a)).join(', ') || '(no recipients)'}`
    : t.participants.map((p) => (p === me ? 'me' : p.split(' ')[0])).join(', ') || formatAddr(t.latest.from);
  return (
    <li
      draggable
      onDragStart={(e) => e.dataTransfer.setData('application/x-forge-messages', t.messageIds.join(','))}
      className={cn('flex cursor-pointer gap-2 border-b border-zinc-100 px-2 py-2.5 dark:border-zinc-800', active ? 'bg-brand/10' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50')}
      onClick={onOpen}
    >
      <input type="checkbox" aria-label="Select conversation" className="mx-2 mt-1 accent-[var(--brand)]" checked={checked} onClick={(e) => e.stopPropagation()} onChange={(e) => onCheck(e.target.checked)} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          {unread && <span className="size-2 shrink-0 rounded-full bg-brand" aria-label="Unread" />}
          <span className={cn('flex-1 truncate text-sm', unread ? 'font-semibold' : 'text-zinc-700 dark:text-zinc-300')}>
            {who}
            {t.count > 1 && <span className="ml-1 text-xs font-normal text-zinc-500">{t.count}</span>}
          </span>
          <span className={cn('shrink-0 text-xs', unread ? 'font-semibold text-brand' : 'text-zinc-500')}>{listDate(t.lastDate)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={cn('flex-1 truncate text-sm', unread ? 'font-medium' : 'text-zinc-700 dark:text-zinc-300')}>{t.latest.draft ? <span className="text-red-600">[Draft] </span> : null}{t.latest.subject || '(no subject)'}</span>
          {t.hasAttachments && <Paperclip className="size-3.5 shrink-0 text-zinc-400" aria-label="Has attachments" />}
          {t.flagged && <Flag className="size-3.5 shrink-0 fill-red-500 text-red-500" aria-label="Flagged" />}
        </div>
        <p className="truncate text-xs text-zinc-500">{t.latest.snippet}</p>
      </div>
    </li>
  );
}

function MessageFrame({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const doc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
    html,body{margin:0;padding:0;background:#fff;color:#18181b;font:14px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;word-break:break-word;overflow-wrap:anywhere}
    img{max-width:100%;height:auto} table{max-width:100%} pre{white-space:pre-wrap}
    blockquote{margin:.5em 0 .5em .25em;padding-left:.75em;border-left:3px solid #d4d4d8;color:#52525b}
    a{color:#2563eb} img[data-blocked-src]{display:inline-block;min-width:16px;min-height:16px;background:#f4f4f5}
  </style></head><body>${html}</body></html>`;
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    const measure = () => {
      const body = frame.contentDocument?.body;
      if (body) setHeight(Math.min(Math.max(body.scrollHeight + 8, 60), 20000));
    };
    frame.addEventListener('load', measure);
    const t = setInterval(measure, 500);
    setTimeout(() => clearInterval(t), 5000);
    return () => {
      frame.removeEventListener('load', measure);
      clearInterval(t);
    };
  }, [html]);
  // Scripts never run: the sandbox omits allow-scripts. Same-origin is kept only so we can size the frame.
  return <iframe ref={ref} title="Message" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} className="w-full rounded-lg border-0 bg-white" style={{ height }} />;
}

function ThreadView({
  threadId,
  headers,
  readOnly,
  defaultFrom,
  accountKey,
  mailboxes,
  myEmail,
  onBack,
  onCompose,
  onAction,
}: {
  threadId: string;
  headers: Record<string, string> | undefined;
  readOnly: boolean;
  defaultFrom: string | undefined;
  accountKey: string;
  mailboxes: MailboxInfo[];
  myEmail: string;
  onBack: () => void;
  onCompose: (s: ComposeState) => void;
  onAction: (ids: string[], action: string, mailboxId?: string) => void;
}) {
  const [remoteImages, setRemoteImages] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toast = useToast();
  const qc = useQueryClient();
  const thread = useQuery({
    queryKey: ['mail', accountKey, 'thread', threadId, remoteImages],
    queryFn: () => api<{ subject: string; messages: FullMessage[] }>(`/api/v1/mail/threads/${threadId}${remoteImages ? '?remoteImages=true' : ''}`, { headers }),
  });
  if (thread.isLoading) return <PageSpinner />;
  if (!thread.data) return <EmptyState title="Conversation not found" />;
  const msgs = thread.data.messages.filter((m) => !m.draft);
  const visible = msgs.length ? msgs : thread.data.messages;
  const latest = visible.at(-1)!;
  const ids = thread.data.messages.map((m) => m.id);
  const blocked = visible.some((m) => m.body.blockedImages > 0);
  const trash = mailboxes.find((b) => b.specialUse === '\\Trash');
  const junk = mailboxes.find((b) => b.specialUse === '\\Junk');
  const inJunk = visible.every((m) => m.mailboxId === junk?.id);
  const inTrash = visible.every((m) => m.mailboxId === trash?.id);
  const sender = latest.from?.address && latest.from.address !== myEmail ? latest.from.address : null;
  // Block → Junk now and in future; allow → back to the Inbox and never Junk again.
  const listSender = async (list: 'block' | 'allow') => {
    if (!sender) return;
    try {
      await api('/api/v1/mail/sender-lists', { headers, body: { list, entries: [sender] } });
      onAction(ids, list === 'block' ? 'junk' : 'notJunk');
      void qc.invalidateQueries({ queryKey: ['sender-lists'] });
      toast.success(list === 'block' ? `Blocked ${sender}. Their mail will go to Junk.` : `${sender} will no longer be sent to Junk.`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const quote = (m: FullMessage) => `<p></p><p></p><blockquote><p>On ${new Date(m.date).toLocaleString()}, ${escapeHtml(formatAddr(m.from))} wrote:</p>${m.body.html}</blockquote>`;
  const reSubject = (s: string) => (/^re:/i.test(s) ? s : `Re: ${s}`);
  const reply = (m: FullMessage, all: boolean) => {
    const target = m.from?.address === myEmail ? m.to : m.replyTo.length ? m.replyTo : m.from ? [m.from] : [];
    const others = all ? [...m.to, ...m.cc].filter((a) => a.address !== myEmail && !target.some((t) => t.address === a.address)) : [];
    onCompose({ to: target, cc: others, bcc: [], subject: reSubject(m.subject), html: quote(m), attachments: [], replyToMessageId: m.id, from: defaultFrom });
  };
  const forward = (m: FullMessage) =>
    onCompose({
      to: [],
      cc: [],
      bcc: [],
      subject: /^fwd?:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`,
      html: `<p></p><p>---------- Forwarded message ----------<br>From: ${escapeHtml(formatAddr(m.from))} &lt;${escapeHtml(m.from?.address ?? '')}&gt;<br>Date: ${new Date(m.date).toLocaleString()}<br>Subject: ${escapeHtml(m.subject)}<br>To: ${escapeHtml(m.to.map((a) => a.address).join(', '))}</p>${m.body.html}`,
      attachments: [],
      forwardMessageId: m.id,
      from: defaultFrom,
    });

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-zinc-200 bg-white px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-900">
        <button type="button" onClick={onBack} aria-label="Back" className="rounded-lg p-2 hover:bg-zinc-100 md:hidden dark:hover:bg-zinc-800">
          <ArrowLeft className="size-4" />
        </button>
        {readOnly ? (
          <span className="px-2 text-sm text-zinc-500">Read-only access</span>
        ) : (
          <>
        <IconButton label="Archive" icon={Archive} onClick={() => onAction(ids, 'archive')} />
        <IconButton label={inTrash ? 'Delete forever' : 'Delete'} icon={Trash2} onClick={() => onAction(ids, 'delete')} />
        <IconButton label={inJunk ? 'Not junk' : 'Report junk'} icon={ShieldAlert} onClick={() => onAction(ids, inJunk ? 'notJunk' : 'junk')} />
        {sender && (inJunk ? <IconButton label={`Always allow ${sender}`} icon={ShieldCheck} onClick={() => void listSender('allow')} /> : <IconButton label={`Block ${sender}`} icon={Ban} onClick={() => void listSender('block')} />)}
        <IconButton label="Mark unread" icon={Mail} onClick={() => onAction(ids, 'unread')} />
        <IconButton label={latest.flagged ? 'Unflag' : 'Flag'} icon={Flag} onClick={() => onAction(ids, latest.flagged ? 'unflag' : 'flag')} />
        <select
          aria-label="Move to folder"
          className="ml-1 h-8 rounded-lg border-zinc-200 bg-transparent py-0 text-sm dark:border-zinc-700"
          value=""
          onChange={(e) => e.target.value && onAction(ids, 'move', e.target.value)}
        >
          <option value="">Move to…</option>
          {mailboxes.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
          </>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-6">
        <h1 className="mb-4 text-xl font-semibold">{thread.data.subject || '(no subject)'}</h1>
        {blocked && !remoteImages && (
          <div className="mb-4 flex items-center gap-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <ImageOff className="size-4" /> Remote images are hidden to protect your privacy.
            <button type="button" className="font-medium underline" onClick={() => setRemoteImages(true)}>
              Show images
            </button>
          </div>
        )}
        <div className="space-y-3">
          {visible.map((m) => {
            const open = m.id === latest.id || expanded.has(m.id) || !m.seen;
            return (
              <article key={m.id} className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
                <header className="flex cursor-pointer items-start gap-3 p-4" onClick={() => setExpanded((s) => new Set(s).add(m.id))}>
                  <Avatar name={formatAddr(m.from)} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">
                      <span className="font-semibold">{formatAddr(m.from)}</span> <span className="text-zinc-500">&lt;{m.from?.address}&gt;</span>
                    </p>
                    {open ? (
                      <p className="truncate text-xs text-zinc-500">
                        to {m.to.map((a) => (a.address === myEmail ? 'me' : formatAddr(a))).join(', ')}
                        {m.cc.length > 0 && `, cc ${m.cc.map(formatAddr).join(', ')}`}
                        {m.bcc.length > 0 && `, bcc ${m.bcc.map(formatAddr).join(', ')}`}
                      </p>
                    ) : (
                      <p className="truncate text-sm text-zinc-500">{m.snippet}</p>
                    )}
                  </div>
                  <span className="shrink-0 text-xs text-zinc-500">{new Date(m.date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                </header>
                {open && (
                  <>
                    {m.spamScore !== null && m.spamScore >= 5 && (
                      <p className="mx-4 mb-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-950 dark:text-red-200">This message looks like junk (score {m.spamScore.toFixed(1)}). Be careful with links and attachments.</p>
                    )}
                    <div className="px-4 pb-2">
                      <MessageFrame html={m.body.html} />
                    </div>
                    {m.attachments.length > 0 && (
                      <ul className="flex flex-wrap gap-2 px-4 pb-3">
                        {m.attachments.map((a) => (
                          <li key={a.partPath}>
                            <button
                              type="button"
                              onClick={() => void downloadAttachment(m.id, a.partPath, a.filename, headers)}
                              className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                            >
                              <File className="size-4 text-zinc-400" />
                              <span className="max-w-48 truncate">{a.filename}</span>
                              <span className="text-xs text-zinc-500">{formatBytes(a.size)}</span>
                              <Download className="size-3.5 text-zinc-400" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <footer className="flex flex-wrap gap-2 border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">
                      <Button size="sm" icon={<Reply className="size-4" />} onClick={() => reply(m, false)}>
                        Reply
                      </Button>
                      <Button size="sm" icon={<ReplyAll className="size-4" />} onClick={() => reply(m, true)}>
                        Reply all
                      </Button>
                      <Button size="sm" icon={<Forward className="size-4" />} onClick={() => forward(m)}>
                        Forward
                      </Button>
                      <span className="flex-1" />
                      <Button size="sm" variant="ghost" onClick={() => void downloadAttachment(m.id, null, `message.eml`, headers)}>
                        <Download className="size-4" /> .eml
                      </Button>
                    </footer>
                  </>
                )}
              </article>
            );
          })}
        </div>
        {thread.isFetching && <Spinner className="mt-4" />}
      </div>
    </div>
  );
}

async function downloadAttachment(messageId: string, part: string | null, filename: string, extra?: Record<string, string>) {
  const token = await getAccessToken();
  const url = part ? `/api/v1/mail/messages/${messageId}/attachments/${part}` : `/api/v1/mail/messages/${messageId}/raw`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, ...extra } });
  if (!res.ok) return;
  const href = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
