import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox, Plus, Trash2, Users } from 'lucide-react';
import { Alert, Avatar, Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, PageSpinner, ProgressBar, Select, Table, Td, Th, formatBytes, useToast } from '@forge/ui';
import { ConfirmDialog, UserPicker } from '../../components/admin';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/hooks';
import type { Domain, Group } from '../../lib/types';

interface SharedMailbox {
  id: string;
  displayName: string;
  email: string;
  usedBytes: number;
  quotaBytes: number | null;
  grantCount?: number;
}

interface Grant {
  principalType: 'user' | 'group';
  principalId: string;
  name: string;
  email: string | null;
  access: 'none' | 'read' | 'full';
  sendAs: boolean;
  sendOnBehalf: boolean;
}

export function SharedMailboxesPage() {
  const canManage = useCan('users:manage');
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['admin', 'shared-mailboxes'], queryFn: () => api<{ items: SharedMailbox[] }>('/api/v1/admin/shared-mailboxes') });
  return (
    <div>
      <PageHeader
        title="Shared mailboxes"
        description="Team addresses like sales@ or support@. Nobody signs in to them; you grant people or groups access, and they appear in those people’s mail."
        actions={
          canManage && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New shared mailbox
            </Button>
          )
        }
      />
      <Card>
        {list.isLoading ? (
          <PageSpinner />
        ) : !list.data?.items.length ? (
          <EmptyState icon={<Inbox />} title="No shared mailboxes yet" description="Create one for a team address, then choose who can read and send from it." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Mailbox</Th>
                <Th>Members</Th>
                <Th className="hidden sm:table-cell">Storage</Th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((m) => (
                <tr key={m.id} className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50" onClick={() => setOpen(m.id)}>
                  <Td>
                    <p className="font-medium text-zinc-900 dark:text-zinc-100">{m.displayName}</p>
                    <p className="font-mono text-xs text-zinc-500">{m.email}</p>
                  </Td>
                  <Td>
                    <Badge>
                      <Users className="size-3" /> {m.grantCount ?? 0}
                    </Badge>
                  </Td>
                  <Td className="hidden text-zinc-500 sm:table-cell">{formatBytes(m.usedBytes)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {creating && <CreateDialog onClose={() => setCreating(false)} onCreated={(id) => (setCreating(false), setOpen(id))} />}
      {open && <DetailDialog id={open} canManage={canManage} onClose={() => setOpen(null)} />}
    </div>
  );
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const domains = useQuery({ queryKey: ['admin', 'domains'], queryFn: () => api<{ items: Domain[] }>('/api/v1/admin/domains') });
  const [f, setF] = useState({ displayName: '', username: '', domainId: '' });
  const [error, setError] = useState<string | null>(null);
  const primary = domains.data?.items.find((d) => d.isPrimary);
  const create = useMutation({
    mutationFn: () => api<{ mailbox: SharedMailbox }>('/api/v1/admin/shared-mailboxes', { body: { displayName: f.displayName, username: f.username, domainId: f.domainId || undefined, grants: [] } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'shared-mailboxes'] });
      onCreated(r.mailbox.id);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="New shared mailbox"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} disabled={!f.displayName || !f.username} onClick={() => create.mutate()}>
            Create and add members
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      <div className="space-y-4">
        <Field label="Name" htmlFor="sm-name" hint="Shown as the sender name, e.g. “Acme Support”.">
          <Input
            id="sm-name"
            autoFocus
            value={f.displayName}
            onChange={(e) => {
              const displayName = e.target.value;
              setF((x) => ({ ...x, displayName, username: x.username && x.username !== slug(x.displayName) ? x.username : slug(displayName) }));
            }}
          />
        </Field>
        <Field label="Address" htmlFor="sm-user">
          <div className="flex items-center gap-2">
            <Input id="sm-user" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} placeholder="support" />
            <Select value={f.domainId || primary?.id || ''} onChange={(e) => setF({ ...f, domainId: e.target.value })} className="w-auto" aria-label="Domain">
              {domains.data?.items.map((d) => (
                <option key={d.id} value={d.id}>
                  @{d.name}
                </option>
              ))}
            </Select>
          </div>
        </Field>
      </div>
    </Dialog>
  );
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

function DetailDialog({ id, canManage, onClose }: { id: string; canManage: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const detail = useQuery({
    queryKey: ['admin', 'shared-mailbox', id],
    queryFn: () => api<{ mailbox: SharedMailbox & { messageCount: number; effectiveQuotaBytes: number | null }; grants: Grant[] }>(`/api/v1/admin/shared-mailboxes/${id}`),
  });
  const groups = useQuery({ queryKey: ['admin', 'groups', 'security'], queryFn: () => api<{ items: Group[] }>('/api/v1/admin/groups?type=security'), enabled: canManage });
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    if (detail.data) setGrants(detail.data.grants);
  }, [detail.data]);
  const dirty = JSON.stringify(grants) !== JSON.stringify(detail.data?.grants);

  const save = useMutation({
    mutationFn: () => api(`/api/v1/admin/shared-mailboxes/${id}/permissions`, { method: 'PUT', body: { grants: grants!.map(({ principalType, principalId, access, sendAs, sendOnBehalf }) => ({ principalType, principalId, access, sendAs, sendOnBehalf })) } }),
    onSuccess: () => {
      toast.success('Permissions saved');
      void qc.invalidateQueries({ queryKey: ['admin', 'shared-mailbox', id] });
      void qc.invalidateQueries({ queryKey: ['admin', 'shared-mailboxes'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/v1/admin/shared-mailboxes/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'shared-mailboxes'] });
      onClose();
    },
  });

  const update = (i: number, change: Partial<Grant>) => setGrants((g) => g!.map((x, j) => (j === i ? { ...x, ...change } : x)));
  const add = (g: Omit<Grant, 'access' | 'sendAs' | 'sendOnBehalf'>) => {
    if (grants?.some((x) => x.principalType === g.principalType && x.principalId === g.principalId)) return;
    setGrants((x) => [...(x ?? []), { ...g, access: 'full', sendAs: true, sendOnBehalf: false }]);
  };

  const m = detail.data?.mailbox;
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={m ? m.displayName : 'Shared mailbox'}
      description={m?.email}
      footer={
        canManage && (
          <>
            <Button variant="ghost" className="mr-auto" icon={<Trash2 className="size-4" />} onClick={() => setDeleting(true)}>
              Delete
            </Button>
            <Button onClick={onClose}>Close</Button>
            <Button variant="primary" loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>
              Save permissions
            </Button>
          </>
        )
      }
    >
      {!m || !grants ? (
        <PageSpinner />
      ) : (
        <div className="space-y-5">
          <div className="space-y-1">
            <ProgressBar value={m.effectiveQuotaBytes ? (m.usedBytes / m.effectiveQuotaBytes) * 100 : 0} />
            <p className="text-xs text-zinc-500">
              {m.messageCount} messages · {formatBytes(m.usedBytes)} of {m.effectiveQuotaBytes ? formatBytes(m.effectiveQuotaBytes) : 'unlimited'}
            </p>
          </div>
          <div>
            <p className="mb-1 text-sm font-medium">Who has access</p>
            <p className="mb-2 text-xs text-zinc-500">Access applies to the mailbox’s mail, calendar and contacts alike.</p>
            {grants.length === 0 ? (
              <p className="text-sm text-zinc-500">Nobody yet. Add people or groups below.</p>
            ) : (
              <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                {grants.map((g, i) => (
                  <li key={`${g.principalType}-${g.principalId}`} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                    {g.principalType === 'user' ? (
                      <Avatar name={g.name} size="sm" />
                    ) : (
                      <span className="flex size-7 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800">
                        <Users className="size-3.5" />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{g.name}</p>
                      <p className="truncate text-xs text-zinc-500">{g.principalType === 'group' ? 'Group' : g.email}</p>
                    </div>
                    <Select aria-label={`Access for ${g.name}`} disabled={!canManage} value={g.access} onChange={(e) => update(i, { access: e.target.value as Grant['access'] })} className="h-8 w-36 py-0">
                      <option value="full">Full access</option>
                      <option value="read">Read only</option>
                      <option value="none">Send only</option>
                    </Select>
                    <label className="flex items-center gap-1.5 text-xs">
                      <input type="checkbox" className="accent-[var(--brand)]" disabled={!canManage} checked={g.sendAs} onChange={(e) => update(i, { sendAs: e.target.checked, sendOnBehalf: e.target.checked ? false : g.sendOnBehalf })} />
                      Send as
                    </label>
                    <label className="flex items-center gap-1.5 text-xs">
                      <input type="checkbox" className="accent-[var(--brand)]" disabled={!canManage} checked={g.sendOnBehalf} onChange={(e) => update(i, { sendOnBehalf: e.target.checked, sendAs: e.target.checked ? false : g.sendAs })} />
                      On behalf
                    </label>
                    {canManage && (
                      <Button size="sm" variant="ghost" aria-label={`Remove ${g.name}`} onClick={() => setGrants((x) => x!.filter((_, j) => j !== i))}>
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <dl className="mt-2 grid gap-x-4 gap-y-0.5 text-xs text-zinc-500 sm:grid-cols-[auto_1fr]">
              <dt className="font-medium">Full access</dt>
              <dd>Read, reply from, file, flag and delete messages; manage folders; edit the calendar and contacts.</dd>
              <dt className="font-medium">Read only</dt>
              <dd>See messages, calendar and contacts without changing anything.</dd>
              <dt className="font-medium">Send as</dt>
              <dd>Mail appears to come straight from {m.email}.</dd>
              <dt className="font-medium">On behalf</dt>
              <dd>Recipients see “person on behalf of {m.displayName}”.</dd>
            </dl>
          </div>
          {canManage && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Add a person">
                <UserPicker exclude={grants.filter((g) => g.principalType === 'user').map((g) => g.principalId)} onPick={(u) => add({ principalType: 'user', principalId: u.id, name: u.displayName, email: u.email })} />
              </Field>
              <Field label="Add a security group" hint="Members get access automatically as the group changes.">
                <Select
                  value=""
                  onChange={(e) => {
                    const g = groups.data?.items.find((x) => x.id === e.target.value);
                    if (g) add({ principalType: 'group', principalId: g.id, name: g.name, email: g.email });
                  }}
                >
                  <option value="">Choose a group…</option>
                  {groups.data?.items.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
        </div>
      )}
      <ConfirmDialog open={deleting} onClose={() => setDeleting(false)} onConfirm={() => remove.mutate()} title={`Delete ${m?.displayName}?`} danger confirmLabel="Delete" busy={remove.isPending}>
        Members lose access immediately. The mailbox and its messages are permanently removed after 30 days; mail to {m?.email} is rejected from now on.
      </ConfirmDialog>
    </Dialog>
  );
}
