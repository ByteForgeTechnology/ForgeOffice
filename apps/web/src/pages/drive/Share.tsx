import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { ChevronRight, Download, File as FileIcon, Folder } from 'lucide-react';
import { Alert, Button, Input, PageSpinner, formatBytes, formatDateTime } from '@forge/ui';
import { AuthCard } from '../../components/AuthCard';
import { ApiError, api, errorMessage } from '../../lib/api';

interface SharedItem {
  id: string;
  kind: 'file' | 'folder';
  name: string;
  size: number;
  mime: string | null;
  updatedAt: string;
}

/** The page someone outside the organisation sees when they open a sharing link. */
export function SharePage() {
  const { token = '' } = useParams();
  const [state, setState] = useState<{ needsPassword: boolean; item?: SharedItem; sharedBy?: string | null; expiresAt?: string | null } | null>(null);
  const [access, setAccess] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [folder, setFolder] = useState<{ id?: string; breadcrumbs: { id: string; name: string }[]; items: SharedItem[] } | null>(null);

  useEffect(() => {
    api<typeof state>(`/api/v1/share/${token}`, { anonymous: true })
      .then(setState)
      .catch((e) => setError(e instanceof ApiError && e.status === 410 ? 'This link has expired.' : errorMessage(e)));
  }, [token]);

  const openFolder = async (folderId?: string) => {
    const q = new URLSearchParams();
    if (folderId) q.set('folderId', folderId);
    if (access) q.set('access', access);
    try {
      setFolder({ id: folderId, ...(await api<{ breadcrumbs: { id: string; name: string }[]; items: SharedItem[] }>(`/api/v1/share/${token}/items?${q}`, { anonymous: true })) });
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  useEffect(() => {
    if (state?.item?.kind === 'folder') void openFolder();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.item?.id, access]);

  const href = (itemId?: string, inline = false) => {
    const q = new URLSearchParams();
    if (itemId) q.set('itemId', itemId);
    if (access) q.set('access', access);
    if (inline) q.set('inline', 'true');
    return `/api/v1/share/${token}/download?${q}`;
  };

  if (error) return <AuthCard title="Can’t open this link"><Alert tone="danger">{error}</Alert></AuthCard>;
  if (!state) return <PageSpinner />;
  if (state.needsPassword && !access)
    return (
      <AuthCard title="This link is protected" subtitle="Enter the password you were given.">
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const r = await api<{ access: string; item: SharedItem; sharedBy: string | null; expiresAt: string | null }>(`/api/v1/share/${token}/unlock`, { anonymous: true, body: { password } });
              setAccess(r.access);
              setState({ needsPassword: true, item: r.item, sharedBy: r.sharedBy, expiresAt: r.expiresAt });
            } catch (err) {
              setError(null);
              alert(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Input type="password" aria-label="Password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={!password}>
            Open
          </Button>
        </form>
      </AuthCard>
    );
  const item = state.item!;
  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
        <p className="text-sm text-zinc-500">{state.sharedBy ? `${state.sharedBy} shared this with you` : 'Shared with you'}{state.expiresAt ? ` · link expires ${formatDateTime(state.expiresAt)}` : ''}</p>
        <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold">
          {item.kind === 'folder' ? <Folder className="size-6 text-amber-500" /> : <FileIcon className="size-6 text-zinc-400" />}
          {item.name}
        </h1>
        {item.kind === 'file' ? (
          <div className="mt-4 space-y-4">
            <p className="text-sm text-zinc-500">{formatBytes(item.size)} · updated {formatDateTime(item.updatedAt)}</p>
            {item.mime && /^(image\/(png|jpeg|gif|webp)|video\/|audio\/|application\/pdf)/.test(item.mime) && (
              <div className="overflow-hidden rounded-lg bg-zinc-100 dark:bg-zinc-800">
                {item.mime.startsWith('image/') ? <img src={href(undefined, true)} alt={item.name} className="mx-auto max-h-[60vh]" /> : item.mime.startsWith('video/') ? <video src={href(undefined, true)} controls className="w-full" /> : item.mime.startsWith('audio/') ? <audio src={href(undefined, true)} controls className="w-full" /> : <iframe src={href(undefined, true)} title={item.name} className="h-[60vh] w-full bg-white" />}
              </div>
            )}
            <a href={href()}>
              <Button variant="primary" icon={<Download className="size-4" />}>
                Download
              </Button>
            </a>
          </div>
        ) : !folder ? (
          <PageSpinner />
        ) : (
          <div className="mt-4">
            <p className="mb-2 flex flex-wrap items-center gap-1 text-sm">
              {folder.breadcrumbs.map((b, i) => (
                <span key={b.id} className="flex items-center gap-1">
                  {i > 0 && <ChevronRight className="size-3.5 text-zinc-400" />}
                  <button type="button" className="hover:underline" onClick={() => void openFolder(i === 0 ? undefined : b.id)}>
                    {b.name}
                  </button>
                </span>
              ))}
            </p>
            <ul className="divide-y divide-zinc-100 rounded-lg ring-1 ring-zinc-200 dark:divide-zinc-800 dark:ring-zinc-800">
              {folder.items.map((i) => (
                <li key={i.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  {i.kind === 'folder' ? <Folder className="size-4 text-amber-500" /> : <FileIcon className="size-4 text-zinc-400" />}
                  {i.kind === 'folder' ? (
                    <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => void openFolder(i.id)}>
                      {i.name}
                    </button>
                  ) : (
                    <a href={href(i.id)} className="min-w-0 flex-1 truncate hover:underline">
                      {i.name}
                    </a>
                  )}
                  {i.kind === 'file' && <span className="text-xs text-zinc-500">{formatBytes(i.size)}</span>}
                </li>
              ))}
              {!folder.items.length && <li className="px-3 py-4 text-center text-sm text-zinc-500">This folder is empty</li>}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
