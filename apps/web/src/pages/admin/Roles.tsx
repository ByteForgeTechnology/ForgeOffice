import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Plus } from 'lucide-react';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog, Field, Input, PageHeader, PageSpinner, Textarea, useToast } from '@forge/ui';
import { ConfirmDialog, PERMISSION_GROUPS } from '../../components/admin';
import { api, errorMessage } from '../../lib/api';
import { useCan, useMe } from '../../lib/hooks';
import type { Role } from '../../lib/types';

interface RolesResponse {
  items: Role[];
  permissions: { key: string; description: string }[];
}

export function RolesPage() {
  const canManage = useCan('roles:manage');
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<Role | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Role | null>(null);
  const list = useQuery({ queryKey: ['admin', 'roles'], queryFn: () => api<RolesResponse>('/api/v1/admin/roles') });
  const del = useMutation({
    mutationFn: (r: Role) => api(`/api/v1/admin/roles/${r.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: ['admin', 'roles'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (list.isLoading) return <PageSpinner />;
  const describe = Object.fromEntries(list.data!.permissions.map((p) => [p.key, p.description]));

  return (
    <div>
      <PageHeader
        title="Roles"
        description="Roles bundle administrative permissions. Assign them to users from the user’s page."
        actions={
          canManage && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              Custom role
            </Button>
          )
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        {list.data!.items.map((r) => (
          <Card key={r.id}>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  {r.name} {r.builtin && <Lock className="size-3.5 text-zinc-400" aria-label="Built-in" />}
                </span>
              }
              description={r.description}
              actions={
                <>
                  <Badge>{r.userCount} users</Badge>
                  {canManage && !r.builtin && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleting(r)}>
                        Delete
                      </Button>
                    </>
                  )}
                </>
              }
            />
            <CardBody>
              <ul className="flex flex-wrap gap-1.5">
                {r.permissions.map((p) => (
                  <li key={p}>
                    <Badge tone="brand" className="font-mono" >
                      <span title={describe[p]}>{p}</span>
                    </Badge>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        ))}
      </div>
      {editing && <RoleDialog role={editing === 'new' ? null : editing} permissions={list.data!.permissions} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={() => deleting && del.mutate(deleting)} title={`Delete ${deleting?.name}?`} danger confirmLabel="Delete" busy={del.isPending}>
        {deleting?.userCount ? `${deleting.userCount} users will lose these permissions.` : 'No users currently have this role.'}
      </ConfirmDialog>
    </div>
  );
}

function RoleDialog({ role, permissions, onClose }: { role: Role | null; permissions: RolesResponse['permissions']; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const [f, setF] = useState({ key: role?.key ?? '', name: role?.name ?? '', description: role?.description ?? '', permissions: role?.permissions ?? [] });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      role
        ? api(`/api/v1/admin/roles/${role.id}`, { method: 'PATCH', body: { name: f.name, description: f.description, permissions: f.permissions } })
        : api('/api/v1/admin/roles', { body: f }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'roles'] });
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const toggle = (p: string, on: boolean) => setF((x) => ({ ...x, permissions: on ? [...x.permissions, p] : x.permissions.filter((y) => y !== p) }));
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={role ? `Edit ${role.name}` : 'New custom role'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!f.name || !f.key} onClick={() => save.mutate()}>
            Save role
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
        <Field label="Name" htmlFor="r-name">
          <Input
            id="r-name"
            value={f.name}
            onChange={(e) => {
              const name = e.target.value;
              setF((x) => ({ ...x, name, key: role ? x.key : name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) }));
            }}
          />
        </Field>
        <Field label="Key" htmlFor="r-key" hint="Lower-case identifier">
          <Input id="r-key" value={f.key} disabled={!!role} onChange={(e) => setF({ ...f, key: e.target.value })} className="font-mono" />
        </Field>
        <Field label="Description" htmlFor="r-desc" className="sm:col-span-2">
          <Textarea id="r-desc" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
      </div>
      <div className="mt-6 space-y-4">
        <p className="text-sm font-medium">Permissions</p>
        <p className="text-xs text-zinc-500">You can only grant permissions you hold yourself.</p>
        {PERMISSION_GROUPS.map((g) => {
          const perms = permissions.filter((p) => p.key.startsWith(g.prefix));
          if (!perms.length) return null;
          return (
            <fieldset key={g.prefix}>
              <legend className="mb-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">{g.label}</legend>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {perms.map((p) => (
                  <label key={p.key} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-[var(--brand)]"
                      checked={f.permissions.includes(p.key)}
                      disabled={!me?.permissions.includes(p.key)}
                      onChange={(e) => toggle(p.key, e.target.checked)}
                    />
                    <span>
                      <span className="font-mono text-xs">{p.key}</span>
                      <span className="block text-xs text-zinc-500">{p.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          );
        })}
      </div>
    </Dialog>
  );
}
