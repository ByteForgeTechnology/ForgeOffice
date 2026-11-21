import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight,
  Clock,
  Copy as CopyIcon,
  Download,
  ExternalLink,
  File as FileIcon,
  FileSpreadsheet,
  FileText,
  Film,
  Folder,
  FolderInput,
  FolderPlus,
  HardDrive,
  History,
  Image as ImageIcon,
  Link2,
  Lock,
  Menu,
  MessageSquare,
  Music,
  Pencil,
  Plus,
  Presentation,
  RotateCcw,
  Search,
  Share2,
  ShieldAlert,
  Trash2,
  Unlock,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { Alert, Badge, Button, Dialog, EmptyState, Field, Input, PageSpinner, Select, cn, formatBytes, formatDateTime, formatRelative, useToast } from '@forge/ui';
import { ShareDialog, type ShareGrant } from '../../components/ShareDialog';
import { api, errorMessage } from '../../lib/api';
import { useDebounced } from '../../lib/hooks';
import { ROLE_LEVELS, can, contentUrl, download, isAudio, isImage, isOffice, isPdf, isText, isVideo, uploadFile, type DriveItem, type DriveRole, type Library, type UploadJob } from './drive-api';

type View = 'library' | 'shared' | 'recent' | 'trash' | 'search';

interface Listing {
  library: { id: string; kind: string; name: string; usedBytes: number };
  folder: { id: string; name: string; inheritPermissions: boolean } | null;
  breadcrumbs: { id: string; name: string }[];
  role: DriveRole;
  items: DriveItem[];
}

const iconFor = (i: Pick<DriveItem, 'kind' | 'mime'>) =>
  i.kind === 'folder' ? Folder : isImage(i.mime) ? ImageIcon : isVideo(i.mime) ? Film : isAudio(i.mime) ? Music : isPdf(i.mime) || isText(i.mime) ? FileText : FileIcon;

