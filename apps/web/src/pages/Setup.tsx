import { useMemo, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Check, Globe, KeyRound, Palette, ShieldCheck, UserRound } from 'lucide-react';
import { Alert, Button, Field, Input, PageSpinner, Select, Switch, cn } from '@forge/ui';
import { AuthCard } from '../components/AuthCard';
import { api, errorMessage } from '../lib/api';
import { signInRedirect } from '../lib/auth';
import { readFileAsDataUrl, useBranding } from '../lib/hooks';

const STEPS = [
  { key: 'token', label: 'Verify', icon: KeyRound },
  { key: 'org', label: 'Organisation', icon: Building2 },
  { key: 'domain', label: 'Domain', icon: Globe },
  { key: 'brand', label: 'Branding', icon: Palette },
  { key: 'policy', label: 'Policies', icon: ShieldCheck },
  { key: 'admin', label: 'Administrator', icon: UserRound },
] as const;

const GiB = 1024 ** 3;

export function SetupPage() {
  const queryClient = useQueryClient();
  const { data: branding } = useBranding();
  const status = useQuery({
    queryKey: ['setup-status'],
    queryFn: () => api<{ needsSetup: boolean; timezones: string[]; passwordMinLength: number }>('/api/v1/setup/status', { anonymous: true }),
  });
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [form, setForm] = useState({
    setupToken: '',
    orgName: '',
    timezone: browserTz || 'UTC',
    domain: '',
    brandColor: '#4f46e5',
    logoDataUrl: '' as string,
    quotaGb: 50,
    requireMfa: true,
    username: 'admin',
    displayName: '',
    password: '',
    confirm: '',
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const valid = useMemo(() => {
    const domainOk = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/i.test(form.domain.trim());
    return [
      form.setupToken.trim().length > 0,
      form.orgName.trim().length > 0 && !!form.timezone,
      domainOk,
      /^#[0-9a-f]{6}$/i.test(form.brandColor),
      form.quotaGb >= 0,
      /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(form.username) && form.displayName.trim().length > 0 && form.password.length >= 12 && form.password === form.confirm,
    ];
  }, [form]);

  if (status.isLoading) return <PageSpinner />;
  if (status.data && !status.data.needsSetup && !done) return <Navigate to="/" replace />;

  if (done) {
    return (
      <AuthCard title="ForgeOffice is ready" subtitle="Your organisation and administrator account have been created.">
        <div className="space-y-4">
          <Alert tone="success" title="Sign in as">
            <span className="font-mono">{done}</span>
          </Alert>
          {form.requireMfa && <p className="text-sm text-zinc-600 dark:text-zinc-400">You will be asked to set up an authenticator app when you first sign in.</p>}
          <Button variant="primary" className="w-full" onClick={() => void signInRedirect('/admin')}>
            Sign in to the admin center
          </Button>
        </div>
      </AuthCard>
    );
  }

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ adminEmail: string }>('/api/v1/setup', {
        anonymous: true,
        body: {
          setupToken: form.setupToken.trim(),
          organization: {
            name: form.orgName.trim(),
            timezone: form.timezone,
            locale: navigator.language,
            brandColor: form.brandColor,
            defaultQuotaBytes: Math.round(form.quotaGb * GiB),
            requireMfa: form.requireMfa,
            ...(form.logoDataUrl ? { logoDataUrl: form.logoDataUrl } : {}),
          },
          domain: form.domain.trim(),
          admin: { username: form.username, displayName: form.displayName.trim(), password: form.password },
        },
      });
      await queryClient.invalidateQueries({ queryKey: ['branding'] });
      setDone(res.adminEmail);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const last = step === STEPS.length - 1;
  const pane: Record<(typeof STEPS)[number]['key'], ReactNode> = {
    token: (
      <div className="space-y-4">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          To prove you control this server, enter the one-time setup token. It is printed in the API container logs (<code className="text-xs">docker compose logs api</code>) and stored in the
          <code className="text-xs"> forge_certs</code> volume as <code className="text-xs">setup-token</code>.
        </p>
        <Field label="Setup token" htmlFor="token">
          <Input id="token" autoFocus autoComplete="off" value={form.setupToken} onChange={(e) => set('setupToken', e.target.value)} />
        </Field>
      </div>
    ),
    org: (
      <div className="space-y-4">
        <Field label="Organisation name" htmlFor="org">
          <Input id="org" autoFocus value={form.orgName} onChange={(e) => set('orgName', e.target.value)} placeholder="Acme Ltd" />
        </Field>
        <Field label="Default time zone" htmlFor="tz">
          <Select id="tz" value={form.timezone} onChange={(e) => set('timezone', e.target.value)}>
            {status.data?.timezones.map((tz) => (
              <option key={tz}>{tz}</option>
            ))}
          </Select>
        </Field>
      </div>
    ),
    domain: (
      <div className="space-y-4">
        <Field label="Primary email domain" htmlFor="domain" hint="Addresses will look like name@this-domain. You can verify it and add more domains later.">
          <Input id="domain" autoFocus value={form.domain} onChange={(e) => set('domain', e.target.value.toLowerCase())} placeholder="example.com" />
        </Field>
      </div>
    ),
    brand: (
      <div className="space-y-5">
        <Field label="Accent colour" htmlFor="color">
          <div className="flex items-center gap-3">
            <input id="color" type="color" value={form.brandColor} onChange={(e) => set('brandColor', e.target.value)} className="h-10 w-14 cursor-pointer rounded border-0 bg-transparent" />
            <Input value={form.brandColor} onChange={(e) => set('brandColor', e.target.value)} className="w-32 font-mono" />
            <span className="h-10 flex-1 rounded-lg" style={{ background: form.brandColor }} />
          </div>
        </Field>
        <Field label="Logo (optional)" hint="PNG, JPEG or WebP, up to 512 KB. Square images look best.">
          <div className="flex items-center gap-3">
            {form.logoDataUrl && <img src={form.logoDataUrl} alt="" className="size-12 rounded-lg object-contain ring-1 ring-zinc-200" />}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="text-sm"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (file.size > 512 * 1024) return setError('Logo must be smaller than 512 KB');
                set('logoDataUrl', await readFileAsDataUrl(file));
              }}
            />
          </div>
        </Field>
      </div>
    ),
    policy: (
      <div className="space-y-5">
        <Field label="Default storage quota per user (GB)" htmlFor="quota" hint="Applies to mail, drive and team storage. Can be overridden per user.">
          <Input id="quota" type="number" min={0} step={1} value={form.quotaGb} onChange={(e) => set('quotaGb', Number(e.target.value))} className="w-40" />
        </Field>
        <Switch
          checked={form.requireMfa}
          onChange={(v) => set('requireMfa', v)}
          label="Require two-step verification for everyone"
          description="Users enrol an authenticator app (TOTP) at their next sign-in. Strongly recommended."
        />
      </div>
    ),
    admin: (
      <div className="space-y-4">
        <Field label="Display name" htmlFor="dn">
          <Input id="dn" autoFocus value={form.displayName} onChange={(e) => set('displayName', e.target.value)} placeholder="Ada Lovelace" />
        </Field>
        <Field
          label="Username"
          htmlFor="un"
          hint={`Sign-in address: ${form.username || '…'}@${form.domain || 'your-domain'}`}
          error={form.username && !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(form.username) ? 'Use lower-case letters, digits, ".", "_" or "-", starting and ending with a letter or digit.' : undefined}
        >
          <Input id="un" value={form.username} onChange={(e) => set('username', e.target.value.toLowerCase())} />
        </Field>
        <Field
          label="Password"
          htmlFor="pw"
          hint="At least 12 characters."
          error={form.password.length > 0 && form.password.length < 12 ? `At least 12 characters (${form.password.length} so far).` : undefined}
        >
          <Input id="pw" type="password" autoComplete="new-password" invalid={form.password.length > 0 && form.password.length < 12} value={form.password} onChange={(e) => set('password', e.target.value)} />
        </Field>
        <Field label="Confirm password" htmlFor="pw2" error={form.confirm && form.confirm !== form.password ? 'Passwords do not match' : undefined}>
          <Input id="pw2" type="password" autoComplete="new-password" value={form.confirm} onChange={(e) => set('confirm', e.target.value)} />
        </Field>
      </div>
    ),
  };

  return (
    <AuthCard wide title={`Set up ${branding?.name && branding.name !== 'ForgeOffice' ? branding.name : 'ForgeOffice'}`} subtitle="Create your organisation and the first administrator.">
      <ol className="mb-6 flex flex-wrap gap-1.5" aria-label="Setup progress">
        {STEPS.map((s, i) => (
          <li key={s.key}>
            <button
              type="button"
              disabled={i > step && !valid.slice(0, i).every(Boolean)}
              onClick={() => setStep(i)}
              aria-current={i === step ? 'step' : undefined}
              className={cn(
                'flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset disabled:opacity-40',
                i === step ? 'bg-brand text-white ring-brand' : i < step ? 'text-brand ring-brand/40' : 'text-zinc-500 ring-zinc-300 dark:ring-zinc-700',
              )}
            >
              {i < step ? <Check className="size-3" /> : <s.icon className="size-3" />}
              {s.label}
            </button>
          </li>
        ))}
      </ol>
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid[step]) return;
          if (last) void submit();
          else setStep(step + 1);
        }}
      >
        {pane[STEPS[step]!.key]}
        <div className="mt-8 flex justify-between gap-2">
          <Button disabled={step === 0} onClick={() => setStep(step - 1)}>
            Back
          </Button>
          <Button type="submit" variant="primary" disabled={!valid[step]} loading={busy}>
            {last ? 'Create organisation' : 'Continue'}
          </Button>
        </div>
      </form>
    </AuthCard>
  );
}
