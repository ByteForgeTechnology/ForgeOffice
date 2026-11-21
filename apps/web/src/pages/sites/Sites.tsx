import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EditorContent, Node, NodeViewWrapper, ReactNodeViewRenderer, mergeAttributes, useEditor, type Editor, type NodeViewProps } from '@tiptap/react';
import { Bold, FileText, Folder, Globe, ListChecks, Heading2, Image as ImageIcon, Italic, Link2, List, ListOrdered, Lock, Newspaper, Plus, Quote, Settings2, Trash2, X } from 'lucide-react';
import { Alert, Badge, Button, Card, CardBody, Dialog, EmptyState, Field, Input, PageHeader, PageSpinner, Select, Textarea, cn, formatDateTime, formatRelative, useToast } from '@forge/ui';
import { ShareDialog } from '../../components/ShareDialog';
import { api, errorMessage } from '../../lib/api';
import { richTextExtensions } from '../../lib/editor';
import { Activity } from '../drive/Drive';
import { ROLE_LEVELS, contentUrl, uploadFile, type DriveItem } from '../drive/drive-api';
import { CreateListDialog, ListView, ListWidget } from './Lists';

interface SiteInfo {
  id: string;
  slug: string;
  name: string;
  description: string;
  color: string;
  visibility: 'organisation' | 'members';
  libraryId: string;
  groupId: string | null;
  role: 'owner' | 'editor' | 'commenter' | 'viewer';
  canEdit: boolean;
}
interface NewsItem {
  id: string;
  siteId: string;
  slug: string;
  title: string;
  excerpt: string;
  publishedAt: string;
  author: string | null;
  site: { name: string; slug: string; color: string } | null;
}
interface Page {
  id: string;
  slug: string;
  title: string;
  content: Record<string, unknown>;
  isNews: boolean;
  isHome: boolean;
  publishedAt: string | null;
  author: string | null;
  editor: string | null;
  updatedAt: string;
}

interface SiteListRef {
  id: string;
  name: string;
}

const SiteContext = createContext<SiteInfo | null>(null);

// ---------------------------------------------------------------------------
// Sites home: your sites and the organisation's news
// ---------------------------------------------------------------------------