export function DrivePage() {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [sidebar, setSidebar] = useState(false);
  const [selected, setSelected] = useState<DriveItem | null>(null);
  const [preview, setPreview] = useState<DriveItem | null>(null);
  const [moving, setMoving] = useState<{ item: DriveItem; mode: 'move' | 'copy' } | null>(null);
  const [uploads, setUploads] = useState<UploadJob[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebounced(search.trim(), 300);

  const libraries = useQuery({ queryKey: ['drive', 'libraries'], queryFn: () => api<{ items: Library[]; sharedCount: number; office: boolean }>('/api/v1/drive/libraries') });
  const myLibrary = libraries.data?.items.find((l) => l.mine);
  const view: View = q ? 'search' : ((params.get('view') as View | null) ?? 'library');
  const libraryId = params.get('library') ?? myLibrary?.id ?? null;
  const folderId = params.get('folder');

  const go = (p: Record<string, string | null>) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(p)) if (v) next.set(k, v);
    setParams(next);
    setSelected(null);
    setSearch('');
    setSidebar(false);
  };

  const listing = useQuery({
    queryKey: ['drive', 'items', libraryId, folderId],
    queryFn: () => api<Listing>(`/api/v1/drive/libraries/${libraryId}/items${folderId ? `?parentId=${folderId}` : ''}`),
    enabled: view === 'library' && !!libraryId,
  });
  const shared = useQuery({ queryKey: ['drive', 'shared'], queryFn: () => api<{ items: DriveItem[] }>('/api/v1/drive/shared'), enabled: view === 'shared' });
  const recent = useQuery({ queryKey: ['drive', 'recent'], queryFn: () => api<{ items: DriveItem[] }>('/api/v1/drive/recent'), enabled: view === 'recent' });
  const trash = useQuery({ queryKey: ['drive', 'trash', libraryId], queryFn: () => api<{ items: DriveItem[]; retentionDays: number }>(`/api/v1/drive/libraries/${libraryId}/trash`), enabled: view === 'trash' && !!libraryId });
  const results = useQuery({ queryKey: ['drive', 'search', q], queryFn: () => api<{ items: DriveItem[] }>(`/api/v1/drive/search?q=${encodeURIComponent(q)}`), enabled: view === 'search' });

  const refresh = () => void qc.invalidateQueries({ queryKey: ['drive'] });
  const role = view === 'library' ? listing.data?.role : undefined;
  const items = view === 'library' ? listing.data?.items : view === 'shared' ? shared.data?.items : view === 'recent' ? recent.data?.items : view === 'trash' ? trash.data?.items : results.data?.items;
  const loading = view === 'library' ? listing.isLoading : view === 'shared' ? shared.isLoading : view === 'recent' ? recent.isLoading : view === 'trash' ? trash.isLoading : results.isLoading;

  // ---- uploads ------------------------------------------------------------
  const startUploads = useCallback(
    (files: File[]) => {
      if (!libraryId || !can(role, 'editor')) return toast.error('You can’t upload here');
      for (const file of files) {
        const job: UploadJob = { id: crypto.randomUUID(), name: file.name, size: file.size, sent: 0, state: 'uploading' };
        setUploads((u) => [...u, job]);
        const update = (patch: Partial<UploadJob>) => setUploads((u) => u.map((j) => (j.id === job.id ? { ...j, ...patch } : j)));
        uploadFile(file, { libraryId, parentId: folderId }, (sent) => update({ sent }), { conflict: 'rename' })
          .then(() => {
            update({ state: 'done', sent: file.size });
            refresh();
          })
          .catch((err) => update({ state: 'error', error: errorMessage(err) }));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [libraryId, folderId, role],
  );
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files];
    if (files.length) startUploads(files);
  };

  // ---- actions ------------------------------------------------------------
  const act = useMutation({
    mutationFn: async ({ action, item, value }: { action: 'rename' | 'trash' | 'restore' | 'purge' | 'folder'; item?: DriveItem; value?: string }) => {
      if (action === 'folder') return api(`/api/v1/drive/libraries/${libraryId}/folders`, { body: { parentId: folderId, name: value, conflict: 'fail' } });
      if (action === 'rename') return api(`/api/v1/drive/items/${item!.id}`, { method: 'PATCH', body: { name: value } });
      if (action === 'trash') return api(`/api/v1/drive/items/${item!.id}`, { method: 'DELETE' });
      if (action === 'restore') return api(`/api/v1/drive/items/${item!.id}/restore`, { body: {} });
      return api(`/api/v1/drive/items/${item!.id}/purge`, { method: 'DELETE' });
    },
    onSuccess: (_r, v) => {
      if (v.action === 'trash') toast.success(`“${v.item!.name}” moved to the recycle bin`);
      if (v.action === 'trash' || v.action === 'purge') setSelected(null);
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const open = (i: DriveItem) => {
    if (view === 'trash') return setSelected(i);
    if (i.kind === 'folder') return go({ library: i.libraryId, folder: i.id });
    setPreview(i);
  };

  const libName = (l: Library) => (l.mine ? 'My files' : l.name);
  const groupLibs = libraries.data?.items.filter((l) => !l.mine) ?? [];
  const title =
    view === 'shared' ? 'Shared with me' : view === 'recent' ? 'Recent' : view === 'trash' ? 'Recycle bin' : view === 'search' ? `Results for “${q}”` : listing.data ? (listing.data.library.kind === 'personal' ? 'My files' : listing.data.library.name) : 'Drive';

  if (libraries.isLoading) return <PageSpinner />;

  return (
    <div className="flex h-full">
      <aside className={cn('w-60 shrink-0 overflow-y-auto border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950', sidebar ? 'fixed inset-y-0 left-0 z-30 block shadow-xl' : 'hidden md:block')}>
        <nav aria-label="Drive" className="space-y-1 p-3">
          {can(role, 'editor') && view === 'library' && (
            <Button variant="primary" className="mb-3 w-full" icon={<Upload className="size-4" />} onClick={() => fileInput.current?.click()}>
              Upload
            </Button>
          )}
          {myLibrary && <NavButton active={view === 'library' && libraryId === myLibrary.id} icon={HardDrive} label="My files" onClick={() => go({ library: myLibrary.id })} />}
          <NavButton active={view === 'shared'} icon={Share2} label="Shared with me" count={libraries.data?.sharedCount} onClick={() => go({ view: 'shared' })} />
          <NavButton active={view === 'recent'} icon={Clock} label="Recent" onClick={() => go({ view: 'recent' })} />
          {groupLibs.length > 0 && <p className="px-3 pt-4 pb-1 text-xs font-semibold text-zinc-500">Team libraries</p>}
          {groupLibs.map((l) => (
            <NavButton key={l.id} active={view === 'library' && libraryId === l.id} icon={Users} label={libName(l)} onClick={() => go({ library: l.id })} />
          ))}
          <div className="pt-4">
            <NavButton active={view === 'trash'} icon={Trash2} label="Recycle bin" onClick={() => go({ view: 'trash', library: libraryId })} />
          </div>
          {myLibrary && <p className="px-3 pt-4 text-xs text-zinc-500">{formatBytes(myLibrary.usedBytes)} used in My files</p>}
        </nav>
      </aside>

      <section
        className="relative flex min-w-0 flex-1 flex-col"
        onDragOver={(e) => {
          if (can(role, 'editor') && e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
        onDrop={onDrop}
      >
        <header className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <button type="button" aria-label="Libraries" className="rounded-lg p-1.5 hover:bg-zinc-100 md:hidden dark:hover:bg-zinc-800" onClick={() => setSidebar(true)}>
            <Menu className="size-5" />
          </button>
          <div className="relative min-w-48 flex-1 sm:max-w-md">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-zinc-400" />
            <input aria-label="Search files" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search names and contents" className="h-9 w-full rounded-lg border-0 bg-zinc-100 pr-3 pl-9 text-sm focus:ring-2 focus:ring-brand dark:bg-zinc-800" />
          </div>
          {view === 'library' && can(role, 'editor') && (
            <>
              <NewMenu
                office={!!libraries.data?.office}
                onFolder={() => {
                  const name = window.prompt('Folder name');
                  if (name?.trim()) act.mutate({ action: 'folder', value: name.trim() });
                }}
                onDocument={async (kind, label) => {
                  const name = window.prompt(`Name of the new ${label.toLowerCase()}`, label);
                  if (!name?.trim()) return;
                  try {
                    const r = await api<{ item: DriveItem }>(`/api/v1/drive/libraries/${libraryId}/documents`, { body: { parentId: folderId, kind, name: name.trim() } });
                    refresh();
                    navigate(`/drive/edit/${r.item.id}`);
                  } catch (e) {
                    toast.error(errorMessage(e));
                  }
                }}
              />
              <Button size="sm" icon={<Upload className="size-4" />} onClick={() => fileInput.current?.click()} className="md:hidden">
                Upload
              </Button>
            </>
          )}
          {view === 'trash' && !!trash.data?.items.length && (
            <Button size="sm" variant="danger" onClick={async () => {
              if (!window.confirm('Delete everything in the recycle bin for good?')) return;
              try {
                await api(`/api/v1/drive/libraries/${libraryId}/trash`, { method: 'DELETE' });
                refresh();
              } catch (e) {
                toast.error(errorMessage(e));
              }
            }}>
              Empty recycle bin
            </Button>
          )}
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => {
            startUploads([...(e.target.files ?? [])]);
            e.target.value = '';
          }} />
        </header>

        <div className="flex items-center gap-1 px-4 pt-3 text-sm">
          {view === 'library' && listing.data ? (
            <nav aria-label="Folder path" className="flex min-w-0 flex-wrap items-center gap-1">
              <button type="button" className="font-semibold hover:underline" onClick={() => go({ library: libraryId })}>
                {title}
              </button>
              {listing.data.breadcrumbs.map((b) => (
                <span key={b.id} className="flex items-center gap-1">
                  <ChevronRight className="size-4 text-zinc-400" />
                  <button type="button" className="hover:underline" onClick={() => go({ library: libraryId, folder: b.id })}>
                    {b.name}
                  </button>
                </span>
              ))}
              {listing.data.role === 'viewer' && <Badge className="ml-2">View only</Badge>}
            </nav>
          ) : (
            <h1 className="font-semibold">{title}</h1>
          )}
        </div>
        {view === 'trash' && trash.data && <p className="px-4 pt-1 text-xs text-zinc-500">Items are deleted for good after {trash.data.retentionDays} days.</p>}

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {loading ? (
            <PageSpinner />
          ) : !items?.length ? (
            <EmptyState
              icon={view === 'trash' ? <Trash2 /> : <Folder />}
              title={view === 'trash' ? 'The recycle bin is empty' : view === 'search' ? 'Nothing found' : view === 'shared' ? 'Nothing shared with you yet' : 'This folder is empty'}
              description={view === 'library' && can(role, 'editor') ? 'Drag files here, or use Upload.' : undefined}
            />
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-zinc-500">
                <tr>
                  <th className="px-2 py-1.5 font-medium">Name</th>
                  <th className="hidden px-2 py-1.5 font-medium md:table-cell">{view === 'trash' ? 'Deleted' : 'Modified'}</th>
                  <th className="hidden px-2 py-1.5 text-right font-medium sm:table-cell">Size</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => {
                  const Icon = iconFor(i);
                  return (
                    <tr key={i.id} className={cn('cursor-pointer border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900', selected?.id === i.id && 'bg-brand/5')} onClick={() => setSelected(i)} onDoubleClick={() => open(i)}>
                      <td className="px-2 py-2">
                        <span className="flex min-w-0 items-center gap-3">
                          {i.thumbnailUrl ? <img src={i.thumbnailUrl} alt="" className="size-8 shrink-0 rounded object-cover" loading="lazy" /> : <Icon className={cn('size-5 shrink-0', i.kind === 'folder' ? 'text-amber-500' : 'text-zinc-400')} />}
                          <button type="button" className="min-w-0 truncate text-left hover:underline" onClick={(e) => (e.stopPropagation(), open(i))}>
                            {i.name}
                          </button>
                          {i.scanStatus === 'infected' && <Badge tone="danger">Virus</Badge>}
                          {i.scanStatus === 'pending' && <Badge>Scanning</Badge>}
                          {i.checkedOutBy && <Lock className="size-3.5 shrink-0 text-amber-600" aria-label={`Checked out by ${i.checkedOutBy.name}`} />}
                        </span>
                        {(view === 'shared' || view === 'search') && (i.library?.name || i.libraryName) && <span className="ml-11 block truncate text-xs text-zinc-500">{i.library?.name ?? i.libraryName}</span>}
                      </td>
                      <td className="hidden px-2 py-2 text-zinc-500 md:table-cell">
                        {view === 'trash' ? `${formatRelative(i.deletedAt)}${i.deletedBy ? ` by ${i.deletedBy}` : ''}` : `${formatRelative(i.updatedAt)}${i.updatedBy ? ` · ${i.updatedBy}` : ''}`}
                      </td>
                      <td className="hidden px-2 py-2 text-right text-zinc-500 sm:table-cell">{i.kind === 'file' ? formatBytes(i.size) : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {dragging && (
          <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-xl border-2 border-dashed border-brand bg-brand/5 text-lg font-medium text-brand">
            Drop files to upload to {listing.data?.folder?.name ?? title}
          </div>
        )}
        <UploadTray jobs={uploads} onClear={() => setUploads((u) => u.filter((j) => j.state === 'uploading'))} />
      </section>

      {selected && (
        <DetailsPanel
          key={selected.id}
          item={selected}
          inTrash={view === 'trash'}
          onClose={() => setSelected(null)}
          onOpen={() => open(selected)}
          onAction={(action, value) => act.mutate({ action, item: selected, value })}
          onMove={(mode) => setMoving({ item: selected, mode })}
        />
      )}
      {preview && <Viewer item={preview} onClose={() => setPreview(null)} />}
      {moving && (
        <MoveDialog
          item={moving.item}
          mode={moving.mode}
          libraries={libraries.data?.items ?? []}
          onClose={() => setMoving(null)}
          onDone={() => {
            setMoving(null);
            setSelected(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function NavButton({ active, icon: Icon, label, count, onClick }: { active: boolean; icon: typeof Folder; label: string; count?: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm', active ? 'bg-white font-medium shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800' : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800')}
    >
      <Icon className="size-4 shrink-0 text-zinc-500" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {!!count && <span className="text-xs text-zinc-500">{count}</span>}
    </button>
  );
}

function UploadTray({ jobs, onClear }: { jobs: UploadJob[]; onClear: () => void }) {
  if (!jobs.length) return null;
  const active = jobs.filter((j) => j.state === 'uploading').length;
  return (
    <div className="absolute right-3 bottom-3 z-20 w-80 overflow-hidden rounded-xl bg-white shadow-xl ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
      <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 text-sm font-medium dark:border-zinc-800">
        {active ? `Uploading ${active} file${active === 1 ? '' : 's'}` : 'Uploads finished'}
        {!active && (
          <button type="button" aria-label="Close" onClick={onClear} className="rounded p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X className="size-4" />
          </button>
        )}
      </div>
      <ul className="max-h-60 overflow-y-auto">
        {jobs.map((j) => (
          <li key={j.id} className="px-3 py-2 text-xs">
            <p className="flex justify-between gap-2">
              <span className="truncate">{j.name}</span>
              <span className={cn('shrink-0', j.state === 'error' ? 'text-red-600' : 'text-zinc-500')}>{j.state === 'error' ? 'Failed' : j.state === 'done' ? 'Done' : `${Math.round((j.sent / Math.max(j.size, 1)) * 100)}%`}</span>
            </p>
            {j.state === 'uploading' && (
              <div className="mt-1 h-1 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
                <div className="h-full bg-brand transition-all" style={{ width: `${(j.sent / Math.max(j.size, 1)) * 100}%` }} />
              </div>
            )}
            {j.error && <p className="mt-0.5 text-red-600">{j.error}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Details panel: info, versions, sharing, comments, activity
// ---------------------------------------------------------------------------

interface ItemDetail extends DriveItem {
  role: DriveRole;
  library: { id: string; name: string; kind: string };
  breadcrumbs: { id: string; name: string }[];
  counts: { versions: number; links: number; comments: number };
  office: boolean;
}

function DetailsPanel({ item: summary, inTrash, onClose, onOpen, onAction, onMove }: { item: DriveItem; inTrash: boolean; onClose: () => void; onOpen: () => void; onAction: (a: 'rename' | 'trash' | 'restore' | 'purge', v?: string) => void; onMove: (mode: 'move' | 'copy') => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'details' | 'versions' | 'sharing' | 'comments' | 'activity'>('details');
  const detail = useQuery({ queryKey: ['drive', 'item', summary.id], queryFn: () => api<{ item: ItemDetail }>(`/api/v1/drive/items/${summary.id}`), enabled: !inTrash });
  const item = detail.data?.item;
  const role = item?.role;
  const refresh = () => void qc.invalidateQueries({ queryKey: ['drive'] });
  const checkout = useMutation({
    mutationFn: (v: 'out' | 'in' | 'discard') => api(`/api/v1/drive/items/${summary.id}/${v === 'out' ? 'checkout' : 'checkin'}`, { body: v === 'discard' ? { discard: true } : {} }),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const Icon = iconFor(summary);

  return (
    <aside aria-label="Details" className="fixed inset-0 z-30 flex w-full flex-col border-l border-zinc-200 bg-white md:static md:z-auto md:w-96 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <Icon className="size-5 shrink-0 text-zinc-400" />
        <p className="min-w-0 flex-1 truncate font-medium">{summary.name}</p>
        <button type="button" aria-label="Close details" onClick={onClose} className="rounded p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800">
          <X className="size-4" />
        </button>
      </div>

      {inTrash ? (
        <div className="space-y-3 p-4 text-sm">
          <p className="text-zinc-500">Deleted {formatDateTime(summary.deletedAt)}{summary.deletedBy ? ` by ${summary.deletedBy}` : ''}.</p>
          <div className="flex gap-2">
            <Button icon={<RotateCcw className="size-4" />} onClick={() => onAction('restore')}>
              Restore
            </Button>
            <Button variant="danger" onClick={() => window.confirm(`Delete “${summary.name}” for good? This cannot be undone.`) && onAction('purge')}>
              Delete for good
            </Button>
          </div>
        </div>
      ) : !item ? (
        <PageSpinner />
      ) : (
        <>
          <div className="flex flex-wrap gap-1 border-b border-zinc-200 px-2 py-2 dark:border-zinc-800">
            {item.kind === 'file' && (
              <IconAction label="Open" icon={ExternalLink} onClick={onOpen} />
            )}
            {item.kind === 'file' && item.scanStatus !== 'infected' && <IconAction label="Download" icon={Download} onClick={() => void download(item.id).catch((e) => toast.error(errorMessage(e)))} />}
            {can(role, 'editor') && (
              <IconAction label="Rename" icon={Pencil} onClick={() => {
                const name = window.prompt('New name', item.name);
                if (name?.trim() && name !== item.name) onAction('rename', name.trim());
              }} />
            )}
            {can(role, 'editor') && <IconAction label="Move" icon={FolderInput} onClick={() => onMove('move')} />}
            <IconAction label="Copy" icon={CopyIcon} onClick={() => onMove('copy')} />
            {can(role, 'editor') && <IconAction label="Delete" icon={Trash2} onClick={() => window.confirm(`Move “${item.name}” to the recycle bin?`) && onAction('trash')} />}
            {item.office && isOffice(item.name) && (
              <Button size="sm" className="ml-auto" onClick={() => navigate(`/drive/edit/${item.id}`)}>
                {can(role, 'editor') ? 'Edit in browser' : 'Open in browser'}
              </Button>
            )}
          </div>
          <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-zinc-200 px-2 dark:border-zinc-800">
            {(
              [
                ['details', 'Details'],
                ...(item.kind === 'file' ? [['versions', `Versions (${item.counts.versions})`]] : []),
                ['sharing', 'Sharing'],
                ['comments', `Comments (${item.counts.comments})`],
                ['activity', 'Activity'],
              ] as [typeof tab, string][]
            ).map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cn('border-b-2 px-2 py-2 text-xs font-medium whitespace-nowrap', tab === k ? 'border-brand text-brand' : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200')}>
                {label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4 text-sm">
            {tab === 'details' && (
              <div className="space-y-4">
                {item.thumbnailUrl && <img src={item.thumbnailUrl} alt="" className="w-full rounded-lg ring-1 ring-zinc-200 dark:ring-zinc-800" />}
                {item.scanStatus === 'infected' && <Alert tone="danger" title="Virus found">{item.scanDetail}. This file cannot be opened, downloaded or shared.</Alert>}
                {item.checkedOutBy && (
                  <Alert tone="warning" title={`Checked out by ${item.checkedOutBy.name}`}>
                    Only they can save new versions until it is checked in.
                    {can(role, 'owner') && (
                      <button type="button" className="mt-1 block font-medium underline" onClick={() => checkout.mutate('discard')}>
                        Discard check-out
                      </button>
                    )}
                  </Alert>
                )}
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                  <dt className="text-zinc-500">Location</dt>
                  <dd className="truncate">{[item.library.kind === 'personal' ? 'My files' : item.library.name, ...item.breadcrumbs.map((b) => b.name)].join(' › ')}</dd>
                  {item.kind === 'file' && (
                    <>
                      <dt className="text-zinc-500">Size</dt>
                      <dd>{formatBytes(item.size)}</dd>
                      <dt className="text-zinc-500">Type</dt>
                      <dd className="truncate">{item.mime}</dd>
                    </>
                  )}
                  <dt className="text-zinc-500">Modified</dt>
                  <dd>
                    {formatDateTime(item.updatedAt)}
                    {item.updatedBy ? ` by ${item.updatedBy}` : ''}
                  </dd>
                  <dt className="text-zinc-500">Your access</dt>
                  <dd className="capitalize">{role}</dd>
                </dl>
                {item.kind === 'file' && can(role, 'editor') && (
                  <div className="flex flex-wrap gap-2">
                    {!item.checkedOutBy ? (
                      <Button size="sm" icon={<Lock className="size-4" />} onClick={() => checkout.mutate('out')}>
                        Check out
                      </Button>
                    ) : (
                      item.checkedOutBy && (
                        <Button size="sm" icon={<Unlock className="size-4" />} onClick={() => checkout.mutate('in')}>
                          Check in
                        </Button>
                      )
                    )}
                    <ReplaceButton item={item} onDone={refresh} />
                  </div>
                )}
              </div>
            )}
            {tab === 'versions' && <Versions item={item} />}
            {tab === 'sharing' && <Sharing item={item} />}
            {tab === 'comments' && <Comments itemId={item.id} />}
            {tab === 'activity' && <Activity path={`/api/v1/drive/items/${item.id}/activity`} />}
          </div>
        </>
      )}
    </aside>
  );
}

function IconAction({ label, icon: Icon, onClick }: { label: string; icon: typeof Folder; onClick: () => void }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} className="rounded-lg p-2 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800">
      <Icon className="size-4" />
    </button>
  );
}

/** Upload a new version of this file. */
function ReplaceButton({ item, onDone }: { item: ItemDetail; onDone: () => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button size="sm" loading={busy} icon={<Upload className="size-4" />} onClick={() => input.current?.click()}>
        Upload new version
      </Button>
      <input
        ref={input}
        type="file"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          setBusy(true);
          try {
            await uploadFile(f, { libraryId: item.libraryId, parentId: item.parentId, itemId: item.id }, () => {});
            toast.success('New version saved');
            onDone();
          } catch (err) {
            toast.error(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      />
    </>
  );
}

function Versions({ item }: { item: ItemDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['drive', 'versions', item.id], queryFn: () => api<{ items: { id: string; number: number; size: number; comment: string; createdAt: string; createdBy: string | null; current: boolean }[] }>(`/api/v1/drive/items/${item.id}/versions`) });
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.success(ok);
      void qc.invalidateQueries({ queryKey: ['drive'] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  if (!list.data) return <PageSpinner />;
  return (
    <ul className="space-y-2">
      {list.data.items.map((v) => (
        <li key={v.id} className="rounded-lg p-2 ring-1 ring-zinc-200 dark:ring-zinc-800">
          <p className="flex items-center gap-2 font-medium">
            Version {v.number} {v.current && <Badge tone="success">Current</Badge>}
          </p>
          <p className="text-xs text-zinc-500">
            {formatDateTime(v.createdAt)}
            {v.createdBy ? ` · ${v.createdBy}` : ''} · {formatBytes(v.size)}
          </p>
          {v.comment && <p className="text-xs text-zinc-500">{v.comment}</p>}
          <div className="mt-1 flex gap-1">
            <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => void download(item.id, v.id)}>
              Download
            </Button>
            {!v.current && can(item.role, 'editor') && (
              <Button size="sm" variant="ghost" icon={<History className="size-3.5" />} onClick={() => void run(() => api(`/api/v1/drive/items/${item.id}/versions/${v.id}/restore`, { body: {} }), `Version ${v.number} restored`)}>
                Restore
              </Button>
            )}
            {!v.current && can(item.role, 'owner') && (
              <Button size="sm" variant="ghost" aria-label={`Delete version ${v.number}`} onClick={() => window.confirm(`Delete version ${v.number}?`) && void run(() => api(`/api/v1/drive/items/${item.id}/versions/${v.id}`, { method: 'DELETE' }), 'Version deleted')}>
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

interface Permissions {
  direct: (ShareGrant & { role: DriveRole })[];
  inherited: { from: string; grants: (ShareGrant & { role: DriveRole })[] }[];
  inheritPermissions: boolean;
  library: { kind: string; everyoneRole: DriveRole | null };
}

function Sharing({ item }: { item: ItemDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const perms = useQuery({ queryKey: ['drive', 'perms', item.id], queryFn: () => api<Permissions>(`/api/v1/drive/items/${item.id}/permissions`) });
  const links = useQuery({
    queryKey: ['drive', 'links', item.id],
    queryFn: () => api<{ items: { id: string; url: string; hasPassword: boolean; expiresAt: string | null; maxDownloads: number | null; downloadCount: number; createdBy: string | null; expired: boolean }[] }>(`/api/v1/drive/items/${item.id}/links`),
    enabled: can(item.role, 'editor'),
  });
  const isOwner = can(item.role, 'owner');
  const toggleInherit = async (v: boolean) => {
    try {
      await api(`/api/v1/drive/items/${item.id}`, { method: 'PATCH', body: { inheritPermissions: v } });
      void qc.invalidateQueries({ queryKey: ['drive'] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const grantList = (g: (ShareGrant & { role: DriveRole })[]) =>
    g.map((x) => (
      <li key={`${x.principalType}${x.principalId}`} className="flex items-center gap-2">
        {x.principalType === 'group' ? <Users className="size-4 text-zinc-400" /> : <span className="size-4" />}
        <span className="min-w-0 flex-1 truncate">{x.name}</span>
        <span className="text-xs text-zinc-500 capitalize">{x.role}</span>
      </li>
    ));

  if (!perms.data) return <PageSpinner />;
  return (
    <div className="space-y-5">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-medium">People with access</h3>
          {isOwner && (
            <Button size="sm" icon={<Share2 className="size-3.5" />} onClick={() => setEditing(true)}>
              Share
            </Button>
          )}
        </div>
        {perms.data.direct.length ? <ul className="space-y-1.5">{grantList(perms.data.direct)}</ul> : <p className="text-zinc-500">Not shared directly.</p>}
        {perms.data.inherited.map((h) => (
          <div key={h.from} className="mt-3">
            <p className="mb-1 text-xs text-zinc-500">From “{h.from}”</p>
            <ul className="space-y-1.5">{grantList(h.grants)}</ul>
          </div>
        ))}
        {perms.data.library.everyoneRole && <p className="mt-3 text-xs text-zinc-500">Everyone in the organisation: {perms.data.library.everyoneRole}</p>}
        {isOwner && (
          <label className="mt-3 flex items-center gap-2 text-xs">
            <input type="checkbox" className="rounded" checked={!perms.data.inheritPermissions} onChange={(e) => void toggleInherit(!e.target.checked)} />
            Stop inheriting access from the folder above (only the people listed here keep access)
          </label>
        )}
      </section>

      {can(item.role, 'editor') && (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-medium">Links for people outside</h3>
            <Button size="sm" icon={<Link2 className="size-3.5" />} disabled={item.scanStatus === 'infected'} onClick={() => setLinkOpen(true)}>
              New link
            </Button>
          </div>
          {!links.data?.items.length ? (
            <p className="text-zinc-500">No links.</p>
          ) : (
            <ul className="space-y-2">
              {links.data.items.map((l) => (
                <li key={l.id} className={cn('rounded-lg p-2 ring-1 ring-zinc-200 dark:ring-zinc-800', l.expired && 'opacity-60')}>
                  <div className="flex items-center gap-2">
                    <input readOnly value={l.url} aria-label="Link" className="h-8 min-w-0 flex-1 rounded border-0 bg-zinc-100 px-2 font-mono text-xs dark:bg-zinc-800" onFocus={(e) => e.target.select()} />
                    <Button size="sm" variant="ghost" aria-label="Copy link" onClick={() => void navigator.clipboard?.writeText(l.url).then(() => toast.success('Link copied'))}>
                      <CopyIcon className="size-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" aria-label="Stop this link working" onClick={async () => {
                      await api(`/api/v1/drive/links/${l.id}`, { method: 'DELETE' }).catch((e) => toast.error(errorMessage(e)));
                      void qc.invalidateQueries({ queryKey: ['drive', 'links', item.id] });
                    }}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">
                    {[l.hasPassword && 'Password', l.expiresAt && `Expires ${formatDateTime(l.expiresAt)}`, l.maxDownloads && `${l.downloadCount}/${l.maxDownloads} downloads`, l.expired && 'No longer works'].filter(Boolean).join(' · ') || 'Anyone with the link'}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {editing && (
        <ShareDialog
          title={`Share “${item.name}”`}
          description="People and groups get this access here and in everything inside it."
          levels={ROLE_LEVELS}
          load={async () => perms.data!.direct.map((g) => ({ principalType: g.principalType, principalId: g.principalId, name: g.name, email: g.email, access: g.role }))}
          save={async (grants) => {
            await api(`/api/v1/drive/items/${item.id}/permissions`, { method: 'PUT', body: { grants: grants.map((g) => ({ principalType: g.principalType, principalId: g.principalId, role: g.access })) } });
            void qc.invalidateQueries({ queryKey: ['drive'] });
          }}
          onClose={() => setEditing(false)}
        />
      )}
      {linkOpen && <NewLinkDialog itemId={item.id} onClose={() => setLinkOpen(false)} />}
    </div>
  );
}

function NewLinkDialog({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ password: '', expires: '', maxDownloads: '' });
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api<{ link: { url: string } }>(`/api/v1/drive/items/${itemId}/links`, {
        body: { ...(f.password ? { password: f.password } : {}), ...(f.expires ? { expiresAt: new Date(`${f.expires}T23:59:59`).toISOString() } : {}), ...(f.maxDownloads ? { maxDownloads: Number(f.maxDownloads) } : {}) },
      }),
    onSuccess: (r) => {
      void navigator.clipboard?.writeText(r.link.url);
      toast.success('Link created and copied');
      void qc.invalidateQueries({ queryKey: ['drive'] });
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Link for people outside the organisation"
      description="Anyone with the link can open and download this, without signing in."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
            Create link
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
        <Field label="Password (optional)" htmlFor="l-pw">
          <Input id="l-pw" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        </Field>
        <Field label="Expires (optional)" htmlFor="l-exp">
          <Input id="l-exp" type="date" value={f.expires} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setF({ ...f, expires: e.target.value })} />
        </Field>
        <Field label="Download limit (optional)" htmlFor="l-max">
          <Input id="l-max" type="number" min={1} value={f.maxDownloads} onChange={(e) => setF({ ...f, maxDownloads: e.target.value })} className="w-32" />
        </Field>
      </div>
    </Dialog>
  );
}

function Comments({ itemId }: { itemId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [body, setBody] = useState('');
  const list = useQuery({ queryKey: ['drive', 'comments', itemId], queryFn: () => api<{ canComment: boolean; items: { id: string; body: string; author: string | null; mine: boolean; createdAt: string; resolvedAt: string | null }[] }>(`/api/v1/drive/items/${itemId}/comments`) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['drive', 'comments', itemId] });
  const post = useMutation({
    mutationFn: () => api(`/api/v1/drive/items/${itemId}/comments`, { body: { body } }),
    onSuccess: () => {
      setBody('');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!list.data) return <PageSpinner />;
  return (
    <div className="space-y-3">
      {!list.data.items.length && <p className="text-zinc-500">No comments yet.</p>}
      {list.data.items.map((c) => (
        <div key={c.id} className={cn('rounded-lg p-2 ring-1 ring-zinc-200 dark:ring-zinc-800', c.resolvedAt && 'opacity-60')}>
          <p className="text-xs text-zinc-500">
            <span className="font-medium text-zinc-800 dark:text-zinc-200">{c.author ?? 'Someone'}</span> · {formatRelative(c.createdAt)} {c.resolvedAt && '· resolved'}
          </p>
          <p className="mt-1 whitespace-pre-wrap">{c.body}</p>
          {list.data.canComment && (
            <div className="mt-1 flex gap-2 text-xs">
              <button type="button" className="text-zinc-500 hover:underline" onClick={async () => (await api(`/api/v1/drive/comments/${c.id}`, { method: 'PATCH', body: { resolved: !c.resolvedAt } }), refresh())}>
                {c.resolvedAt ? 'Reopen' : 'Resolve'}
              </button>
              {c.mine && (
                <button type="button" className="text-zinc-500 hover:underline" onClick={async () => (await api(`/api/v1/drive/comments/${c.id}`, { method: 'DELETE' }), refresh())}>
                  Delete
                </button>
              )}
            </div>
          )}
        </div>
      ))}
      {list.data.canComment && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim()) post.mutate();
          }}
          className="space-y-2"
        >
          <textarea aria-label="Comment" rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a comment" className="w-full rounded-lg border-0 bg-zinc-50 px-3 py-2 text-sm ring-1 ring-zinc-200 ring-inset focus:ring-2 focus:ring-brand dark:bg-zinc-900 dark:ring-zinc-800" />
          <Button type="submit" size="sm" icon={<MessageSquare className="size-3.5" />} loading={post.isPending} disabled={!body.trim()}>
            Comment
          </Button>
        </form>
      )}
    </div>
  );
}

const ACTIONS: Record<string, string> = {
  folder_created: 'created the folder',
  file_uploaded: 'uploaded',
  version_added: 'saved a new version of',
  renamed: 'renamed',
  moved: 'moved',
  copied: 'copied',
  deleted: 'deleted',
  restored: 'restored',
  version_restored: 'restored an older version of',
  checked_out: 'checked out',
  checked_in: 'checked in',
  check_out_discarded: 'discarded the check-out of',
  permissions_changed: 'changed who can access',
  link_created: 'created a link to',
  link_downloaded: 'Someone with a link downloaded',
  commented: 'commented on',
};

export function Activity({ path, compact }: { path: string; compact?: boolean }) {
  const list = useQuery({ queryKey: ['drive', 'activity', path], queryFn: () => api<{ items: { id: number; action: string; itemName: string; user: string | null; createdAt: string }[] }>(path) });
  if (!list.data) return <PageSpinner />;
  if (!list.data.items.length) return <p className="text-sm text-zinc-500">No activity yet.</p>;
  return (
    <ul className={cn('space-y-2 text-sm', compact && 'text-xs')}>
      {list.data.items.slice(0, compact ? 8 : 100).map((a) => (
        <li key={a.id}>
          {a.action === 'link_downloaded' ? ACTIONS[a.action] : <span className="font-medium">{a.user ?? 'Someone'}</span>} {a.action === 'link_downloaded' ? '' : (ACTIONS[a.action] ?? a.action)} <span className="font-medium">{a.itemName}</span>
          <span className="block text-xs text-zinc-500">{formatRelative(a.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Viewer and move/copy dialog
// ---------------------------------------------------------------------------

function Viewer({ item, onClose }: { item: DriveItem; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    contentUrl(item.id)
      .then(async (u) => {
        setUrl(u);
        if (isText(item.mime) && item.size < 2_000_000) setText(await (await fetch(u)).text());
      })
      .catch((e) => setError(errorMessage(e)));
  }, [item]);
  const kind = isImage(item.mime) ? 'image' : isVideo(item.mime) ? 'video' : isAudio(item.mime) ? 'audio' : isPdf(item.mime) ? 'pdf' : isText(item.mime) ? 'text' : 'other';
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950/95 text-white" role="dialog" aria-label={item.name}>
      <div className="flex items-center gap-2 px-4 py-2">
        <p className="min-w-0 flex-1 truncate font-medium">{item.name}</p>
        {isOffice(item.name) && (
          <Button size="sm" onClick={() => navigate(`/drive/edit/${item.id}`)}>
            Open in browser
          </Button>
        )}
        <Button size="sm" icon={<Download className="size-4" />} onClick={() => void download(item.id).catch((e) => toast.error(errorMessage(e)))}>
          Download
        </Button>
        <button type="button" aria-label="Close" onClick={onClose} className="rounded p-2 hover:bg-white/10">
          <X className="size-5" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        {error ? (
          <Alert tone="danger">{error}</Alert>
        ) : !url ? (
          <PageSpinner />
        ) : kind === 'image' ? (
          <img src={url} alt={item.name} className="max-h-full max-w-full object-contain" />
        ) : kind === 'video' ? (
          <video src={url} controls className="max-h-full max-w-full" />
        ) : kind === 'audio' ? (
          <audio src={url} controls />
        ) : kind === 'pdf' ? (
          <iframe src={url} title={item.name} className="h-full w-full rounded bg-white" />
        ) : kind === 'text' && text !== null ? (
          <pre className="h-full w-full max-w-4xl overflow-auto rounded bg-white p-4 text-sm whitespace-pre-wrap text-zinc-900">{text}</pre>
        ) : (
          <div className="text-center">
            <ShieldAlert className="mx-auto mb-2 size-8 opacity-60" />
            <p>This file can’t be previewed here.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function MoveDialog({ item, mode, libraries, onClose, onDone }: { item: DriveItem; mode: 'move' | 'copy'; libraries: Library[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const writable = libraries.filter((l) => can(l.role, 'editor'));
  const [libraryId, setLibraryId] = useState(item.libraryId && writable.some((l) => l.id === item.libraryId) ? item.libraryId : (writable[0]?.id ?? ''));
  const [folderId, setFolderId] = useState<string | null>(null);
  const listing = useQuery({ queryKey: ['drive', 'picker', libraryId, folderId], queryFn: () => api<Listing>(`/api/v1/drive/libraries/${libraryId}/items${folderId ? `?parentId=${folderId}` : ''}`), enabled: !!libraryId });
  const folders = useMemo(() => listing.data?.items.filter((i) => i.kind === 'folder' && i.id !== item.id) ?? [], [listing.data, item.id]);
  const run = useMutation({
    mutationFn: () => api(`/api/v1/drive/items/${item.id}/${mode}`, { body: { libraryId, parentId: folderId, conflict: 'rename' } }),
    onSuccess: () => {
      toast.success(mode === 'move' ? 'Moved' : 'Copied');
      onDone();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${mode === 'move' ? 'Move' : 'Copy'} “${item.name}”`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={run.isPending} disabled={!libraryId} onClick={() => run.mutate()}>
            {mode === 'move' ? 'Move here' : 'Copy here'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Library" htmlFor="mv-lib">
          <Select id="mv-lib" value={libraryId} onChange={(e) => (setLibraryId(e.target.value), setFolderId(null))}>
            {writable.map((l) => (
              <option key={l.id} value={l.id}>
                {l.mine ? 'My files' : l.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="text-sm">
          <p className="mb-1 flex flex-wrap items-center gap-1">
            <button type="button" className="hover:underline" onClick={() => setFolderId(null)}>
              Top
            </button>
            {listing.data?.breadcrumbs.map((b) => (
              <span key={b.id} className="flex items-center gap-1">
                <ChevronRight className="size-3.5 text-zinc-400" />
                <button type="button" className="hover:underline" onClick={() => setFolderId(b.id)}>
                  {b.name}
                </button>
              </span>
            ))}
          </p>
          <ul className="max-h-64 overflow-y-auto rounded-lg ring-1 ring-zinc-200 dark:ring-zinc-800">
            {folders.map((f) => (
              <li key={f.id}>
                <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900" onClick={() => setFolderId(f.id)}>
                  <Folder className="size-4 text-amber-500" /> {f.name}
                </button>
              </li>
            ))}
            {!folders.length && <li className="px-3 py-2 text-zinc-500">No folders here</li>}
          </ul>
        </div>
      </div>
    </Dialog>
  );
}


const NEW_DOCUMENTS = [
  { kind: 'docx', label: 'Document', menu: 'Word document', Icon: FileText, color: 'text-blue-600' },
  { kind: 'xlsx', label: 'Workbook', menu: 'Excel workbook', Icon: FileSpreadsheet, color: 'text-emerald-600' },
  { kind: 'pptx', label: 'Presentation', menu: 'PowerPoint presentation', Icon: Presentation, color: 'text-orange-600' },
] as const;

/** "New": a folder, or (when Office editing is set up) a blank Office document opened in the editor. */
function NewMenu({ office, onFolder, onDocument }: { office: boolean; onFolder: () => void; onDocument: (kind: 'docx' | 'xlsx' | 'pptx', label: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  if (!office)
    return (
      <Button size="sm" icon={<FolderPlus className="size-4" />} onClick={onFolder}>
        New folder
      </Button>
    );
  const item = 'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800';
  return (
    <div ref={ref} className="relative">
      <Button size="sm" variant="primary" icon={<Plus className="size-4" />} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        New
      </Button>
      {open && (
        <div role="menu" className="absolute left-0 z-20 mt-1 w-56 overflow-hidden rounded-lg bg-white py-1 shadow-lg ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
          <button type="button" role="menuitem" className={item} onClick={() => (setOpen(false), onFolder())}>
            <FolderPlus className="size-4 text-amber-500" /> Folder
          </button>
          <div className="my-1 border-t border-zinc-100 dark:border-zinc-800" />
          {NEW_DOCUMENTS.map((d) => (
            <button key={d.kind} type="button" role="menuitem" className={item} onClick={() => (setOpen(false), onDocument(d.kind, d.label))}>
              <d.Icon className={cn('size-4', d.color)} /> {d.menu}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
