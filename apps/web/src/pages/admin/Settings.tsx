import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleX, ImageUp, PlugZap, Send, Trash2 } from 'lucide-react';
import { Alert, Button, Card, CardBody, CardHeader, Field, Input, PageHeader, PageSpinner, Select, Switch, Textarea, useToast } from '@forge/ui';
import { api, errorMessage } from '../../lib/api';
import { readFileAsDataUrl, useBranding, useCan } from '../../lib/hooks';
import type { Org } from '../../lib/types';

const GiB = 1024 ** 3;

/**
 * Load organisation settings into a form and save only the fields one page
 * owns, so each product section (Organisation, ForgeDirectory, ForgeMail)
 * edits its own settings.
 */
function useOrgForm<T extends object>(fromOrg: (o: Org) => T, toBody: (f: T) => Record<string, unknown>) {
  const qc = useQueryClient();
  const toast = useToast();
  const org = useQuery({ queryKey: ['admin', 'org'], queryFn: () => api<{ org: Org }>('/api/v1/admin/org') });
  const [f, setF] = useState<T | null>(null);
  useEffect(() => {
    if (org.data?.org) setF(fromOrg(org.data.org));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org.data]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['admin', 'org'] });
    void qc.invalidateQueries({ queryKey: ['branding'] });
    void qc.invalidateQueries({ queryKey: ['me'] });
  };
  const save = useMutation({
    mutationFn: () => api('/api/v1/admin/org', { method: 'PATCH', body: toBody(f!) }),
    onSuccess: () => {
      toast.success('Settings saved');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const set = <K extends keyof T>(k: K, v: T[K]) => setF((x) => (x ? { ...x, [k]: v } : x));
  return { f, set, save, refresh };
}

function SettingsForm({ title, description, save, children }: { title: string; description: string; save: { mutate: () => void; isPending: boolean }; children: ReactNode }) {
  const canManage = useCan('org:manage');
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title={title} description={description} />
      <form
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <fieldset disabled={!canManage} className="space-y-6">
          {children}
        </fieldset>
        {canManage && (
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save settings
          </Button>
        )}
      </form>
    </div>
  );
}

/** Organisation → Settings: name, locale, branding and storage. */
export function SettingsPage() {
  const toast = useToast();
  const { data: branding } = useBranding();
  const tz = useQuery({ queryKey: ['setup-status'], queryFn: () => api<{ timezones: string[] }>('/api/v1/setup/status', { anonymous: true }) });
  const { f, set, save, refresh } = useOrgForm(
    (o) => ({ name: o.name, timezone: o.timezone, locale: o.locale, brandColor: o.brandColor, quotaGb: Math.round((o.defaultQuotaBytes / GiB) * 10) / 10 }),
    (x) => ({ name: x.name, timezone: x.timezone, locale: x.locale, brandColor: x.brandColor, defaultQuotaBytes: Math.round(x.quotaGb * GiB) }),
  );
  const logo = useMutation({
    mutationFn: (dataUrl: string | null) => (dataUrl ? api('/api/v1/admin/org/logo', { method: 'PUT', body: { dataUrl } }) : api('/api/v1/admin/org/logo', { method: 'DELETE' })),
    onSuccess: () => {
      toast.success('Logo updated');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!f) return <PageSpinner />;

  return (
    <SettingsForm title="Organisation settings" description="Name, regional settings, branding and storage, shared by every ForgeOffice app." save={save}>
      <Card>
        <CardHeader title="General" />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label="Organisation name" htmlFor="o-name" className="sm:col-span-2">
            <Input id="o-name" value={f.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="Default time zone" htmlFor="o-tz">
            <Select id="o-tz" value={f.timezone} onChange={(e) => set('timezone', e.target.value)}>
              {tz.data?.timezones.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
          </Field>
          <Field label="Locale" htmlFor="o-locale" hint="BCP 47 tag, e.g. en-GB">
            <Input id="o-locale" value={f.locale} onChange={(e) => set('locale', e.target.value)} />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Branding" />
        <CardBody className="space-y-5">
          <Field label="Accent colour" htmlFor="o-color">
            <div className="flex items-center gap-3">
              <input id="o-color" type="color" value={f.brandColor} onChange={(e) => set('brandColor', e.target.value)} className="h-10 w-14 cursor-pointer rounded border-0 bg-transparent" />
              <Input value={f.brandColor} onChange={(e) => set('brandColor', e.target.value)} className="w-32 font-mono" aria-label="Hex colour" />
            </div>
          </Field>
          <Field label="Logo" hint="PNG, JPEG or WebP, up to 512 KB.">
            <div className="flex flex-wrap items-center gap-3">
              {branding?.logoUrl ? (
                <img src={branding.logoUrl} alt="Current logo" className="size-14 rounded-lg object-contain ring-1 ring-zinc-200 dark:ring-zinc-700" />
              ) : (
                <span className="flex size-14 items-center justify-center rounded-lg bg-zinc-100 text-xs text-zinc-400 dark:bg-zinc-800">None</span>
              )}
              <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg px-3 text-sm font-medium ring-1 ring-zinc-300 hover:bg-zinc-50 dark:ring-zinc-700 dark:hover:bg-zinc-800">
                <ImageUp className="size-4" /> Upload
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="sr-only"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (!file) return;
                    if (file.size > 512 * 1024) return toast.error('Logo must be smaller than 512 KB');
                    logo.mutate(await readFileAsDataUrl(file));
                  }}
                />
              </label>
              {branding?.logoUrl && (
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => logo.mutate(null)}>
                  Remove
                </Button>
              )}
            </div>
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Storage" />
        <CardBody>
          <Field label="Default storage quota per person (GB)" htmlFor="o-quota" hint="Covers mail and, later, files. People with a custom quota are not affected.">
            <Input id="o-quota" type="number" min={0} step={0.5} value={f.quotaGb} onChange={(e) => set('quotaGb', Number(e.target.value))} className="w-40" />
          </Field>
        </CardBody>
      </Card>
    </SettingsForm>
  );
}

interface Smarthost {
  enabled: boolean;
  host: string;
  port: number;
  security: 'starttls' | 'tls' | 'none';
  username: string | null;
  hasPassword: boolean;
  domains: string[];
  environmentRelay: boolean;
  hostname: string;
}

const PORT_FOR: Record<Smarthost['security'], number> = { starttls: 587, tls: 465, none: 25 };

/** Outgoing smarthost: hand outside mail to a provider's relay (Microsoft 365, Google, SendGrid, Mailgun, your ISP…). */
function SmarthostCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const canManage = useCan('org:manage');
  const current = useQuery({ queryKey: ['admin', 'smarthost'], queryFn: () => api<Smarthost>('/api/v1/admin/mail/smarthost') });
  const [f, setF] = useState<(Smarthost & { password: string; domainText: string }) | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [sendTo, setSendTo] = useState('');
  useEffect(() => {
    if (current.data) setF({ ...current.data, password: '', domainText: current.data.domains.join('\n') });
  }, [current.data]);

  const body = () => ({
    enabled: f!.enabled,
    host: f!.host.trim(),
    port: f!.port,
    security: f!.security,
    username: f!.username?.trim() || null,
    // Blank keeps the saved password.
    ...(f!.password ? { password: f!.password } : {}),
    domains: f!.domainText.split(/[\s,]+/).filter(Boolean),
  });
  const save = useMutation({
    mutationFn: () => api<Smarthost>('/api/v1/admin/mail/smarthost', { method: 'PUT', body: body() }),
    onSuccess: (r) => {
      toast.success(r.enabled ? `Outside mail now goes through ${r.host}` : 'Smarthost settings saved');
      void qc.invalidateQueries({ queryKey: ['admin', 'smarthost'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const test = useMutation({
    mutationFn: (withMessage: boolean) => api<{ ok: boolean; message: string }>('/api/v1/admin/mail/smarthost/test', { body: { ...body(), ...(withMessage ? { sendTo } : {}) } }),
    onSuccess: setResult,
    onError: (e) => setResult({ ok: false, message: errorMessage(e) }),
  });
  if (!f) return <PageSpinner />;
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => {
    setResult(null);
    setF({ ...f, [k]: v });
  };

  return (
    <Card>
      <CardHeader
        title="Outgoing smarthost (SMTP relay)"
        description="Send mail for other organisations through your provider's relay instead of delivering it directly. Useful when your network blocks port 25, or to use a sending service with a good reputation. Mail between your own people is never relayed."
      />
      <CardBody>
        <fieldset disabled={!canManage} className="space-y-4">
          <Switch checked={f.enabled} onChange={(v) => set('enabled', v)} label="Use a smarthost" description={f.enabled ? undefined : f.environmentRelay ? 'Off: outside mail uses the relay set in FORGE_SMTP_RELAY.' : 'Off: outside mail is delivered directly to each domain’s mail server.'} />
          <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
            <Field label="Host" htmlFor="sh-host">
              <Input id="sh-host" value={f.host} onChange={(e) => set('host', e.target.value)} placeholder="smtp.example.com" autoComplete="off" />
            </Field>
            <Field label="Port" htmlFor="sh-port">
              <Input id="sh-port" type="number" min={1} max={65535} value={f.port} onChange={(e) => set('port', Number(e.target.value))} />
            </Field>
          </div>
          <Field label="Security" htmlFor="sh-sec">
            <Select id="sh-sec" value={f.security} onChange={(e) => {
              const security = e.target.value as Smarthost['security'];
              setResult(null);
              setF({ ...f, security, port: f.port === PORT_FOR[f.security] ? PORT_FOR[security] : f.port });
            }}>
              <option value="starttls">STARTTLS, required (usually port 587)</option>
              <option value="tls">TLS from the start (usually port 465)</option>
              <option value="none">None (only for a relay on a trusted private network)</option>
            </Select>
          </Field>
          {f.security === 'none' && f.username && <Alert tone="warning">Without encryption the password is sent in plain text. Use STARTTLS or TLS unless the relay is on your own private network.</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Username (optional)" htmlFor="sh-user" hint="Leave empty if the relay accepts mail from this server's IP address.">
              <Input id="sh-user" value={f.username ?? ''} onChange={(e) => set('username', e.target.value)} autoComplete="off" />
            </Field>
            <Field label="Password" htmlFor="sh-pass" hint={f.hasPassword ? 'Saved. Leave empty to keep it.' : undefined}>
              <Input id="sh-pass" type="password" value={f.password} onChange={(e) => set('password', e.target.value)} placeholder={f.hasPassword ? '••••••••' : ''} autoComplete="new-password" />
            </Field>
          </div>
          <Field label="Only for these domains (optional)" htmlFor="sh-domains" hint="One per line; includes subdomains. Leave empty to relay all outside mail. Other domains are delivered directly.">
            <Textarea id="sh-domains" rows={2} className="font-mono text-xs" value={f.domainText} onChange={(e) => set('domainText', e.target.value)} placeholder="gmail.com" />
          </Field>

          {result && (
            <Alert tone={result.ok ? 'success' : 'danger'}>
              <span className="flex items-start gap-2">
                {result.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0" /> : <CircleX className="mt-0.5 size-4 shrink-0" />} {result.message}
              </span>
            </Alert>
          )}
          {canManage && (
            <div className="space-y-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
              <div className="flex flex-wrap gap-2">
                <Button icon={<PlugZap className="size-4" />} loading={test.isPending && test.variables === false} disabled={!f.host.trim()} onClick={() => test.mutate(false)}>
                  Test connection
                </Button>
                <div className="flex min-w-64 flex-1 gap-2">
                  <Input aria-label="Send a test message to" type="email" placeholder="Send a test message to…" value={sendTo} onChange={(e) => setSendTo(e.target.value)} />
                  <Button icon={<Send className="size-4" />} loading={test.isPending && test.variables === true} disabled={!f.host.trim() || !sendTo} onClick={() => test.mutate(true)}>
                    Send
                  </Button>
                </div>
              </div>
              <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
                Save smarthost
              </Button>
            </div>
          )}
          <p className="text-xs text-zinc-500">
            Tip: many providers only accept mail from addresses or domains you have verified with them. Keep SPF for your domains up to date to include the relay, and check DKIM still passes in Domains → Mail setup.
          </p>
        </fieldset>
      </CardBody>
    </Card>
  );
}

/** ForgeDirectory → Sign-in & security. */
export function DirectorySecurityPage() {
  const { f, set, save } = useOrgForm(
    (o) => ({ requireMfa: o.requireMfa }),
    (x) => ({ requireMfa: x.requireMfa }),
  );
  if (!f) return <PageSpinner />;
  return (
    <SettingsForm title="Sign-in & security" description="How people sign in to ForgeOffice and to mail, calendar and contacts apps." save={save}>
      <Card>
        <CardHeader title="Two-step verification" />
        <CardBody className="space-y-4">
          <Switch
            checked={f.requireMfa}
            onChange={(v) => set('requireMfa', v)}
            label="Require two-step verification for everyone"
            description="People without an authenticator app must set one up at their next sign-in. Desktop and phone mail apps then need app passwords."
          />
          <p className="text-sm text-zinc-500">You can also require it for individual people from their page under Users.</p>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Passwords" />
        <CardBody className="text-sm text-zinc-600 dark:text-zinc-400">
          Passwords must be at least 12 characters and must not contain the person's name or username. After 5 failed sign-ins in a row, an account is locked for 15 minutes; administrators can unlock it sooner from the person's page.
        </CardBody>
      </Card>
    </SettingsForm>
  );
}

/** ForgeMail → Settings. */
export function MailOrgSettingsPage() {
  const { f, set, save } = useOrgForm(
    (o) => ({ undoSendSeconds: o.undoSendSeconds, maxMb: Math.round(o.mailMaxMessageBytes / 1048576) }),
    (x) => ({ undoSendSeconds: x.undoSendSeconds, mailMaxMessageBytes: x.maxMb * 1048576 }),
  );
  if (!f) return <PageSpinner />;
  return (
    <div className="max-w-3xl space-y-6">
    <SettingsForm title="Mail settings" description="Organisation-wide settings for ForgeMail." save={save}>
      <Card>
        <CardHeader title="Sending" />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label="Undo send window (seconds)" htmlFor="o-undo" hint="How long webmail holds a sent message so it can be undone. 0 sends immediately.">
            <Input id="o-undo" type="number" min={0} max={60} value={f.undoSendSeconds} onChange={(e) => set('undoSendSeconds', Number(e.target.value))} />
          </Field>
          <Field label="Maximum message size (MB)" htmlFor="o-max" hint="Applies to incoming and outgoing mail, including attachments.">
            <Input id="o-max" type="number" min={1} max={150} value={f.maxMb} onChange={(e) => set('maxMb', Number(e.target.value))} />
          </Field>
        </CardBody>
      </Card>
    </SettingsForm>
    <SmarthostCard />
    </div>
  );
}
