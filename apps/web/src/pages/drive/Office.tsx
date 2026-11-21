import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Eye } from 'lucide-react';
import { Alert, Badge, Button, PageSpinner } from '@forge/ui';
import { api, errorMessage } from '../../lib/api';

type DocsSession = { protocol: 'docs'; apiUrl: string; config: Record<string, unknown> & { document: { title: string } }; canWrite: boolean; readOnlyReason: 'checked_out' | 'permission' | 'format' | null };
type WopiSession = { protocol: 'wopi'; actionUrl: string; accessToken: string; accessTokenTtl: number; canWrite: boolean };
type Session = DocsSession | WopiSession;

interface DocEditor {
  destroyEditor: () => void;
}
declare global {
  interface Window {
    DocsAPI?: { DocEditor: new (placeholderId: string, config: Record<string, unknown>) => DocEditor };
  }
}

const READ_ONLY: Record<NonNullable<DocsSession['readOnlyReason']>, string> = {
  checked_out: 'Someone has this file checked out, so it opens read-only.',
  permission: 'You can view this file but not edit it.',
  format: 'This format opens read-only. Save a copy as Word, Excel or PowerPoint to edit it.',
};

/** The editor's loader (api.js), once per page and per document server. */
const loaded = new Map<string, Promise<void>>();
function loadScript(src: string) {
  let p = loaded.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => (window.DocsAPI ? resolve() : reject(new Error('The Office editor did not load')));
      s.onerror = () => {
        loaded.delete(src);
        s.remove();
        reject(new Error(`Couldn’t reach the Office editor at ${new URL(src).origin}`));
      };
      document.head.appendChild(s);
    });
    loaded.set(src, p);
  }
  return p;
}

/**
 * Edit an Office document in the browser. With Euro-Office (the default) the
 * editor is created from its api.js with a config signed by ForgeDrive; people
 * who open the same version edit it together, and it is saved as a new version
 * shortly after the last of them closes it. Collabora Online (WOPI) is posted
 * into an iframe instead.
 */
export function OfficePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const form = useRef<HTMLFormElement>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Session>(`/api/v1/drive/items/${id}/office`)
      .then(setSession)
      .catch((e) => setError(errorMessage(e)));
  }, [id]);

  useEffect(() => {
    if (!session) return;
    if (session.protocol === 'wopi') {
      form.current?.submit();
      return;
    }
    let editor: DocEditor | null = null;
    let cancelled = false;
    loadScript(session.apiUrl)
      .then(() => {
        if (cancelled) return;
        editor = new window.DocsAPI!.DocEditor('office-editor', {
          ...session.config,
          width: '100%',
          height: '100%',
          type: window.matchMedia('(max-width: 640px)').matches ? 'mobile' : 'desktop',
          events: {
            onError: (e: { data?: { errorDescription?: string } }) => setError(e.data?.errorDescription ?? 'The Office editor reported an error'),
          },
        });
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
      editor?.destroyEditor();
    };
  }, [session]);

  const back = () => {
    // The save arrives a few seconds after closing; refresh the listing then.
    setTimeout(() => void qc.invalidateQueries({ queryKey: ['drive'] }), 15_000);
    if (window.history.length > 1) navigate(-1);
    else navigate('/drive');
  };

  return (
    <div className="flex h-dvh flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-2 py-1 dark:border-zinc-800">
        <Button size="sm" variant="ghost" icon={<ArrowLeft className="size-4" />} onClick={back}>
          Back to Drive
        </Button>
        {session?.protocol === 'docs' && <span className="min-w-0 truncate text-sm font-medium">{session.config.document.title}</span>}
        {session && !session.canWrite && (
          <Badge className="ml-auto shrink-0">
            <Eye className="mr-1 inline size-3.5" />
            Read-only
          </Badge>
        )}
      </div>
      {session?.protocol === 'docs' && session.readOnlyReason && (
        <p className="border-b border-zinc-200 bg-zinc-50 px-3 py-1.5 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">{READ_ONLY[session.readOnlyReason]}</p>
      )}
      {error ? (
        <div className="p-6">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : !session ? (
        <PageSpinner />
      ) : session.protocol === 'docs' ? (
        <div className="min-h-0 flex-1">
          <div id="office-editor" />
        </div>
      ) : (
        <>
          <form ref={form} action={session.actionUrl} method="post" target="office-frame" className="hidden">
            <input name="access_token" value={session.accessToken} readOnly />
            <input name="access_token_ttl" value={String(session.accessTokenTtl)} readOnly />
          </form>
          <iframe name="office-frame" title="Office editor" className="min-h-0 w-full flex-1" allow="clipboard-read; clipboard-write; fullscreen" />
        </>
      )}
    </div>
  );
}
