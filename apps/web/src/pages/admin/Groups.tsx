import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, Plus, Shield, UsersRound } from 'lucide-react';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, PageSpinner, Select, Switch, Table, Td, Textarea, Th } from '@forge/ui';
import { api, errorMessage } from '../../lib/api';
import { useCan, useDebounced } from '../../lib/hooks';
import type { Domain, Group, GroupType } from '../../lib/types';

export function GroupsPage() {
  const canManage = useCan('groups:manage');
  const [q, setQ] = useState('');
  const [type, setType] = useState<'' | GroupType>('');
  const [creating, setCreating] = useState(false);
  const term = useDebounced(q, 250);
  const list = useQuery({
    queryKey: ['admin', 'groups', term, type],
    queryFn: () => api<{ items: Group[] }>(`/api/v1/admin/groups?q=${encodeURIComponent(term)}${type ? `&type=${type}` : ''}`),
  });
  return (
    <div>
      <PageHeader
        title="Groups"
        description="Security groups grant access to resources; distribution lists deliver mail to many people. Both are shared by Mail, Drive and Team."
        actions={
          canManage && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New group
            </Button>
          )
        }
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-zinc-200 p-4 sm:flex-row dark:border-zinc-800">
          <Input placeholder="Search groups" value={q} onChange={(e) => setQ(e.target.value)} className="sm:max-w-sm" />
          <Select value={type} onChange={(e) => setType(e.target.value as '' | GroupType)} className="sm:w-48" aria-label="Type">
            <option value="">All types</option>
            <option value="security">Security groups</option>
            <option value="distribution">Distribution lists</option>
          </Select>
        </div>
        {list.isLoading ? (
          <PageSpinner />
        ) : !list.data?.items.length ? (
          <EmptyState icon={<UsersRound />} title="No groups yet" description="Create a security group or distribution list to get started." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Type</Th>
                <Th className="hidden md:table-cell">Address</Th>
                <Th className="text-right">Members</Th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((g) => (
                <tr key={g.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                  <Td>
                    <Link to={`/admin/directory/groups/${g.id}`} className="font-medium text-zinc-900 hover:text-brand dark:text-zinc-100">
                      {g.name}
                    </Link>
                    {g.description && <p className="max-w-md truncate text-xs text-zinc-500">{g.description}</p>}
                  </Td>
                  <Td>
                    <GroupTypeBadge type={g.type} />
                  </Td>
                  <Td className="hidden font-mono text-xs md:table-cell">{g.email ?? '—'}</Td>
                  <Td className="text-right tabular-nums">{g.memberCount}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <CreateGroupDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

export function GroupTypeBadge({ type }: { type: GroupType }) {
  return type === 'security' ? (
    <Badge>
      <Shield className="size-3" /> Security
    </Badge>
  ) : (
    <Badge tone="info">
      <Mail className="size-3" /> Distribution
    </Badge>
  );
}

function CreateGroupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const domains = useQuery({ queryKey: ['admin', 'domains'], queryFn: () => api<{ items: Domain[] }>('/api/v1/admin/domains'), enabled: open });
  const [f, setF] = useState({ name: '', description: '', type: 'security' as GroupType, mailEnabled: false, local: '', domain: '', allowExternalSenders: false });
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const domain = f.domain || domains.data?.items.find((d) => d.isPrimary)?.name || '';
  const needsEmail = f.type === 'distribution' || f.mailEnabled;
  const create = useMutation({
    mutationFn: () =>
      api<{ group: Group }>('/api/v1/admin/groups', {
        body: {
          name: f.name,
          description: f.description,
          type: f.type,
          email: needsEmail && f.local ? `${f.local}@${domain}` : null,
          allowExternalSenders: f.allowExternalSenders,
        },
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'groups'] });
      onClose();
      navigate(`/admin/directory/groups/${r.group.id}`);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New group"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} disabled={!f.name || (f.type === 'distribution' && !f.local)} onClick={() => create.mutate()}>
            Create
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
        <fieldset className="grid grid-cols-2 gap-2">
          <legend className="sr-only">Group type</legend>
          {(['security', 'distribution'] as const).map((t) => (
            <label key={t} className={`cursor-pointer rounded-lg p-3 text-sm ring-1 ${f.type === t ? 'bg-brand/5 ring-2 ring-brand' : 'ring-zinc-200 dark:ring-zinc-700'}`}>
              <input type="radio" name="type" className="sr-only" checked={f.type === t} onChange={() => set('type', t)} />
              <span className="font-medium">{t === 'security' ? 'Security group' : 'Distribution list'}</span>
              <span className="mt-0.5 block text-xs text-zinc-500">{t === 'security' ? 'Grant access to files, sites and teams' : 'An email address that delivers to every member'}</span>
            </label>
          ))}
        </fieldset>
        <Field label="Name" htmlFor="g-name">
          <Input id="g-name" value={f.name} onChange={(e) => set('name', e.target.value)} autoFocus />
        </Field>
        <Field label="Description" htmlFor="g-desc">
          <Textarea id="g-desc" value={f.description} onChange={(e) => set('description', e.target.value)} />
        </Field>
        {f.type === 'security' && <Switch checked={f.mailEnabled} onChange={(v) => set('mailEnabled', v)} label="Mail-enabled" description="Give the group an email address too." />}
        {needsEmail && (
          <Field label="Email address" htmlFor="g-local">
            <div className="flex items-center gap-2">
              <Input id="g-local" value={f.local} onChange={(e) => set('local', e.target.value.toLowerCase())} placeholder="team" />
              <Select value={domain} onChange={(e) => set('domain', e.target.value)} className="w-auto" aria-label="Domain">
                {domains.data?.items.map((d) => (
                  <option key={d.id} value={d.name}>
                    @{d.name}
                  </option>
                ))}
              </Select>
            </div>
          </Field>
        )}
        {f.type === 'distribution' && (
          <Switch checked={f.allowExternalSenders} onChange={(v) => set('allowExternalSenders', v)} label="Allow external senders" description="People outside the organisation can email this list." />
        )}
      </div>
    </Dialog>
  );
}