export function SitesPage() {
  const [creating, setCreating] = useState(false);
  const sites = useQuery({ queryKey: ['sites'], queryFn: () => api<{ items: SiteInfo[] }>('/api/v1/sites') });
  const news = useQuery({ queryKey: ['sites', 'news'], queryFn: () => api<{ items: NewsItem[] }>('/api/v1/sites/news') });
  return (
    <div className="space-y-6">
      <PageHeader
        title="Sites"
        description="Intranet sites, department pages, wikis and news."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
            Create site
          </Button>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section>
          <h2 className="mb-3 font-semibold">News</h2>
          <NewsList items={news.data?.items} />
        </section>
        <section>
          <h2 className="mb-3 font-semibold">Your sites</h2>
          {!sites.data ? (
            <PageSpinner />
          ) : !sites.data.items.length ? (
            <p className="text-sm text-zinc-500">No sites yet.</p>
          ) : (
            <ul className="space-y-2">
              {sites.data.items.map((s) => (
                <li key={s.id}>
                  <Link to={`/sites/${s.slug}`} className="flex items-center gap-3 rounded-lg bg-white p-3 shadow-sm ring-1 ring-zinc-200 hover:ring-brand dark:bg-zinc-900 dark:ring-zinc-800">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg font-semibold text-white" style={{ background: s.color }}>
                      {s.name.slice(0, 1)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{s.name}</span>
                      <span className="block truncate text-xs text-zinc-500">{s.description || (s.visibility === 'organisation' ? 'Everyone in the organisation' : 'Members only')}</span>
                    </span>
                    {s.visibility === 'organisation' ? <Globe className="size-4 text-zinc-400" /> : <Lock className="size-4 text-zinc-400" />}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      {creating && <CreateSiteDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewsList({ items, compact }: { items?: NewsItem[]; compact?: boolean }) {
  if (!items) return <PageSpinner />;
  if (!items.length) return <p className="text-sm text-zinc-500">No news yet.</p>;
  return (
    <ul className={cn('grid gap-3', !compact && 'sm:grid-cols-2')}>
      {items.map((n) => (
        <li key={n.id}>
          <Link to={`/sites/${n.site?.slug}/${n.slug}`} className="block h-full rounded-xl bg-white p-4 shadow-sm ring-1 ring-zinc-200 hover:ring-brand dark:bg-zinc-900 dark:ring-zinc-800">
            {n.site && !compact && (
              <span className="mb-1 inline-flex items-center gap-1.5 text-xs font-medium" style={{ color: n.site.color }}>
                <span className="size-2 rounded-full" style={{ background: n.site.color }} /> {n.site.name}
              </span>
            )}
            <span className="block font-semibold">{n.title}</span>
            {n.excerpt && <span className="mt-1 line-clamp-2 block text-sm text-zinc-600 dark:text-zinc-400">{n.excerpt}</span>}
            <span className="mt-2 block text-xs text-zinc-500">
              {n.author ? `${n.author} · ` : ''}
              {formatRelative(n.publishedAt)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function CreateSiteDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [f, setF] = useState({ name: '', description: '', visibility: 'members' as SiteInfo['visibility'], groupId: '', color: '#4f46e5' });
  const [error, setError] = useState<string | null>(null);
  const teams = useQuery({ queryKey: ['sites', 'teams'], queryFn: () => api<{ items: { id: string; name: string }[] }>('/api/v1/sites/teams') });
  const create = useMutation({
    mutationFn: () => api<{ site: SiteInfo }>('/api/v1/sites', { body: { name: f.name, description: f.description, visibility: f.visibility, color: f.color, ...(f.groupId ? { groupId: f.groupId } : {}) } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['sites'] });
      navigate(`/sites/${r.site.slug}`);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Create a site"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} disabled={!f.name.trim()} onClick={() => create.mutate()}>
            Create
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <div className="space-y-3">
        <Field label="Name" htmlFor="s-name">
          <Input id="s-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Human Resources" />
        </Field>
        <Field label="Description" htmlFor="s-desc">
          <Input id="s-desc" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field label="Who can see it" htmlFor="s-vis">
          <Select id="s-vis" value={f.visibility} onChange={(e) => setF({ ...f, visibility: e.target.value as SiteInfo['visibility'] })}>
            <option value="members">Only its members</option>
            <option value="organisation">Everyone in the organisation (a communication site)</option>
          </Select>
        </Field>
        <Field label="Team (optional)" htmlFor="s-group" hint="Members of this group can edit the site; its owners manage it.">
          <Select id="s-group" value={f.groupId} onChange={(e) => setF({ ...f, groupId: e.target.value })}>
            <option value="">No team</option>
            {(teams.data?.items ?? []).map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Colour" htmlFor="s-color">
          <input id="s-color" type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} className="h-9 w-14 rounded" />
        </Field>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// A site: navigation, pages (view and edit), widgets
// ---------------------------------------------------------------------------

/** Embeddable blocks: news, documents, activity, a team calendar, images from the site library. */
const ForgeWidget = Node.create({
  name: 'forgeWidget',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return { widget: { default: 'news' }, title: { default: '' }, itemId: { default: null }, calendarId: { default: null }, listId: { default: null }, width: { default: null } };
  },
  parseHTML() {
    return [{ tag: 'div[data-forge-widget]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-forge-widget': '' })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(WidgetView);
  },
});

function WidgetView({ node, editor, deleteNode }: NodeViewProps) {
  const site = useContext(SiteContext);
  const { widget, title, itemId, calendarId, listId } = node.attrs as { widget: string; title: string; itemId: string | null; calendarId: string | null; listId: string | null };
  return (
    <NodeViewWrapper className={cn('my-4', editor.isEditable && 'rounded-xl ring-2 ring-dashed ring-zinc-300 dark:ring-zinc-700')}>
      {editor.isEditable && (
        <div className="flex items-center gap-2 px-3 pt-2 text-xs text-zinc-500" contentEditable={false}>
          <span className="flex-1">{widget === 'image' ? 'Image' : `${title || widget} (widget)`}</span>
          <button type="button" aria-label="Remove widget" onClick={deleteNode} className="rounded p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <div contentEditable={false} className={cn(widget !== 'image' && 'p-1')}>
        {!site ? null : widget === 'image' ? (
          <SiteImage itemId={itemId} />
        ) : (
          <section className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
            {title && <h3 className="mb-3 font-semibold">{title}</h3>}
            {widget === 'news' && <SiteNews site={site} />}
            {widget === 'library' && <SiteLibrary site={site} />}
            {widget === 'activity' && <Activity path={`/api/v1/drive/libraries/${site.libraryId}/activity`} compact />}
            {widget === 'calendar' && <SiteCalendar calendarId={calendarId} />}
            {widget === 'list' && <ListWidget site={site} listId={listId} />}
          </section>
        )}
      </div>
    </NodeViewWrapper>
  );
}

function SiteNews({ site }: { site: SiteInfo }) {
  const news = useQuery({ queryKey: ['sites', 'news', site.id], queryFn: () => api<{ items: NewsItem[] }>(`/api/v1/sites/${site.id}/news`) });
  return <NewsList items={news.data?.items.slice(0, 6)} compact />;
}

function SiteLibrary({ site }: { site: SiteInfo }) {
  const items = useQuery({ queryKey: ['drive', 'items', site.libraryId, null], queryFn: () => api<{ items: DriveItem[] }>(`/api/v1/drive/libraries/${site.libraryId}/items`) });
  if (!items.data) return <PageSpinner />;
  return (
    <div>
      {!items.data.items.length ? (
        <p className="text-sm text-zinc-500">No documents yet.</p>
      ) : (
        <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
          {items.data.items.slice(0, 10).map((i) => (
            <li key={i.id} className="flex items-center gap-2 py-1.5">
              {i.kind === 'folder' ? <Folder className="size-4 text-amber-500" /> : <FileText className="size-4 text-zinc-400" />}
              <Link to={`/drive?library=${site.libraryId}${i.kind === 'folder' ? `&folder=${i.id}` : ''}`} className="min-w-0 flex-1 truncate hover:underline">
                {i.name}
              </Link>
              <span className="text-xs text-zinc-500">{formatRelative(i.updatedAt)}</span>
            </li>
          ))}
        </ul>
      )}
      <Link to={`/drive?library=${site.libraryId}`} className="mt-2 inline-block text-sm text-brand hover:underline">
        All documents
      </Link>
    </div>
  );
}

function SiteCalendar({ calendarId }: { calendarId: string | null }) {
  const from = new Date();
  const to = new Date(Date.now() + 30 * 86_400_000);
  const events = useQuery({
    queryKey: ['calendar', 'widget', calendarId],
    queryFn: () => api<{ items: { id: string; summary: string; start: string; allDay?: boolean; location?: string }[] }>(`/api/v1/calendar/events?from=${from.toISOString()}&to=${to.toISOString()}&calendarIds=${calendarId}`),
    enabled: !!calendarId,
    retry: false,
  });
  if (!calendarId) return <p className="text-sm text-zinc-500">Edit the page and choose a calendar.</p>;
  if (events.error) return <p className="text-sm text-zinc-500">You can’t see this calendar.</p>;
  if (!events.data) return <PageSpinner />;
  if (!events.data.items.length) return <p className="text-sm text-zinc-500">Nothing in the next 30 days.</p>;
  return (
    <ul className="space-y-2 text-sm">
      {events.data.items.slice(0, 8).map((e) => (
        <li key={`${e.id}${e.start}`} className="flex gap-3">
          <span className="w-24 shrink-0 text-zinc-500">{new Date(e.start).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
          <span className="min-w-0 flex-1 truncate">
            {e.summary}
            {!e.allDay && <span className="text-zinc-500"> · {new Date(e.start).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function SiteImage({ itemId }: { itemId: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (itemId) contentUrl(itemId).then(setUrl, () => setUrl(null));
  }, [itemId]);
  return url ? <img src={url} alt="" className="max-h-[480px] w-full rounded-xl object-cover" /> : <div className="h-40 rounded-xl bg-zinc-100 dark:bg-zinc-800" />;
}

export function SitePage() {
  const { slug = '', page: pageSlug = 'home', listId } = useParams();
  const navigate = useNavigate();
  const [settings, setSettings] = useState(false);
  const [newList, setNewList] = useState(false);
  const [editing, setEditing] = useState(false);
  const site = useQuery({ queryKey: ['sites', 'by-slug', slug], queryFn: () => api<{ site: SiteInfo; pages: { id: string; slug: string; title: string; isHome: boolean }[]; lists: SiteListRef[] }>(`/api/v1/sites/by-slug/${slug}`) });
  const s = site.data?.site;
  const page = useQuery({ queryKey: ['sites', 'page', s?.id, pageSlug], queryFn: () => api<{ page: Page }>(`/api/v1/sites/${s!.id}/pages/${pageSlug}`), enabled: !!s && !listId });
  useEffect(() => setEditing(false), [pageSlug, listId]);
  const addPage = async (isNews: boolean) => {
    const title = window.prompt(isNews ? 'Headline' : 'Page title');
    if (!title?.trim() || !s) return;
    const r = await api<{ page: Page }>(`/api/v1/sites/${s.id}/pages`, { body: { title: title.trim(), isNews, publish: false } });
    await site.refetch();
    navigate(`/sites/${slug}/${r.page.slug}`);
    setEditing(true);
  };

  if (site.error) return <EmptyState icon={<Globe />} title="Site not found" description="It doesn’t exist, or you don’t have access." />;
  if (!s) return <PageSpinner />;
  return (
    <SiteContext.Provider value={s}>
      <div className="-mx-4 -mt-6 mb-6 px-4 py-6 text-white sm:-mx-6 sm:px-6" style={{ background: s.color }}>
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <Link to={`/sites/${s.slug}`} className="text-2xl font-semibold hover:underline">
              {s.name}
            </Link>
            {s.description && <p className="text-sm opacity-90">{s.description}</p>}
          </div>
          <Link to={`/drive?library=${s.libraryId}`}>
            <Button size="sm" icon={<Folder className="size-4" />}>
              Documents
            </Button>
          </Link>
          {s.canEdit && (
            <>
              <Button size="sm" icon={<Plus className="size-4" />} onClick={() => void addPage(false)}>
                New page
              </Button>
              <Button size="sm" icon={<Newspaper className="size-4" />} onClick={() => void addPage(true)}>
                News post
              </Button>
              <Button size="sm" icon={<ListChecks className="size-4" />} onClick={() => setNewList(true)}>
                New list
              </Button>
            </>
          )}
          {s.role === 'owner' && (
            <Button size="sm" icon={<Settings2 className="size-4" />} onClick={() => setSettings(true)}>
              Settings
            </Button>
          )}
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <nav aria-label="Site pages" className="space-y-1">
          {site.data!.pages.map((p) => (
            <Link key={p.id} to={`/sites/${s.slug}${p.isHome ? '' : `/${p.slug}`}`} className={cn('block rounded-lg px-3 py-2 text-sm', !listId && p.slug === pageSlug ? 'bg-white font-medium shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800')}>
              {p.title}
            </Link>
          ))}
          {(site.data!.lists.length > 0 || s.canEdit) && (
            <>
              <p className="px-3 pt-4 pb-1 text-xs font-medium tracking-wide text-zinc-500 uppercase">Lists</p>
              {site.data!.lists.map((l) => (
                <Link key={l.id} to={`/sites/${s.slug}/lists/${l.id}`} className={cn('flex items-center gap-2 rounded-lg px-3 py-2 text-sm', l.id === listId ? 'bg-white font-medium shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800')}>
                  <ListChecks className="size-4 shrink-0 text-zinc-400" />
                  <span className="truncate">{l.name}</span>
                </Link>
              ))}
              {s.canEdit && (
                <button type="button" onClick={() => setNewList(true)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                  <Plus className="size-4" /> New list
                </button>
              )}
            </>
          )}
        </nav>
        <main className="min-w-0">
          {listId ? (
            <ListView site={s} listId={listId} />
          ) : page.error ? (
            <EmptyState icon={<FileText />} title="Page not found" />
          ) : !page.data ? (
            <PageSpinner />
          ) : editing ? (
            <PageEditor key={page.data.page.id} site={s} lists={site.data!.lists} page={page.data.page} onDone={() => setEditing(false)} />
          ) : (
            <PageView page={page.data.page} canEdit={s.canEdit} onEdit={() => setEditing(true)} />
          )}
        </main>
      </div>
      {settings && <SiteSettings site={s} onClose={() => setSettings(false)} />}
      {newList && <CreateListDialog site={s} onClose={() => setNewList(false)} />}
    </SiteContext.Provider>
  );
}

function PageView({ page, canEdit, onEdit }: { page: Page; canEdit: boolean; onEdit: () => void }) {
  const editor = useEditor({ extensions: [...richTextExtensions(''), ForgeWidget], content: page.content, editable: false, editorProps: { attributes: { class: 'forge-editor site-page text-base' } } }, [page.id, page.updatedAt]);
  return (
    <article>
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          {!page.isHome && <h1 className="text-2xl font-semibold">{page.title}</h1>}
          {(page.isNews || !page.isHome) && (
            <p className="text-sm text-zinc-500">
              {page.isNews && <Badge className="mr-2">News</Badge>}
              {!page.publishedAt && <Badge tone="warning" className="mr-2">Draft</Badge>}
              {page.author && `${page.author} · `}
              {page.publishedAt ? formatDateTime(page.publishedAt) : `edited ${formatRelative(page.updatedAt)}`}
            </p>
          )}
        </div>
        {canEdit && <Button onClick={onEdit}>Edit page</Button>}
      </div>
      <EditorContent editor={editor} />
    </article>
  );
}

function PageEditor({ site, lists, page, onDone }: { site: SiteInfo; lists: SiteListRef[]; page: Page; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [title, setTitle] = useState(page.title);
  const imageInput = useRef<HTMLInputElement>(null);
  const editor = useEditor({ extensions: [...richTextExtensions('Write here…'), ForgeWidget], content: page.content, editorProps: { attributes: { class: 'forge-editor site-page min-h-64 rounded-xl p-4 ring-1 ring-zinc-200 focus:outline-none dark:ring-zinc-800' } } });
  const calendars = useQuery({ queryKey: ['calendar', 'calendars'], queryFn: () => api<{ items: { id: string; name: string; owner: string | null }[] }>('/api/v1/calendar/calendars') });
  const save = useMutation({
    mutationFn: (publish?: boolean) => api(`/api/v1/sites/${site.id}/pages/${page.id}`, { method: 'PUT', body: { title, content: editor!.getJSON(), ...(publish !== undefined ? { publish } : {}) } }),
    onSuccess: (_r, publish) => {
      toast.success(publish ? 'Published' : 'Saved');
      void qc.invalidateQueries({ queryKey: ['sites'] });
      onDone();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const insert = (attrs: Record<string, unknown>) => editor?.chain().focus().insertContent({ type: 'forgeWidget', attrs }).run();
  const btn = (label: string, Icon: typeof Bold, onClick: () => void, active = false) => (
    <button type="button" title={label} aria-label={label} onClick={onClick} className={cn('rounded p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800', active && 'bg-zinc-200 dark:bg-zinc-700')}>
      <Icon className="size-4" />
    </button>
  );
  return (
    <div className="space-y-3">
      {!page.isHome && <Input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} className="text-lg font-semibold" />}
      {editor && <PageToolbar editor={editor} btn={btn} />}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-zinc-500">Add:</span>
        <Button size="sm" variant="ghost" icon={<Newspaper className="size-4" />} onClick={() => insert({ widget: 'news', title: 'News' })}>
          News
        </Button>
        <Button size="sm" variant="ghost" icon={<Folder className="size-4" />} onClick={() => insert({ widget: 'library', title: 'Documents' })}>
          Documents
        </Button>
        <Button size="sm" variant="ghost" onClick={() => insert({ widget: 'activity', title: 'Recent activity' })}>
          Activity
        </Button>
        <Select aria-label="Add a calendar" className="h-8 w-48 py-0 text-sm" value="" onChange={(e) => e.target.value && insert({ widget: 'calendar', title: 'Upcoming events', calendarId: e.target.value })}>
          <option value="">Calendar…</option>
          {calendars.data?.items.map((c) => (
            <option key={c.id} value={c.id}>
              {c.owner ? `${c.owner}: ${c.name}` : c.name}
            </option>
          ))}
        </Select>
        {lists.length > 0 && (
          <Select aria-label="Add a list" className="h-8 w-44 py-0 text-sm" value="" onChange={(e) => e.target.value && insert({ widget: 'list', title: lists.find((l) => l.id === e.target.value)?.name ?? 'List', listId: e.target.value })}>
            <option value="">List…</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        )}
        <Button size="sm" variant="ghost" icon={<ImageIcon className="size-4" />} onClick={() => imageInput.current?.click()}>
          Image
        </Button>
        <input
          ref={imageInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            try {
              // Images live in the site's library, so they follow its permissions.
              const item = await uploadFile(f, { libraryId: site.libraryId, parentId: null }, () => {}, { conflict: 'rename' });
              insert({ widget: 'image', itemId: item.id });
            } catch (err) {
              toast.error(errorMessage(err));
            }
          }}
        />
      </div>
      <EditorContent editor={editor} />
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(page.publishedAt || page.isHome ? undefined : true)}>
          {page.publishedAt || page.isHome ? 'Save' : 'Publish'}
        </Button>
        {!page.publishedAt && !page.isHome && (
          <Button loading={save.isPending} onClick={() => save.mutate(false)}>
            Save draft
          </Button>
        )}
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        {!page.isHome && (
          <Button
            variant="ghost"
            className="ml-auto text-red-600"
            icon={<Trash2 className="size-4" />}
            onClick={async () => {
              if (!window.confirm(`Delete “${page.title}”?`)) return;
              await api(`/api/v1/sites/${site.id}/pages/${page.id}`, { method: 'DELETE' });
              void qc.invalidateQueries({ queryKey: ['sites'] });
              navigate(`/sites/${site.slug}`);
            }}
          >
            Delete page
          </Button>
        )}
      </div>
    </div>
  );
}

function PageToolbar({ editor, btn }: { editor: Editor; btn: (l: string, i: typeof Bold, f: () => void, a?: boolean) => React.ReactNode }) {
  const [, force] = useState(0);
  useEffect(() => {
    const r = () => force((n) => n + 1);
    editor.on('transaction', r);
    return () => void editor.off('transaction', r);
  }, [editor]);
  const chain = () => editor.chain().focus();
  return (
    <div className="flex flex-wrap gap-0.5 rounded-lg p-1 ring-1 ring-zinc-200 dark:ring-zinc-800">
      {btn('Heading', Heading2, () => chain().toggleHeading({ level: 2 }).run(), editor.isActive('heading'))}
      {btn('Bold', Bold, () => chain().toggleBold().run(), editor.isActive('bold'))}
      {btn('Italic', Italic, () => chain().toggleItalic().run(), editor.isActive('italic'))}
      {btn('Bulleted list', List, () => chain().toggleBulletList().run(), editor.isActive('bulletList'))}
      {btn('Numbered list', ListOrdered, () => chain().toggleOrderedList().run(), editor.isActive('orderedList'))}
      {btn('Quote', Quote, () => chain().toggleBlockquote().run(), editor.isActive('blockquote'))}
      {btn('Link', Link2, () => {
        if (editor.isActive('link')) return chain().unsetLink().run();
        const url = window.prompt('Link address');
        if (url) chain().extendMarkRange('link').setLink({ href: /^(https?:|mailto:|\/)/i.test(url) ? url : `https://${url}` }).run();
      }, editor.isActive('link'))}
    </div>
  );
}

function SiteSettings({ site, onClose }: { site: SiteInfo; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [f, setF] = useState({ name: site.name, description: site.description, color: site.color, visibility: site.visibility });
  const [members, setMembers] = useState(false);
  const save = useMutation({
    mutationFn: () => api(`/api/v1/sites/${site.id}`, { method: 'PATCH', body: f }),
    onSuccess: () => {
      toast.success('Site updated');
      void qc.invalidateQueries({ queryKey: ['sites'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Site settings"
      footer={
        <>
          <Button
            variant="danger"
            className="mr-auto"
            onClick={async () => {
              if (!window.confirm(`Delete “${site.name}”, its pages and all its documents? This cannot be undone.`)) return;
              await api(`/api/v1/sites/${site.id}`, { method: 'DELETE' }).catch((e) => toast.error(errorMessage(e)));
              void qc.invalidateQueries({ queryKey: ['sites'] });
              navigate('/sites');
            }}
          >
            Delete site
          </Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name" htmlFor="ss-name">
          <Input id="ss-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Description" htmlFor="ss-desc">
          <Textarea id="ss-desc" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field label="Who can see it" htmlFor="ss-vis">
          <Select id="ss-vis" value={f.visibility} onChange={(e) => setF({ ...f, visibility: e.target.value as SiteInfo['visibility'] })}>
            <option value="members">Only its members</option>
            <option value="organisation">Everyone in the organisation</option>
          </Select>
        </Field>
        <Field label="Colour" htmlFor="ss-color">
          <input id="ss-color" type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} className="h-9 w-14 rounded" />
        </Field>
        <Card>
          <CardBody className="flex items-center justify-between gap-3 text-sm">
            <span>Members and owners (also the site’s document access)</span>
            <Button size="sm" onClick={() => setMembers(true)}>
              Manage members
            </Button>
          </CardBody>
        </Card>
      </div>
      {members && (
        <ShareDialog
          title={`Members of ${site.name}`}
          description="Editors can change pages and documents; owners also manage the site."
          levels={ROLE_LEVELS}
          load={async () =>
            (await api<{ grants: { principalType: 'user' | 'group'; principalId: string; name: string; email: string | null; role: string }[] }>(`/api/v1/drive/libraries/${site.libraryId}/permissions`)).grants.map((g) => ({ principalType: g.principalType, principalId: g.principalId, name: g.name, email: g.email, access: g.role }))
          }
          save={(grants) => api(`/api/v1/drive/libraries/${site.libraryId}/permissions`, { method: 'PUT', body: { grants: grants.map((g) => ({ principalType: g.principalType, principalId: g.principalId, role: g.access })) } })}
          onClose={() => setMembers(false)}
        />
      )}
    </Dialog>
  );
}
