import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Copy, XCircle } from 'lucide-react';
import { Field, Select, Spinner, useToast } from '@forge/ui';
import { api, errorMessage } from '../lib/api';
import type { User } from '../lib/types';

interface MailDnsResponse {
  domain: string;
  hostname: string;
  records: { purpose: string; type: string; host: string; value: string; ok: boolean; found: string[] }[];
  catchAll: { id: string; email: string } | null;
}

/** Expected MX/SPF/DKIM/DMARC records for a domain, checked live against DNS. */
export function MailDns({ domainId, canManage }: { domainId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const dns = useQuery({ queryKey: ['admin', 'mail-dns', domainId], queryFn: () => api<MailDnsResponse>(`/api/v1/admin/domains/${domainId}/mail-dns`) });
  const users = useQuery({ queryKey: ['admin', 'users', 'all-active'], queryFn: () => api<{ items: User[] }>('/api/v1/admin/users?limit=200'), enabled: canManage });
  const catchAll = useMutation({
    mutationFn: (catchAllUserId: string | null) => api(`/api/v1/admin/domains/${domainId}/mail`, { method: 'PATCH', body: { catchAllUserId } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'mail-dns', domainId] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (dns.isLoading) return <Spinner />;
  if (!dns.data) return null;
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">Mail DNS records</p>
      <ul className="space-y-2">
        {dns.data.records.map((r) => (
          <li key={r.purpose} className="rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800">
            <p className="mb-1 flex items-center gap-2 text-sm font-medium">
              {r.ok ? <CheckCircle2 className="size-4 text-emerald-600" /> : <XCircle className="size-4 text-amber-500" />}
              {r.purpose}
            </p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              <dt className="text-zinc-500">Type</dt>
              <dd className="font-mono">{r.type}</dd>
              <dt className="text-zinc-500">Host</dt>
              <dd className="font-mono break-all">{r.host}</dd>
              <dt className="text-zinc-500">Value</dt>
              <dd className="flex items-start gap-2 font-mono break-all">
                {r.value}
                <button type="button" aria-label="Copy value" className="shrink-0" onClick={() => void navigator.clipboard?.writeText(r.value)}>
                  <Copy className="size-3.5" />
                </button>
              </dd>
              {!r.ok && r.found.length > 0 && (
                <>
                  <dt className="text-zinc-500">Found</dt>
                  <dd className="font-mono break-all text-amber-700 dark:text-amber-400">{r.found.join(' | ')}</dd>
                </>
              )}
            </dl>
          </li>
        ))}
      </ul>
      {canManage && (
        <Field label="Catch-all mailbox" hint="Mail to unknown addresses at this domain is delivered here instead of bounced.">
          <Select value={dns.data.catchAll?.id ?? ''} onChange={(e) => catchAll.mutate(e.target.value || null)} className="max-w-sm">
            <option value="">None (reject unknown addresses)</option>
            {users.data?.items.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName} ({u.email})
              </option>
            ))}
          </Select>
        </Field>
      )}
    </div>
  );
}
