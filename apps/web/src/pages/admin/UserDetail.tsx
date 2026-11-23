import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, KeyRound, Lock, Pencil, RotateCcw, ShieldOff, Trash2, UserCheck, UserX } from 'lucide-react';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Dialog,
  Field,
  Input,
  PageSpinner,
  ProgressBar,
  Switch,
  formatBytes,
  formatDateTime,
  formatRelative,
  useToast,
} from '@forge/ui';
import { ConfirmDialog, TemporaryPasswordDialog, UserStatusBadge } from '../../components/admin';
import { DeviceList, type DeviceSession } from '../../components/Devices';
import { EditableAvatar } from '../../components/ProfilePicture';
import { api, errorMessage } from '../../lib/api';
import { useCan, useMe } from '../../lib/hooks';
import { CONTACT_FIELDS, type ContactKey, type Role, type User } from '../../lib/types';

const GiB = 1024 ** 3;

type Action = 'suspend' | 'unsuspend' | 'delete' | 'restore' | 'reset-mfa' | 'unlock' | 'reset-password';

const ACTIONS: Record<Action, { title: string; body: string; confirm: string; danger?: boolean; done: string }> = {
  suspend: { title: 'Suspend user?', body: 'They are signed out everywhere and cannot sign in until unsuspended. Their data is kept.', confirm: 'Suspend', danger: true, done: 'User suspended' },
  unsuspend: { title: 'Unsuspend user?', body: 'They will be able to sign in again.', confirm: 'Unsuspend', done: 'User reactivated' },
  delete: { title: 'Delete user?', body: 'The account is disabled immediately and permanently purged after 30 days. You can restore it until then.', confirm: 'Delete', danger: true, done: 'User deleted' },
  restore: { title: 'Restore user?', body: 'The account becomes active again with its previous data and roles.', confirm: 'Restore', done: 'User restored' },
  'reset-mfa': { title: 'Reset two-step verification?', body: 'Their authenticator app and recovery codes are removed and their sessions are ended. If MFA is required they will enrol again at next sign-in.', confirm: 'Reset MFA', danger: true, done: 'MFA reset' },
  unlock: { title: 'Unlock account?', body: 'Clears the lockout caused by repeated failed sign-ins.', confirm: 'Unlock', done: 'Account unlocked' },
  'reset-password': { title: 'Reset password?', body: 'A temporary password is generated and all of their sessions are ended. They must choose a new password at next sign-in.', confirm: 'Reset password', danger: true, done: 'Password reset' },
};

