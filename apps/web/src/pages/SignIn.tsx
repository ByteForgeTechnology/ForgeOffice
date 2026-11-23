import { useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { KeyRound, ShieldCheck, Smartphone } from 'lucide-react';
import { Alert, Button, Field, Input, PageSpinner } from '@forge/ui';
import { AuthCard, RecoveryCodes } from '../components/AuthCard';
import { ApiError, api, errorMessage } from '../lib/api';
import type { Enrollment } from '../lib/types';

type Stage = 'password' | 'mfa' | 'mfa_enroll' | 'change_password' | 'consent';

interface Details {
  uid: string;
  prompt: string;
  stage: Stage;
  email?: string;
  loginHint?: string;
  client: { id: string; name: string; firstParty: boolean; homepage?: string | null; description?: string };
  scopes: string[];
  permissions?: { scope: string; label: string; description: string }[];
  /** Set when this person may not use the app. */
  blocked?: string | null;
}

interface StepResult {
  done: boolean;
  redirectTo?: string;
  next?: Stage;
  enrollment?: Enrollment;
  recoveryCodes?: string[];
}

/** Sign-in flow for an oidc-provider interaction: password → MFA → password change. */
export function SignInPage() {
  const { uid = '' } = useParams();
  const details = useQuery({
    queryKey: ['interaction', uid],
    queryFn: () => api<Details>(`/interaction/${uid}/details`, { anonymous: true }),
    retry: false,
  });
  const [stage, setStage] = useState<Stage | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [recovery, setRecovery] = useState<{ codes: string[]; then: StepResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const current = stage ?? details.data?.stage ?? null;

  const step = async (path: string, body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<StepResult>(`/interaction/${uid}/${path}`, { body, anonymous: true });
      if (result.recoveryCodes?.length) {
        setRecovery({ codes: result.recoveryCodes, then: result });
        return;
      }
      handle(result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handle = (result: StepResult) => {
    if (result.done && result.redirectTo) {
      window.location.assign(result.redirectTo);
      return;
    }
    if (result.enrollment) setEnrollment(result.enrollment);
    if (result.next) setStage(result.next);
  };

  // Trusted ForgeOffice apps never show a consent screen.
  const autoConsent = current === 'consent' && details.data?.client.firstParty;
  useEffect(() => {
    if (autoConsent) void step('consent', { approve: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConsent]);

  if (details.isLoading || autoConsent) return <PageSpinner />;
  if (details.error) {
    const expired = details.error instanceof ApiError && details.error.status === 410;
    return (
      <AuthCard title={expired ? 'This sign-in link has expired' : 'Something went wrong'}>
        <Alert tone="warning">{expired ? 'Sign-in requests are only valid for a short time.' : errorMessage(details.error)}</Alert>
        <Button variant="primary" className="mt-4 w-full" onClick={() => window.location.assign('/')}>
          Start again
        </Button>
      </AuthCard>
    );
  }

  if (recovery) {
    return (
      <AuthCard title="Save your recovery codes" subtitle="Each code can be used once if you lose access to your authenticator app. Store them somewhere safe.">
        <RecoveryCodes codes={recovery.codes} />
        <div className="mt-4 flex gap-2">
          <Button onClick={() => void navigator.clipboard?.writeText(recovery.codes.join('\n'))}>Copy</Button>
          <Button variant="primary" className="flex-1" onClick={() => handle(recovery.then)}>
            I have saved them — continue
          </Button>
        </div>
      </AuthCard>
    );
  }

  const errorBox = error && (
    <Alert tone="danger" className="mb-4">
      {error}
    </Alert>
  );

  switch (current) {
    case 'mfa':
      return (
        <AuthCard title="Two-step verification" subtitle={details.data?.email}>
          {errorBox}
          <MfaForm busy={busy} onSubmit={(code) => step('mfa', { code })} />
        </AuthCard>
      );
    case 'mfa_enroll':
      return (
        <AuthCard title="Set up two-step verification" subtitle="Your organisation requires an authenticator app for sign-in.">
          {errorBox}
          {enrollment ? (
            <EnrollForm enrollment={enrollment} busy={busy} onSubmit={(code) => step('mfa/enroll', { code })} />
          ) : (
            <Alert tone="warning">The enrolment session was lost. Start sign-in again.</Alert>
          )}
        </AuthCard>
      );
    case 'change_password':
      return (
        <AuthCard title="Choose a new password" subtitle="Your administrator requires you to change your password.">
          {errorBox}
          <NewPasswordForm busy={busy} onSubmit={(newPassword) => step('password', { newPassword })} />
        </AuthCard>
      );
    case 'consent':
      return (
        details.data?.blocked ? (
          <AuthCard title="You can't use this app">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">{details.data.blocked}</p>
            <Button className="mt-6 w-full" disabled={busy} onClick={() => void step('abort', {})}>
              Go back
            </Button>
          </AuthCard>
        ) : (
        <AuthCard title={`${details.data?.client.name} wants to sign you in`}>
          {errorBox}
          {details.data?.client.homepage && (
            <p className="mb-3 text-xs text-zinc-500">
              {new URL(details.data.client.homepage).host}
              {details.data.client.description && ` · ${details.data.client.description}`}
            </p>
          )}
          <p className="text-sm text-zinc-600 dark:text-zinc-400">It will be able to see:</p>
          <ul className="mt-2 space-y-2 text-sm">
            {(details.data?.permissions?.length ? details.data.permissions : (details.data?.scopes ?? []).map((s) => ({ scope: s, label: SCOPE_LABELS[s] ?? s, description: '' }))).map((p) => (
              <li key={p.scope} className="rounded-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-800/60">
                <span className="font-medium">{p.label}</span>
                {p.description && <span className="block text-xs text-zinc-500">{p.description}</span>}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-zinc-500">This app is not part of ForgeOffice. It cannot read your mail, files or calendar. You can remove its access at any time in Account settings.</p>
          <div className="mt-6 flex gap-2">
            <Button className="flex-1" disabled={busy} onClick={() => void step('consent', { approve: false })}>
              Deny
            </Button>
            <Button variant="primary" className="flex-1" loading={busy} onClick={() => void step('consent', { approve: true })}>
              Allow
            </Button>
          </div>
        </AuthCard>
        )
      );
    default:
      return (
        <AuthCard title="Sign in" subtitle="Use your organisation email address.">
          {errorBox}
          <PasswordForm busy={busy} initialEmail={details.data?.loginHint} onSubmit={(email, password) => step('login', { email, password })} />
          <button type="button" className="mt-4 text-sm text-zinc-500 hover:underline" onClick={() => void step('abort', {})}>
            Cancel
          </button>
        </AuthCard>
      );
  }
}

const SCOPE_LABELS: Record<string, string> = {
  openid: 'Confirm your identity',
  profile: 'See your name and profile',
  email: 'See your email address',
  offline_access: 'Stay signed in',
  forge: 'See your organisation and roles',
  api: 'Use ForgeOffice on your behalf',
};

function PasswordForm({ busy, initialEmail, onSubmit }: { busy: boolean; initialEmail?: string; onSubmit: (email: string, password: string) => void }) {
  const [email, setEmail] = useState(initialEmail ?? '');
  const [password, setPassword] = useState('');
  return (
    <form
      className="space-y-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit(email, password);
      }}
    >
      <Field label="Email or username" htmlFor="email">
        <Input id="email" autoComplete="username" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Password" htmlFor="password">
        <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Button type="submit" variant="primary" className="w-full" loading={busy}>
        Sign in
      </Button>
    </form>
  );
}

function MfaForm({ busy, onSubmit }: { busy: boolean; onSubmit: (code: string) => void }) {
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(code);
      }}
    >
      <div className="flex items-center gap-3 rounded-lg bg-zinc-100 p-3 text-sm dark:bg-zinc-800">
        {useRecovery ? <KeyRound className="size-5 shrink-0 text-brand" /> : <Smartphone className="size-5 shrink-0 text-brand" />}
        {useRecovery ? 'Enter one of your one-time recovery codes.' : 'Enter the 6-digit code from your authenticator app.'}
      </div>
      <Field label={useRecovery ? 'Recovery code' : 'Verification code'} htmlFor="code">
        <Input
          id="code"
          autoFocus
          required
          autoComplete="one-time-code"
          inputMode={useRecovery ? 'text' : 'numeric'}
          pattern={useRecovery ? undefined : '[0-9 ]{6,7}'}
          placeholder={useRecovery ? 'xxxxx-xxxxx' : '123 456'}
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </Field>
      <Button type="submit" variant="primary" className="w-full" loading={busy}>
        Verify
      </Button>
      <button
        type="button"
        className="text-sm text-brand hover:underline"
        onClick={() => {
          setUseRecovery((v) => !v);
          setCode('');
        }}
      >
        {useRecovery ? 'Use authenticator app instead' : 'Use a recovery code'}
      </button>
    </form>
  );
}

export function EnrollForm({ enrollment, busy, onSubmit }: { enrollment: Enrollment; busy: boolean; onSubmit: (code: string) => void }) {
  const [code, setCode] = useState('');
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(code);
      }}
    >
      <ol className="list-decimal space-y-1 pl-5 text-sm text-zinc-600 dark:text-zinc-400">
        <li>Open an authenticator app (e.g. Aegis, 2FAS, Google Authenticator).</li>
        <li>Scan the QR code, or enter the key manually.</li>
        <li>Enter the 6-digit code it shows.</li>
      </ol>
      <div className="flex flex-col items-center gap-3 rounded-lg bg-white p-4 ring-1 ring-zinc-200 dark:ring-zinc-800">
        <img src={enrollment.qr} alt="QR code for your authenticator app" className="size-44" />
        <code className="rounded bg-zinc-100 px-2 py-1 text-xs break-all text-zinc-800">{enrollment.secret.match(/.{1,4}/g)?.join(' ')}</code>
      </div>
      <Field label="Verification code" htmlFor="enroll-code">
        <Input id="enroll-code" required autoComplete="one-time-code" inputMode="numeric" pattern="[0-9 ]{6,7}" value={code} onChange={(e) => setCode(e.target.value)} />
      </Field>
      <Button type="submit" variant="primary" className="w-full" loading={busy} icon={<ShieldCheck className="size-4" />}>
        Turn on two-step verification
      </Button>
    </form>
  );
}

export function NewPasswordForm({ busy, onSubmit, submitLabel = 'Change password' }: { busy: boolean; onSubmit: (password: string) => void; submitLabel?: string }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const mismatch = confirm.length > 0 && password !== confirm;
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!mismatch) onSubmit(password);
      }}
    >
      <Field label="New password" htmlFor="new-password" hint="At least 12 characters. A passphrase of several words works well.">
        <Input id="new-password" type="password" autoComplete="new-password" required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Field label="Confirm new password" htmlFor="confirm-password" error={mismatch ? 'Passwords do not match' : undefined}>
        <Input id="confirm-password" type="password" autoComplete="new-password" required invalid={mismatch} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </Field>
      <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={mismatch}>
        {submitLabel}
      </Button>
    </form>
  );
}
