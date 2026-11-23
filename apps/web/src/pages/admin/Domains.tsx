import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Globe, Plus, Star, Trash2 } from 'lucide-react';
import { Alert, Badge, Button, Card, CardBody, EmptyState, Input, PageHeader, PageSpinner, useToast } from '@forge/ui';
import { ConfirmDialog } from '../../components/admin';
import { MailDns } from '../../components/MailDns';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/hooks';
import type { Domain } from '../../lib/types';

export function DomainsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const canManage = useCan('domains:manage');
  const [name, setName] = useState('');
  const [removing, setRemoving] = useState<Domain | null>(null);
  const [mailOpen, setMailOpen] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['admin', 'domains'], queryFn: () => api<{ items: Domain[] }>('/api/v1/admin/domains') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'domains'] });

  const add = useMutation({
    mutationFn: () => api('/api/v1/admin/domains', { body: { name } }),
    onSuccess: () => {
      setName('');
      void refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const verify = useMutation({
    mutationFn: (d: Domain) => api<{ verified: boolean; found: string[]; lookupError: string | null }>(`/api/v1/admin/domains/${d.id}/verify`, { body: {} }),
    onSuccess: (r, d) => {
      if (r.verified) toast.success(`${d.name} verified`);
      else toast.error(r.lookupError ? `DNS lookup failed (${r.lookupError}). DNS changes can take a while to appear.` : 'The verification record was not found yet.');
      void refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const primary = useMutation({
    mutationFn: (d: Domain) => api(`/api/v1/admin/domains/${d.id}/primary`, { body: {} }),
    onSuccess: () => void refresh(),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (d: Domain) => api(`/api/v1/admin/domains/${d.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setRemoving(null);
      void refresh();
    },
    onError: (e) => {
      setRemoving(null);
      toast.error(errorMessage(e));
    },
  });

  return (
    <div>
      <PageHeader title="Domains" description="Email domains your organisation uses. Verify ownership with a DNS TXT record." />
      {canManage && (
        <form
          className="mb-6 flex max-w-lg gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <Input placeholder="example.org" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} aria-label="Domain name" />
          <Button type="submit" variant="primary" icon={<Plus className="size-4" />} loading={add.isPending} disabled={!name}>
            Add
          </Button>
        </form>
      )}
      {list.isLoading ? (
        <PageSpinner />
      ) : !list.data?.items.length ? (
        <EmptyState icon={<Globe />} title="No domains" />
      ) : (
        <div className="space-y-4">
          {list.data.items.map((d) => (
            <Card key={d.id}>
              <CardBody className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-semibold">{d.name}</h2>
                  {d.isPrimary && (
                    <Badge tone="brand">
                      <Star className="size-3" /> Primary
                    </Badge>
                  )}
                  <Badge tone={d.verified ? 'success' : 'warning'}>{d.verified ? 'Verified' : 'Unverified'}</Badge>
                  <span className="text-sm text-zinc-500">· {d.userCount ?? 0} users</span>
                  {canManage && (
                    <div className="ml-auto flex gap-2">
                      {!d.verified && (
                        <Button size="sm" variant="primary" icon={<Check className="size-4" />} loading={verify.isPending && verify.variables?.id === d.id} onClick={() => verify.mutate(d)}>
                          Verify
                        </Button>
                      )}
                      {!d.isPrimary && (
                        <Button size="sm" onClick={() => primary.mutate(d)}>
                          Make primary
                        </Button>
                      )}
                      {!d.isPrimary && (
                        <Button size="sm" variant="ghost" aria-label={`Remove ${d.name}`} onClick={() => setRemoving(d)}>
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                <button type="button" className="text-sm font-medium text-brand hover:underline" onClick={() => setMailOpen(mailOpen === d.id ? null : d.id)}>
                  {mailOpen === d.id ? 'Hide mail setup' : 'Mail setup (MX, SPF, DKIM, DMARC)'}
                </button>
                {mailOpen === d.id && <MailDns domainId={d.id} canManage={canManage} />}
                {!d.verified && (
                  <Alert tone="info" title="Add this TXT record at your DNS provider">
                    <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                      <dt className="font-medium">Type</dt>
                      <dd className="font-mono">TXT</dd>
                      <dt className="font-medium">Host</dt>
                      <dd className="font-mono">{d.verificationRecord.host}</dd>
                      <dt className="font-medium">Value</dt>
                      <dd className="flex items-center gap-2 font-mono break-all">
                        {d.verificationRecord.value}
                        <button type="button" aria-label="Copy value" onClick={() => void navigator.clipboard?.writeText(d.verificationRecord.value)}>
                          <Copy className="size-3.5" />
                        </button>
                      </dd>
                    </dl>
                  </Alert>
                )}
              </CardBody>
            </Card>
          ))}
        </div>
      )}
      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => removing && remove.mutate(removing)} title={`Remove ${removing?.name}?`} danger confirmLabel="Remove" busy={remove.isPending}>
        Only domains with no users or group addresses can be removed.
      </ConfirmDialog>
    </div>
  );
}
