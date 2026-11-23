import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, ShieldCheck, Trash2 } from 'lucide-react';
import { Alert, Button, EmptyState, Input, PageSpinner, cn, formatDateTime, useToast } from '@forge/ui';
import { api, errorMessage } from '../lib/api';

export interface SenderEntry {
  id: string;
  list: 'block' | 'allow';
  entry: string;
  note: string;
  createdAt: string;
  createdBy: string | null;
}

const COPY = {
  mailbox: {
    block: 'Mail from these senders goes straight to Junk.',
    allow: 'Mail from these senders is never sent to Junk, unless it fails sender authentication (a sign of forgery).',
  },
  organisation: {
    block: 'Mail from these senders is refused for everyone in the organisation. The sender gets a bounce.',
    allow: 'Mail from these senders skips spam filtering for everyone, unless it fails sender authentication. Transport rules still apply.',
  },
};

/** Block and allow lists of addresses or domains, for a mailbox or the organisation. */
export function SenderLists({ base, scope, canEdit = true, headers }: { base: string; scope: 'mailbox' | 'organisation'; canEdit?: boolean; headers?: Record<string, string> }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<'block' | 'allow'>('block');
  const [input, setInput] = useState('');
  const [note, setNote] = useState('');
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const key = ['sender-lists', base, headers?.['x-forge-mailbox'] ?? 'me'];
  const entries = useQuery({ queryKey: key, queryFn: () => api<{ items: SenderEntry[] }>(base, { headers }) });

  const add = useMutation({
    mutationFn: () => api<{ items: SenderEntry[] }>(base, { headers, body: { list: tab, entries: input.split(/[\s,;]+/).filter(Boolean), note: note.trim() || undefined } }),
    onSuccess: (r) => {
      setInput('');
      setNote('');
      setError(null);
      toast.success(`${r.items.length} ${r.items.length === 1 ? 'entry' : 'entries'} ${tab === 'block' ? 'blocked' : 'allowed'}`);
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (ids: string[]) => api(`${base}/remove`, { headers, body: { ids } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: (e) => toast.error(errorMessage(e)),
  });

  const all = entries.data?.items ?? [];
  const shown = all.filter((e) => e.list === tab && (!filter || `${e.entry} ${e.note}`.toLowerCase().includes(filter.toLowerCase())));
  const counts = { block: all.filter((e) => e.list === 'block').length, allow: all.filter((e) => e.list === 'allow').length };

  return (
    <div className="space-y-4">
      <div role="tablist" className="inline-flex rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800">
        {(['block', 'allow'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            type="button"
            aria-selected={tab === t}
            onClick={() => {
              setTab(t);
              setError(null);
            }}
            className={cn('inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium', tab === t ? 'bg-white shadow-sm dark:bg-zinc-900' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200')}
          >
            {t === 'block' ? <Ban className="size-3.5" /> : <ShieldCheck className="size-3.5" />}
            {t === 'block' ? 'Blocked' : 'Allowed'} <span className="text-xs text-zinc-500">{counts[t]}</span>
          </button>
        ))}
      </div>
      <p className="text-sm text-zinc-500">{COPY[scope][tab]}</p>

      {canEdit && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (input.trim()) add.mutate();
          }}
        >
          <div className="flex flex-wrap gap-2">
            <Input aria-label="Addresses or domains" className="min-w-56 flex-[2]" placeholder="name@example.com, example.com" value={input} onChange={(e) => setInput(e.target.value)} />
            <Input aria-label="Note" className="min-w-40 flex-1" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            <Button type="submit" variant={tab === 'block' ? 'danger' : 'primary'} loading={add.isPending} disabled={!input.trim()}>
              {tab === 'block' ? 'Block' : 'Allow'}
            </Button>
          </div>
          <p className="text-xs text-zinc-500">Enter addresses or domains, separated by commas or spaces. A domain includes its subdomains. An address overrides its domain, so you can block a domain but allow one person at it.</p>
          {error && <Alert tone="danger">{error}</Alert>}
        </form>
      )}

      {entries.isLoading ? (
        <PageSpinner />
      ) : !counts[tab] ? (
        <EmptyState icon={tab === 'block' ? <Ban /> : <ShieldCheck />} title={tab === 'block' ? 'No blocked senders' : 'No allowed senders'} />
      ) : (
        <>
          {counts[tab] > 10 && <Input aria-label="Filter" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />}
          <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {shown.map((e) => (
              <li key={e.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-sm">{e.entry.includes('@') ? e.entry : `*@${e.entry}`}</p>
                  <p className="truncate text-xs text-zinc-500">
                    {[e.note, e.createdBy && scope === 'organisation' ? `added by ${e.createdBy}` : null, formatDateTime(e.createdAt)].filter(Boolean).join(' · ')}
                  </p>
                </div>
                {canEdit && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => api(base, { headers, body: { list: tab === 'block' ? 'allow' : 'block', entries: [e.entry] } }).then(() => qc.invalidateQueries({ queryKey: key }), (err) => toast.error(errorMessage(err)))}>
                      {tab === 'block' ? 'Allow instead' : 'Block instead'}
                    </Button>
                    <Button size="sm" variant="ghost" aria-label={`Remove ${e.entry}`} onClick={() => remove.mutate([e.id])}>
                      <Trash2 className="size-4" />
                    </Button>
                  </>
                )}
              </li>
            ))}
            {!shown.length && <li className="px-3 py-4 text-center text-sm text-zinc-500">No matches</li>}
          </ul>
        </>
      )}
    </div>
  );
}
