import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react';
import { Alert, Avatar, Badge, Button, Card, CardBody, CardHeader, Dialog, Field, Input, PageHeader, PageSpinner, Select, ThemeSwitcher, formatDateTime, useToast } from '@forge/ui';
import { RecoveryCodes } from '../components/AuthCard';
import { api, errorMessage } from '../lib/api';
import { useMe } from '../lib/hooks';
import type { Enrollment } from '../lib/types';
import { EnrollForm } from './SignIn';

export function AccountPage() {
  const { data: me } = useMe();
  const { hash } = useLocation();
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'smooth' });
  }, [hash, me]);
  if (!me) return <PageSpinner />;
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title="Account settings" description={me.user.email} />
      <ProfileCard />
      <PasswordCard />
      <MfaCard />
      <AppPasswordsCard />
      <Card>
        <CardHeader title="Appearance" description="Applies to this browser." />
        <CardBody>
          <ThemeSwitcher />
        </CardBody>
      </Card>
    </div>
  );
}

function ProfileCard() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const timezones = useQuery({ queryKey: ['setup-status'], queryFn: () => api<{ timezones: string[] }>('/api/v1/setup/status', { anonymous: true }) });
  const [displayName, setDisplayName] = useState(me!.user.displayName);
  const [timezone, setTimezone] = useState(me!.user.timezone ?? '');
  const save = useMutation({
    mutationFn: () => api('/api/v1/me', { method: 'PATCH', body: { displayName, timezone: timezone || null } }),
    onSuccess: () => {
      toast.success('Profile saved');
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card>
      <CardHeader title="Profile" />
      <CardBody>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="flex items-center gap-4">
            <Avatar name={displayName || me!.user.displayName} size="lg" />
            <div className="text-sm text-zinc-500">
              <p>{me!.user.jobTitle ?? 'No job title'}</p>
              <p>{me!.user.department ?? 'No department'}</p>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Display name" htmlFor="display-name">
              <Input id="display-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
            </Field>
            <Field label="Time zone" htmlFor="tz" hint={`Organisation default: ${me!.org?.timezone ?? 'UTC'}`}>
              <Select id="tz" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                <option value="">Use organisation default</option>
                {timezones.data?.timezones.map((tz) => (
                  <option key={tz}>{tz}</option>
                ))}
              </Select>
            </Field>
          </div>
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save profile
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

function PasswordCard() {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const change = useMutation({
    mutationFn: () => api('/api/v1/me/password', { body: { currentPassword: current, newPassword: next } }),
    onSuccess: () => {
      toast.success('Password changed');
      setCurrent('');
      setNext('');
      setConfirm('');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const mismatch = confirm.length > 0 && next !== confirm;
  return (
    <Card>
      <CardHeader title="Password" />
      <CardBody>
        <form
          className="grid gap-4 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!mismatch) change.mutate();
          }}
        >
          <Field label="Current password" htmlFor="cur">
            <Input id="cur" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
          <Field label="New password" htmlFor="new" hint="12+ characters">
            <Input id="new" type="password" autoComplete="new-password" required minLength={12} value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field label="Confirm" htmlFor="conf" error={mismatch ? 'Does not match' : undefined}>
            <Input id="conf" type="password" autoComplete="new-password" required invalid={mismatch} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <div className="sm:col-span-3">
            <Button type="submit" variant="primary" loading={change.isPending} disabled={mismatch}>
              Change password
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

interface MfaStatus {
  totpEnabled: boolean;
  totpEnabledAt: string | null;
  required: boolean;
  recoveryCodesRemaining: number;
}

function MfaCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const status = useQuery({ queryKey: ['me', 'mfa'], queryFn: () => api<MfaStatus>('/api/v1/me/mfa') });
  const [enrolling, setEnrolling] = useState<(Enrollment & { enrollmentToken: string }) | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [passwordFor, setPasswordFor] = useState<'disable' | 'regenerate' | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['me'] });

  const start = useMutation({
    mutationFn: () => api<Enrollment & { enrollmentToken: string }>('/api/v1/me/mfa/totp/setup', { body: {} }),
    onSuccess: (e) => {
      setError(null);
      setEnrolling(e);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const enable = useMutation({
    mutationFn: (code: string) => api<{ recoveryCodes: string[] }>('/api/v1/me/mfa/totp/enable', { body: { enrollmentToken: enrolling!.enrollmentToken, code } }),
    onSuccess: (r) => {
      setEnrolling(null);
      setCodes(r.recoveryCodes);
      void refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const withPassword = useMutation({
    mutationFn: (): Promise<{ ok?: true; recoveryCodes?: string[] }> =>
      passwordFor === 'disable'
        ? api<{ ok: true }>('/api/v1/me/mfa/totp/disable', { body: { password } })
        : api<{ recoveryCodes: string[] }>('/api/v1/me/mfa/recovery-codes', { body: { password } }),
    onSuccess: (r) => {
      if (r.recoveryCodes) setCodes(r.recoveryCodes);
      else toast.success('Authenticator app removed');
      setPasswordFor(null);
      setPassword('');
      void refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const s = status.data;
  return (
    <Card>
      <div id="security" className="scroll-mt-20" />
      <CardHeader
        title="Two-step verification"
        description="Require a code from an authenticator app in addition to your password."
        actions={s && <Badge tone={s.totpEnabled ? 'success' : 'warning'}>{s.totpEnabled ? 'On' : 'Off'}</Badge>}
      />
      <CardBody className="space-y-4">
        {!s ? (
          <PageSpinner />
        ) : s.totpEnabled ? (
          <>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Authenticator app added {formatDateTime(s.totpEnabledAt)}. {s.recoveryCodesRemaining} unused recovery codes remain.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => (setError(null), setPasswordFor('regenerate'))}>New recovery codes</Button>
              <Button
                variant="ghost"
                icon={<ShieldOff className="size-4" />}
                disabled={s.required}
                title={s.required ? 'Required by your organisation' : undefined}
                onClick={() => (setError(null), setPasswordFor('disable'))}
              >
                Remove authenticator
              </Button>
            </div>
            {s.required && <p className="text-xs text-zinc-500">Your organisation requires two-step verification, so it cannot be turned off.</p>}
          </>
        ) : (
          <>
            {s.required && <Alert tone="warning">Your organisation requires two-step verification. You will be asked to set it up at your next sign-in.</Alert>}
            <Button variant="primary" icon={<ShieldCheck className="size-4" />} loading={start.isPending} onClick={() => start.mutate()}>
              Set up authenticator app
            </Button>
          </>
        )}
      </CardBody>

      <Dialog open={!!enrolling} onClose={() => setEnrolling(null)} title="Set up authenticator app">
        {error && (
          <Alert tone="danger" className="mb-4">
            {error}
          </Alert>
        )}
        {enrolling && <EnrollForm enrollment={enrolling} busy={enable.isPending} onSubmit={(code) => enable.mutate(code)} />}
      </Dialog>

      <Dialog
        open={!!codes}
        onClose={() => setCodes(null)}
        title="Your recovery codes"
        description="Each code works once. Store them somewhere safe; they will not be shown again."
        footer={
          <>
            <Button onClick={() => void navigator.clipboard?.writeText(codes?.join('\n') ?? '')}>Copy</Button>
            <Button variant="primary" onClick={() => setCodes(null)}>
              Done
            </Button>
          </>
        }
      >
        {codes && <RecoveryCodes codes={codes} />}
      </Dialog>

      <Dialog
        open={!!passwordFor}
        onClose={() => setPasswordFor(null)}
        size="sm"
        title={passwordFor === 'disable' ? 'Remove authenticator app' : 'Generate new recovery codes'}
        description="Confirm with your password."
        footer={
          <>
            <Button onClick={() => setPasswordFor(null)}>Cancel</Button>
            <Button variant={passwordFor === 'disable' ? 'danger' : 'primary'} loading={withPassword.isPending} onClick={() => withPassword.mutate()} disabled={!password}>
              {passwordFor === 'disable' ? 'Remove' : 'Generate'}
            </Button>
          </>
        }
      >
        {error && (
          <Alert tone="danger" className="mb-4">
            {error}
          </Alert>
        )}
        <Field label="Password" htmlFor="confirm-pw">
          <Input id="confirm-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      </Dialog>
    </Card>
  );
}

function AppPasswordsCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{ name: string; password: string } | null>(null);
  const list = useQuery({
    queryKey: ['me', 'app-passwords'],
    queryFn: () => api<{ items: { id: string; name: string; createdAt: string; lastUsedAt: string | null; lastUsedIp: string | null }[] }>('/api/v1/me/app-passwords'),
  });
  const create = useMutation({
    mutationFn: () => api<{ password: string; appPassword: { name: string } }>('/api/v1/me/app-passwords', { body: { name } }),
    onSuccess: (r) => {
      setCreated({ name: r.appPassword.name, password: r.password });
      setName('');
      void qc.invalidateQueries({ queryKey: ['me', 'app-passwords'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/v1/me/app-passwords/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['me', 'app-passwords'] }),
  });
  return (
    <Card>
      <div id="app-passwords" className="scroll-mt-20" />
      <CardHeader title="App passwords" description="Sign in mail, calendar and contacts apps (IMAP, SMTP, CalDAV, CardDAV) without your main password. Required when two-step verification is on." />
      <CardBody className="space-y-4">
        {list.data?.items.length ? (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {list.data.items.map((a) => (
              <li key={a.id} className="flex items-center gap-3 py-2 text-sm">
                <KeyRound className="size-4 text-zinc-400" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{a.name}</p>
                  <p className="text-xs text-zinc-500">
                    Created {formatDateTime(a.createdAt)} · {a.lastUsedAt ? `last used ${formatDateTime(a.lastUsedAt)}${a.lastUsedIp ? ` from ${a.lastUsedIp}` : ''}` : 'never used'}
                  </p>
                </div>
                <Button size="sm" variant="ghost" aria-label={`Revoke ${a.name}`} onClick={() => revoke.mutate(a.id)}>
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-zinc-500">No app passwords yet.</p>
        )}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Input aria-label="App name" placeholder="e.g. Thunderbird on laptop" value={name} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" loading={create.isPending} disabled={!name.trim()}>
            Create
          </Button>
        </form>
      </CardBody>
      <Dialog
        open={!!created}
        onClose={() => setCreated(null)}
        title={`App password for ${created?.name}`}
        description="Enter this instead of your normal password. It is shown only once."
        footer={
          <>
            <Button onClick={() => void navigator.clipboard?.writeText(created?.password ?? '')}>Copy</Button>
            <Button variant="primary" onClick={() => setCreated(null)}>
              Done
            </Button>
          </>
        }
      >
        <code className="block rounded-lg bg-zinc-100 px-3 py-3 text-center font-mono text-xl tracking-widest dark:bg-zinc-800">{created?.password}</code>
      </Dialog>
    </Card>
  );
}