export function UserDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { data: me } = useMe();
  const canManage = useCan('users:manage');
  const canCredentials = useCan('users:credentials');
  const canRoles = useCan('roles:manage');
  const [action, setAction] = useState<Action | null>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const detail = useQuery({
    queryKey: ['admin', 'user', id],
    queryFn: () => api<{ user: User; effectiveQuotaBytes: number | null; groups: { id: string; name: string; type: string; role: string }[] }>(`/api/v1/admin/users/${id}`),
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['admin', 'user', id] });
    void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
  };

  const run = useMutation({
    mutationFn: async (a: Action) => {
      if (a === 'delete') return api(`/api/v1/admin/users/${id}`, { method: 'DELETE' });
      if (a === 'reset-password') return api<{ temporaryPassword: string | null }>(`/api/v1/admin/users/${id}/reset-password`, { body: {} });
      return api(`/api/v1/admin/users/${id}/${a}`, { body: {} });
    },
    onSuccess: (res, a) => {
      toast.success(ACTIONS[a].done);
      setAction(null);
      if (a === 'reset-password') setTempPassword((res as { temporaryPassword: string | null }).temporaryPassword);
      invalidate();
      if (a === 'delete') navigate('/admin/directory/users');
    },
    onError: (e) => {
      setAction(null);
      toast.error(errorMessage(e));
    },
  });

  if (detail.isLoading) return <PageSpinner />;
  if (detail.error) return <Alert tone="danger">{errorMessage(detail.error)}</Alert>;
  const { user, groups, effectiveQuotaBytes } = detail.data!;
  const self = me?.user.id === user.id;

  return (
    <div className="space-y-6">
      <Link to="/admin/directory/users" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
        <ArrowLeft className="size-4" /> Users
      </Link>
      <div className="flex flex-wrap items-center gap-4">
        {canManage ? (
          <EditableAvatar name={user.displayName} src={user.avatarUrl} endpoint={`/api/v1/admin/users/${user.id}/avatar`} size="lg" onChanged={() => void qc.invalidateQueries({ queryKey: ['admin'] })} />
        ) : (
          <Avatar name={user.displayName} src={user.avatarUrl} size="lg" />
        )}
        <div className="min-w-0 flex-1">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
            {user.displayName} <UserStatusBadge status={user.status} locked={user.locked} />
            {self && <Badge tone="brand">You</Badge>}
          </h1>
          <p className="text-sm text-zinc-500">
            {user.email}
            {user.jobTitle && ` · ${user.jobTitle}`}
            {user.department && ` · ${user.department}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canManage && user.status !== 'deleted' && (
            <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
          {canCredentials && !self && user.status !== 'deleted' && (
            <Button icon={<KeyRound className="size-4" />} onClick={() => setAction('reset-password')}>
              Reset password
            </Button>
          )}
          {canManage && !self && user.status === 'active' && (
            <Button icon={<UserX className="size-4" />} onClick={() => setAction('suspend')}>
              Suspend
            </Button>
          )}
          {canManage && user.status === 'suspended' && (
            <Button icon={<UserCheck className="size-4" />} onClick={() => setAction('unsuspend')}>
              Unsuspend
            </Button>
          )}
          {canManage && user.status === 'deleted' && (
            <Button variant="primary" icon={<RotateCcw className="size-4" />} onClick={() => setAction('restore')}>
              Restore
            </Button>
          )}
          {canManage && !self && user.status !== 'deleted' && (
            <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={() => setAction('delete')}>
              Delete
            </Button>
          )}
        </div>
      </div>

      {user.status === 'deleted' && <Alert tone="danger">Deleted {formatRelative(user.deletedAt)}. This account will be purged 30 days after deletion unless restored.</Alert>}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Sign-in & security" />
          <CardBody className="space-y-3 text-sm">
            <Row label="Last sign-in">{formatDateTime(user.lastLoginAt)}</Row>
            <Row label="Password changed">{formatDateTime(user.passwordChangedAt)}</Row>
            <Row label="Must change password">{user.mustChangePassword ? 'Yes, at next sign-in' : 'No'}</Row>
            <Row label="Two-step verification">
              {user.mfaEnabled ? <Badge tone="success">Enabled · {user.recoveryCodesRemaining} recovery codes</Badge> : user.mfaRequired ? <Badge tone="warning">Required, not enrolled</Badge> : <Badge>Off</Badge>}
            </Row>
            <Row label="Account lock">
              {user.locked ? (
                <span className="flex items-center gap-2">
                  <Badge tone="warning">
                    <Lock className="size-3" /> Locked
                  </Badge>
                  {canCredentials && (
                    <Button size="sm" onClick={() => setAction('unlock')}>
                      Unlock
                    </Button>
                  )}
                </span>
              ) : (
                'Not locked'
              )}
            </Row>
            {canCredentials && user.mfaEnabled && !self && (
              <Button size="sm" variant="ghost" icon={<ShieldOff className="size-4" />} onClick={() => setAction('reset-mfa')}>
                Reset two-step verification
              </Button>
            )}
          </CardBody>
        </Card>

        <UserDevicesCard userId={user.id} editable={canManage && !self && user.status === 'active'} />

        <ContactCard user={user} onEdit={canManage && user.status !== 'deleted' ? () => setEditing(true) : undefined} />

        <StorageCard user={user} quota={effectiveQuotaBytes} />

        <AliasesCard userId={user.id} primary={user.email} self={self} editable={canManage && user.status !== 'deleted'} onPrimaryChanged={invalidate} />

        <RolesCard user={user} editable={canRoles} onSaved={invalidate} />

        <Card>
          <CardHeader title="Groups" description={`${groups.length} memberships`} />
          <CardBody>
            {groups.length ? (
              <ul className="space-y-2">
                {groups.map((g) => (
                  <li key={g.id} className="flex items-center justify-between gap-2 text-sm">
                    <Link to={`/admin/directory/groups/${g.id}`} className="font-medium hover:text-brand">
                      {g.name}
                    </Link>
                    <span className="flex gap-1">
                      {g.role === 'owner' && <Badge tone="brand">Owner</Badge>}
                      <Badge tone={g.type === 'security' ? 'neutral' : 'info'}>{g.type}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-zinc-500">Not a member of any group.</p>
            )}
          </CardBody>
        </Card>
      </div>

      {action && (
        <ConfirmDialog
          open
          onClose={() => setAction(null)}
          onConfirm={() => run.mutate(action)}
          title={ACTIONS[action].title}
          confirmLabel={ACTIONS[action].confirm}
          danger={ACTIONS[action].danger}
          busy={run.isPending}
        >
          {ACTIONS[action].body}
        </ConfirmDialog>
      )}
      <TemporaryPasswordDialog password={tempPassword} email={user.email} onClose={() => setTempPassword(null)} />
      <EditUserDialog user={user} open={editing} onClose={() => setEditing(false)} onSaved={invalidate} />
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-zinc-500">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

function UserDevicesCard({ userId, editable }: { userId: string; editable: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const sessions = useQuery({ queryKey: ['admin', 'user-sessions', userId], queryFn: () => api<{ items: DeviceSession[] }>(`/api/v1/admin/users/${userId}/sessions`) });
  const revoke = useMutation({
    mutationFn: () => api<{ signedOut: number }>(`/api/v1/admin/users/${userId}/sessions/revoke`, { body: {} }),
    onSuccess: (r) => {
      toast.success(r.signedOut ? `Signed out of ${r.signedOut} ${r.signedOut === 1 ? 'device' : 'devices'}` : 'Not signed in anywhere');
      void qc.invalidateQueries({ queryKey: ['admin', 'user-sessions', userId] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card>
      <CardHeader
        title="Signed-in devices"
        description="Browsers and devices this person is signed in on."
        actions={
          editable &&
          !!sessions.data?.items.length && (
            <Button size="sm" variant="ghost" loading={revoke.isPending} onClick={() => window.confirm('Sign this person out of every browser and device? Apps using app passwords stay connected.') && revoke.mutate()}>
              Sign out everywhere
            </Button>
          )
        }
      />
      <CardBody>{sessions.isLoading ? null : <DeviceList items={sessions.data?.items ?? []} />}</CardBody>
    </Card>
  );
}

function ContactCard({ user, onEdit }: { user: User; onEdit?: () => void }) {
  const filled = CONTACT_FIELDS.filter((f) => user[f.key]);
  return (
    <Card>
      <CardHeader
        title="Contact details"
        description="Shown in the directory and address books, and used in email signatures."
        actions={
          onEdit && (
            <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={onEdit}>
              Edit
            </Button>
          )
        }
      />
      <CardBody className="space-y-3 text-sm">
        <Row label="Job title">{user.jobTitle || '—'}</Row>
        <Row label="Department">{user.department || '—'}</Row>
        {filled.map((f) => (
          <Row key={f.key} label={f.label}>
            {f.key === 'website' ? (
              <a className="text-brand hover:underline" href={/^https?:/i.test(user.website!) ? user.website! : `https://${user.website}`} target="_blank" rel="noreferrer">
                {user.website}
              </a>
            ) : f.key === 'workPhone' || f.key === 'mobilePhone' ? (
              <a className="hover:underline" href={`tel:${user[f.key]!.replace(/[^\d+]/g, '')}`}>
                {user[f.key]}
              </a>
            ) : (
              user[f.key]
            )}
          </Row>
        ))}
        {!filled.length && <p className="text-zinc-500">No phone numbers, website or address yet.</p>}
      </CardBody>
    </Card>
  );
}

