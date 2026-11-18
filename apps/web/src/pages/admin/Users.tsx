import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, UserPlus, Users as UsersIcon } from 'lucide-react';
import { Alert, Avatar, Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, PageSpinner, Select, Switch, Table, Td, Th, formatRelative } from '@forge/ui';
import { TemporaryPasswordDialog, UserStatusBadge } from '../../components/admin';
import { api, errorMessage } from '../../lib/api';
import { useCan, useDebounced } from '../../lib/hooks';
import type { Domain, Role, User } from '../../lib/types';

const PAGE = 50;

export function UsersPage() {
  const canManage = useCan('users:manage');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('active');
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const term = useDebounced(q, 250);
  const list = useQuery({
    queryKey: ['admin', 'users', term, status, offset],
    queryFn: () => api<{ items: User[]; total: number }>(`/api/v1/admin/users?q=${encodeURIComponent(term)}&status=${status}&limit=${PAGE}&offset=${offset}`),
    placeholderData: keepPreviousData,
  });

  return (
    <div>
      <PageHeader
        title="Users"
        description={list.data ? `${list.data.total} ${status === 'all' ? '' : status} users` : undefined}
        actions={
          canManage && (
            <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setCreating(true)}>
              Add user
            </Button>
          )
        }
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-zinc-200 p-4 sm:flex-row dark:border-zinc-800">
          <Input
            placeholder="Search name, email, department…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOffset(0);
            }}
            className="sm:max-w-sm"
          />
          <Select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setOffset(0);
            }}
            className="sm:w-44"
            aria-label="Status"
          >
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="deleted">Deleted (restorable)</option>
            <option value="all">All</option>
          </Select>
        </div>
        {list.isLoading ? (
          <PageSpinner />
        ) : list.data?.items.length === 0 ? (
          <EmptyState icon={<UsersIcon />} title="No users found" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th className="hidden md:table-cell">Roles</Th>
                <Th>Status</Th>
                <Th className="hidden sm:table-cell">MFA</Th>
                <Th className="hidden lg:table-cell">Last sign-in</Th>
              </tr>
            </thead>
            <tbody>
              {list.data?.items.map((u) => (
                <tr key={u.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                  <Td>
                    <Link to={`/admin/users/${u.id}`} className="flex items-center gap-3">
                      <Avatar name={u.displayName} size="sm" />
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-zinc-900 dark:text-zinc-100">{u.displayName}</span>
                        <span className="block truncate text-xs text-zinc-500">{u.email}</span>
                      </span>
                    </Link>
                  </Td>
                  <Td className="hidden md:table-cell">
                    <span className="flex flex-wrap gap-1">
                      {u.roles?.length ? u.roles.map((r) => <Badge key={r} tone="brand">{r.replace(/_/g, ' ')}</Badge>) : <span className="text-zinc-400">—</span>}
                    </span>
                  </Td>
                  <Td>
                    <UserStatusBadge status={u.status} locked={u.locked} />
                  </Td>
                  <Td className="hidden sm:table-cell">
                    {u.mfaEnabled ? <ShieldCheck className="size-4 text-emerald-600" aria-label="Enabled" /> : u.mfaRequired ? <Badge tone="warning">Pending</Badge> : <span className="text-zinc-400">Off</span>}
                  </Td>
                  <Td className="hidden text-zinc-500 lg:table-cell">{formatRelative(u.lastLoginAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {list.data && list.data.total > PAGE && (
          <div className="flex items-center justify-between p-4 text-sm text-zinc-500">
            <span>
              {offset + 1}–{Math.min(offset + PAGE, list.data.total)} of {list.data.total}
            </span>
            <div className="flex gap-2">
              <Button size="sm" disabled={offset === 0} onClick={() => setOffset(offset - PAGE)}>
                Previous
              </Button>
              <Button size="sm" disabled={offset + PAGE >= list.data.total} onClick={() => setOffset(offset + PAGE)}>
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>
      <CreateUserDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function CreateUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const canAssignRoles = useCan('roles:manage');
  const domains = useQuery({ queryKey: ['admin', 'domains'], queryFn: () => api<{ items: Domain[] }>('/api/v1/admin/domains'), enabled: open });
  const roles = useQuery({ queryKey: ['admin', 'roles'], queryFn: () => api<{ items: Role[] }>('/api/v1/admin/roles'), enabled: open && canAssignRoles });
  const empty = { displayName: '', givenName: '', familyName: '', username: '', domainId: '', jobTitle: '', department: '', setPassword: false, password: '', mfaRequired: false, roles: [] as string[] };
  const [f, setF] = useState(empty);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ user: User; temporaryPassword: string | null } | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const primary = domains.data?.items.find((d) => d.isPrimary);

  const create = useMutation({
    mutationFn: () =>
      api<{ user: User; temporaryPassword: string | null }>('/api/v1/admin/users', {
        body: {
          username: f.username,
          domainId: f.domainId || undefined,
          displayName: f.displayName,
          givenName: f.givenName || undefined,
          familyName: f.familyName || undefined,
          jobTitle: f.jobTitle || undefined,
          department: f.department || undefined,
          password: f.setPassword ? f.password : undefined,
          mustChangePassword: true,
          mfaRequired: f.mfaRequired,
          roles: f.roles.length ? f.roles : undefined,
        },
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      setF(empty);
      setError(null);
      onClose();
      if (r.temporaryPassword) setCreated(r);
      else navigate(`/admin/users/${r.user.id}`);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const autoUsername = (given: string, family: string) =>
    [given, family]
      .filter(Boolean)
      .join('.')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9.]/g, '');

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        size="lg"
        title="Add user"
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={create.isPending} disabled={!f.displayName || !f.username} onClick={() => create.mutate()}>
              Create user
            </Button>
          </>
        }
      >
        {error && (
          <Alert tone="danger" className="mb-4">
            {error}
          </Alert>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" htmlFor="given">
            <Input
              id="given"
              value={f.givenName}
              onChange={(e) => {
                const given = e.target.value;
                setF((x) => ({ ...x, givenName: given, displayName: [given, x.familyName].filter(Boolean).join(' '), username: autoUsername(given, x.familyName) }));
              }}
            />
          </Field>
          <Field label="Last name" htmlFor="family">
            <Input
              id="family"
              value={f.familyName}
              onChange={(e) => {
                const family = e.target.value;
                setF((x) => ({ ...x, familyName: family, displayName: [x.givenName, family].filter(Boolean).join(' '), username: autoUsername(x.givenName, family) }));
              }}
            />
          </Field>
          <Field label="Display name" htmlFor="display" className="sm:col-span-2">
            <Input id="display" required value={f.displayName} onChange={(e) => set('displayName', e.target.value)} />
          </Field>
          <Field label="Username" htmlFor="username">
            <Input id="username" required value={f.username} onChange={(e) => set('username', e.target.value.toLowerCase())} />
          </Field>
          <Field label="Domain" htmlFor="domain">
            <Select id="domain" value={f.domainId || primary?.id || ''} onChange={(e) => set('domainId', e.target.value)}>
              {domains.data?.items.map((d) => (
                <option key={d.id} value={d.id}>
                  @{d.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Job title" htmlFor="title">
            <Input id="title" value={f.jobTitle} onChange={(e) => set('jobTitle', e.target.value)} />
          </Field>
          <Field label="Department" htmlFor="dept">
            <Input id="dept" value={f.department} onChange={(e) => set('department', e.target.value)} />
          </Field>
        </div>
        <div className="mt-6 space-y-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <Switch checked={f.setPassword} onChange={(v) => set('setPassword', v)} label="Set the initial password myself" description="Otherwise a temporary password is generated. Either way, the user must change it at first sign-in." />
          {f.setPassword && (
            <Field label="Initial password" htmlFor="pw" hint="At least 12 characters">
              <Input id="pw" type="password" autoComplete="new-password" value={f.password} onChange={(e) => set('password', e.target.value)} />
            </Field>
          )}
          <Switch checked={f.mfaRequired} onChange={(v) => set('mfaRequired', v)} label="Require two-step verification" description="Enrol an authenticator app at first sign-in, even if not required organisation-wide." />
          {canAssignRoles && roles.data && (
            <fieldset>
              <legend className="mb-2 text-sm font-medium">Admin roles</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {roles.data.items.map((r) => (
                  <label key={r.id} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-[var(--brand)]"
                      checked={f.roles.includes(r.key)}
                      onChange={(e) => set('roles', e.target.checked ? [...f.roles, r.key] : f.roles.filter((k) => k !== r.key))}
                    />
                    <span>
                      <span className="font-medium">{r.name}</span>
                      <span className="block text-xs text-zinc-500">{r.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
        </div>
      </Dialog>
      <TemporaryPasswordDialog
        password={created?.temporaryPassword ?? null}
        email={created?.user.email}
        onClose={() => {
          const id = created?.user.id;
          setCreated(null);
          if (id) navigate(`/admin/users/${id}`);
        }}
      />
    </>
  );
}
