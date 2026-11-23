import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox, ShieldCheck, Trash2 } from 'lucide-react';
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader, PageSpinner, Select, Table, Td, Th, formatBytes, formatRelative, useToast, type Tone } from '@forge/ui';
import { ConfirmDialog } from '../../components/admin';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/hooks';

interface Quarantined {
  id: string;
  envelopeFrom: string;
  recipients: string[];
  fromHeader: string;
  subject: string;
  reason: string;
  spamScore: number | null;
  size: number;
  remoteIp: string | null;
  createdAt: string;
}

interface Outbound {
  id: string;
  sender: string;
  subject: string;
  status: string;
  recipients: { address: string; status: string; response?: string; attempts: number }[];
  lastError: string | null;
  sendAt: string;
  createdAt: string;
}

const STATUS_TONE: Record<string, Tone> = { sent: 'success', queued: 'info', sending: 'info', scheduled: 'neutral', partial: 'warning', failed: 'danger', cancelled: 'neutral' };

export function MailAdminPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const canManage = useCan('system:manage');
  const [status, setStatus] = useState('');
  const [discard, setDiscard] = useState<Quarantined | null>(null);
  const quarantine = useQuery({ queryKey: ['admin', 'quarantine'], queryFn: () => api<{ items: Quarantined[] }>('/api/v1/admin/mail/quarantine') });
  const outbound = useQuery({ queryKey: ['admin', 'outbound', status], queryFn: () => api<{ items: Outbound[] }>(`/api/v1/admin/mail/outbound${status ? `?status=${status}` : ''}`), refetchInterval: 10_000 });
  const release = useMutation({
    mutationFn: (id: string) => api(`/api/v1/admin/mail/quarantine/${id}/release`, { body: {} }),
    onSuccess: () => {
      toast.success('Released to recipients');
      void qc.invalidateQueries({ queryKey: ['admin', 'quarantine'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/admin/mail/quarantine/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDiscard(null);
      void qc.invalidateQueries({ queryKey: ['admin', 'quarantine'] });
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Mail flow" description="Quarantined inbound mail and the outgoing delivery queue." />
      <Card>
        <CardHeader title="Quarantine" description="Messages that failed DMARC with a reject policy are held here instead of being delivered." />
        {quarantine.isLoading ? (
          <PageSpinner />
        ) : !quarantine.data?.items.length ? (
          <EmptyState icon={<ShieldCheck />} title="Nothing in quarantine" />
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {quarantine.data.items.map((q) => (
              <li key={q.id} className="flex flex-wrap items-start gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{q.subject || '(no subject)'}</p>
                  <p className="truncate text-sm text-zinc-500">
                    {q.fromHeader || q.envelopeFrom} → {q.recipients.join(', ')}
                  </p>
                  <p className="mt-1 text-xs text-zinc-500">
                    {q.reason} · {formatBytes(q.size)} · {q.remoteIp ?? 'unknown IP'} · {formatRelative(q.createdAt)}
                  </p>
                </div>
                {canManage && (
                  <div className="flex gap-2">
                    <Button size="sm" loading={release.isPending && release.variables === q.id} onClick={() => release.mutate(q.id)}>
                      Release
                    </Button>
                    <Button size="sm" variant="ghost" aria-label="Discard" onClick={() => setDiscard(q)}>
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader
          title="Outgoing queue"
          description="Recent outbound messages and their per-recipient delivery state."
          actions={
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="h-8 w-40 py-0" aria-label="Status">
              <option value="">All</option>
              {['queued', 'scheduled', 'sending', 'sent', 'partial', 'failed', 'cancelled'].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </Select>
          }
        />
        {!outbound.data?.items.length ? (
          <EmptyState icon={<Inbox />} title="No outgoing mail" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Message</Th>
                <Th>Recipients</Th>
                <Th>Status</Th>
                <Th className="hidden md:table-cell">When</Th>
              </tr>
            </thead>
            <tbody>
              {outbound.data.items.map((o) => (
                <tr key={o.id}>
                  <Td>
                    <p className="max-w-64 truncate font-medium">{o.subject || '(no subject)'}</p>
                    <p className="text-xs text-zinc-500">{o.sender}</p>
                  </Td>
                  <Td>
                    <ul className="space-y-0.5 text-xs">
                      {o.recipients.map((r) => (
                        <li key={r.address} title={r.response}>
                          <Badge tone={r.status === 'delivered' ? 'success' : r.status === 'failed' ? 'danger' : r.status === 'deferred' ? 'warning' : 'neutral'}>{r.status}</Badge> {r.address}
                          {r.attempts > 1 && <span className="text-zinc-500"> · {r.attempts} tries</span>}
                        </li>
                      ))}
                    </ul>
                    {o.lastError && <p className="mt-1 max-w-72 truncate text-xs text-red-600" title={o.lastError}>{o.lastError}</p>}
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONE[o.status] ?? 'neutral'}>{o.status}</Badge>
                  </Td>
                  <Td className="hidden text-zinc-500 md:table-cell">{formatRelative(o.status === 'scheduled' ? o.sendAt : o.createdAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <ConfirmDialog open={!!discard} onClose={() => setDiscard(null)} onConfirm={() => discard && remove.mutate(discard.id)} title="Discard message?" danger confirmLabel="Discard" busy={remove.isPending}>
        The message will be permanently deleted without being delivered.
      </ConfirmDialog>
    </div>
  );
}