function StorageCard({ user, quota }: { user: User; quota: number | null }) {
  return (
    <Card>
      <CardHeader title="Storage" description={user.quotaBytes == null ? 'Using the organisation default quota' : 'Custom quota'} />
      <CardBody className="space-y-2">
        <ProgressBar value={quota ? (user.usedBytes / quota) * 100 : 0} />
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {formatBytes(user.usedBytes)} of {quota ? formatBytes(quota) : 'unlimited'}
        </p>
      </CardBody>
    </Card>
  );
}

function RolesCard({ user, editable, onSaved }: { user: User; editable: boolean; onSaved: () => void }) {
  const toast = useToast();
  const roles = useQuery({ queryKey: ['admin', 'roles'], queryFn: () => api<{ items: Role[] }>('/api/v1/admin/roles') });
  const [selected, setSelected] = useState<string[]>(user.roles ?? []);
  useEffect(() => setSelected(user.roles ?? []), [user.roles]);
  const dirty = [...selected].sort().join() !== [...(user.roles ?? [])].sort().join();
  const save = useMutation({
    mutationFn: () => api(`/api/v1/admin/users/${user.id}/roles`, { method: 'PUT', body: { roles: selected } }),
    onSuccess: () => {
      toast.success('Roles updated');
      onSaved();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card>
      <CardHeader
        title="Admin roles"
        description="Everyone can use the apps; roles grant administrative access."
        actions={
          editable &&
          dirty && (
            <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
              Save
            </Button>
          )
        }
      />
      <CardBody className="space-y-2">
        {roles.data?.items.map((r) => (
          <label key={r.id} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 accent-[var(--brand)]"
              disabled={!editable}
              checked={selected.includes(r.key)}
              onChange={(e) => setSelected(e.target.checked ? [...selected, r.key] : selected.filter((k) => k !== r.key))}
            />
            <span>
              <span className="font-medium">{r.name}</span>
              <span className="block text-xs text-zinc-500">{r.description}</span>
            </span>
          </label>
        ))}
      </CardBody>
    </Card>
  );
}

function EditUserDialog({ user, open, onClose, onSaved }: { user: User; open: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const init = () => ({
    displayName: user.displayName,
    givenName: user.givenName ?? '',
    familyName: user.familyName ?? '',
    jobTitle: user.jobTitle ?? '',
    department: user.department ?? '',
    contact: Object.fromEntries(CONTACT_FIELDS.map((c) => [c.key, user[c.key] ?? ''])) as Record<ContactKey, string>,
    mfaRequired: user.mfaRequired,
    customQuota: user.quotaBytes != null,
    quotaGb: user.quotaBytes != null ? user.quotaBytes / GiB : 50,
  });
  const [f, setF] = useState(init);
  useEffect(() => {
    if (open) setF(init());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/admin/users/${user.id}`, {
        method: 'PATCH',
        body: {
          displayName: f.displayName,
          givenName: f.givenName || null,
          familyName: f.familyName || null,
          jobTitle: f.jobTitle || null,
          department: f.department || null,
          ...Object.fromEntries(CONTACT_FIELDS.map((c) => [c.key, f.contact[c.key].trim() || null])),
          mfaRequired: f.mfaRequired,
          quotaBytes: f.customQuota ? Math.round(f.quotaGb * GiB) : null,
        },
      }),
    onSuccess: () => {
      toast.success('User updated');
      onSaved();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Edit user"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Display name" htmlFor="e-dn" className="sm:col-span-2">
          <Input id="e-dn" value={f.displayName} onChange={(e) => set('displayName', e.target.value)} />
        </Field>
        <Field label="First name" htmlFor="e-gn">
          <Input id="e-gn" value={f.givenName} onChange={(e) => set('givenName', e.target.value)} />
        </Field>
        <Field label="Last name" htmlFor="e-fn">
          <Input id="e-fn" value={f.familyName} onChange={(e) => set('familyName', e.target.value)} />
        </Field>
        <Field label="Job title" htmlFor="e-jt">
          <Input id="e-jt" value={f.jobTitle} onChange={(e) => set('jobTitle', e.target.value)} />
        </Field>
        <Field label="Department" htmlFor="e-dp">
          <Input id="e-dp" value={f.department} onChange={(e) => set('department', e.target.value)} />
        </Field>
      </div>
      <p className="mt-6 mb-3 border-t border-zinc-200 pt-4 text-sm font-medium dark:border-zinc-800">Contact details</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {CONTACT_FIELDS.map((c) => (
          <Field key={c.key} label={c.label} htmlFor={`e-${c.key}`} className={'wide' in c && c.wide ? 'sm:col-span-2' : undefined}>
            <Input
              id={`e-${c.key}`}
              type={'type' in c ? c.type : 'text'}
              placeholder={'placeholder' in c ? c.placeholder : undefined}
              value={f.contact[c.key]}
              onChange={(e) => set('contact', { ...f.contact, [c.key]: e.target.value })}
            />
          </Field>
        ))}
      </div>
      <div className="mt-6 space-y-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <Switch checked={f.mfaRequired} onChange={(v) => set('mfaRequired', v)} label="Require two-step verification" />
        <Switch checked={f.customQuota} onChange={(v) => set('customQuota', v)} label="Custom storage quota" description="Override the organisation default for this user." />
        {f.customQuota && (
          <Field label="Quota (GB)" htmlFor="e-q">
            <Input id="e-q" type="number" min={0} value={f.quotaGb} onChange={(e) => set('quotaGb', Number(e.target.value))} className="w-40" />
          </Field>
        )}
      </div>
    </Dialog>
  );
}

function AliasesCard({ userId, primary, self, editable, onPrimaryChanged }: { userId: string; primary: string; self: boolean; editable: boolean; onPrimaryChanged: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [address, setAddress] = useState('');
  const [promoting, setPromoting] = useState<{ id: string; address: string } | null>(null);
  const makePrimary = useMutation({
    mutationFn: (id: string) => api<{ email: string; previous: string }>(`/api/v1/admin/users/${userId}/aliases/${id}/make-primary`, { body: {} }),
    onSuccess: (r) => {
      setPromoting(null);
      toast.success(`${r.email} is now the primary address`);
      void qc.invalidateQueries({ queryKey: ['admin', 'aliases', userId] });
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      if (self) void qc.invalidateQueries({ queryKey: ['me'] });
      onPrimaryChanged();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const aliases = useQuery({ queryKey: ['admin', 'aliases', userId], queryFn: () => api<{ items: { id: string; address: string }[] }>(`/api/v1/admin/users/${userId}/aliases`) });
  const add = useMutation({
    mutationFn: () => api(`/api/v1/admin/users/${userId}/aliases`, { body: { address } }),
    onSuccess: () => {
      setAddress('');
      void qc.invalidateQueries({ queryKey: ['admin', 'aliases', userId] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/admin/users/${userId}/aliases/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'aliases', userId] }),
  });
  return (
    <Card>
      <CardHeader title="Email aliases" description="Extra addresses that deliver to this mailbox and can be sent from." />
      <CardBody className="space-y-3">
        <ul className="space-y-1">
          <li className="flex min-h-8 items-center gap-2 text-sm">
            <span className="truncate font-mono">{primary}</span>
            <Badge tone="brand">Primary</Badge>
          </li>
          {aliases.data?.items.map((a) => (
            <li key={a.id} className="flex min-h-8 items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-mono">{a.address}</span>
              {editable && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setPromoting(a)}>
                    Make primary
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={`Remove ${a.address}`} onClick={() => remove.mutate(a.id)}>
                    <Trash2 className="size-4" />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
        {!aliases.data?.items.length && <p className="text-sm text-zinc-500">No aliases.</p>}
        {editable && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate();
            }}
          >
            <Input aria-label="New alias" type="email" placeholder="sales@example.com" value={address} onChange={(e) => setAddress(e.target.value)} />
            <Button type="submit" loading={add.isPending} disabled={!address}>
              Add
            </Button>
          </form>
        )}
      </CardBody>
      <ConfirmDialog
        open={!!promoting}
        onClose={() => setPromoting(null)}
        onConfirm={() => promoting && makePrimary.mutate(promoting.id)}
        title={`Make ${promoting?.address} the primary address?`}
        confirmLabel="Make primary"
        busy={makePrimary.isPending}
      >
        <div className="space-y-2">
          <p>
            <span className="font-mono">{primary}</span> becomes an alias, so mail sent to it still arrives.
          </p>
          <p>
            {self ? 'You' : 'This person'} will sign in with <span className="font-mono">{promoting?.address}</span> from now on: on the web, and in desktop and phone apps for mail, calendar and contacts, which need their account settings updated. New messages are sent from it by default.
          </p>
        </div>
      </ConfirmDialog>
    </Card>
  );
}
