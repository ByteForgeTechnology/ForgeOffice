import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Crown, Trash2, UserPlus, X } from 'lucide-react';
import { Alert, Avatar, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, PageSpinner, Switch, Textarea, useToast } from '@forge/ui';
import { ConfirmDialog, UserPicker, UserStatusBadge } from '../../components/admin';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/hooks';
import type { DirectoryCard, Group, UserStatus } from '../../lib/types';
import { GroupTypeBadge } from './Groups';

interface Member extends DirectoryCard {
  status: UserStatus;
  role: 'owner' | 'member';
}

export function GroupDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const canManage = useCan('groups:manage');
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const key = ['admin', 'group', id];
  const detail = useQuery({ queryKey: key, queryFn: () => api<{ group: Group; members: Member[] }>(`/api/v1/admin/groups/${id}`) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['admin', 'groups'] });
  };
  const add = useMutation({
    mutationFn: (body: { userIds: string[]; role?: 'owner' | 'member' }) => api(`/api/v1/admin/groups/${id}/members`, { body }),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api(`/api/v1/admin/groups/${id}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const del = useMutation({
    mutationFn: () => api(`/api/v1/admin/groups/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Group deleted');
      void qc.invalidateQueries({ queryKey: ['admin', 'groups'] });
      navigate('/admin/groups');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (detail.isLoading) return <PageSpinner />;
  if (detail.error) return <Alert tone="danger">{errorMessage(detail.error)}</Alert>;
  const { group, members } = detail.data!;

  return (
    <div className="space-y-6">
      <Link to="/admin/groups" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
        <ArrowLeft className="size-4" /> Groups
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
            {group.name} <GroupTypeBadge type={group.type} />
          </h1>
          {group.email && <p className="font-mono text-sm text-zinc-500">{group.email}</p>}
          {group.description && <p className="mt-2 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">{group.description}</p>}
        </div>
        {canManage && (
          <div className="flex gap-2">
            <Button onClick={() => setEditing(true)}>Edit</Button>
            <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={() => setDeleting(true)}>
              Delete
            </Button>
          </div>
        )}
      </div>

      <Card>
        <CardHeader
          title="Members"
          description={`${members.length} ${members.length === 1 ? 'person' : 'people'}`}
          actions={
            canManage && (
              <Button size="sm" variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setAdding(true)}>
                Add members
              </Button>
            )
          }
        />
        {members.length === 0 ? (
          <EmptyState title="No members yet" />
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {members.map((m) => (
              <li key={m.id} className="flex items-center gap-3 px-5 py-3">
                <Avatar name={m.displayName} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{m.displayName}</p>
                  <p className="truncate text-xs text-zinc-500">{m.email}</p>
                </div>
                {m.status !== 'active' && <UserStatusBadge status={m.status} />}
                {m.role === 'owner' && (
                  <Badge tone="brand">
                    <Crown className="size-3" /> Owner
                  </Badge>
                )}
                {canManage && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => add.mutate({ userIds: [m.id], role: m.role === 'owner' ? 'member' : 'owner' })}>
                      {m.role === 'owner' ? 'Make member' : 'Make owner'}
                    </Button>
                    <Button size="sm" variant="ghost" aria-label={`Remove ${m.displayName}`} onClick={() => remove.mutate(m.id)}>
                      <X className="size-4" />
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Dialog open={adding} onClose={() => setAdding(false)} title="Add members" description="Pick people to add. They are added immediately.">
        <UserPicker exclude={members.map((m) => m.id)} onPick={(u) => add.mutate({ userIds: [u.id] })} />
      </Dialog>
      <ConfirmDialog open={deleting} onClose={() => setDeleting(false)} onConfirm={() => del.mutate()} title={`Delete ${group.name}?`} danger confirmLabel="Delete group" busy={del.isPending}>
        Members are not deleted, but any access granted through this group is removed.
      </ConfirmDialog>
      <EditGroupDialog group={group} open={editing} onClose={() => setEditing(false)} onSaved={refresh} />
    </div>
  );
}

function EditGroupDialog({ group, open, onClose, onSaved }: { group: Group; open: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: group.name, description: group.description, email: group.email ?? '', allowExternalSenders: group.allowExternalSenders });
  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/admin/groups/${group.id}`, {
        method: 'PATCH',
        body: { name: f.name, description: f.description, email: f.email || null, allowExternalSenders: f.allowExternalSenders },
      }),
    onSuccess: () => {
      toast.success('Group updated');
      onSaved();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Edit group"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" htmlFor="eg-name">
          <Input id="eg-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Description" htmlFor="eg-desc">
          <Textarea id="eg-desc" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field label="Email address" htmlFor="eg-email" hint={group.type === 'security' ? 'Leave empty for a group without mail.' : undefined}>
          <Input id="eg-email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
        {group.type === 'distribution' && (
          <Switch checked={f.allowExternalSenders} onChange={(v) => setF({ ...f, allowExternalSenders: v })} label="Allow external senders" />
        )}
      </div>
    </Dialog>
  );
}

