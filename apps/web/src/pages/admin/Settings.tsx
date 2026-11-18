import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ImageUp, Trash2 } from 'lucide-react';
import { Button, Card, CardBody, CardHeader, Field, Input, PageHeader, PageSpinner, Select, Switch, useToast } from '@forge/ui';
import { api, errorMessage } from '../../lib/api';
import { readFileAsDataUrl, useBranding, useCan } from '../../lib/hooks';
import type { Org } from '../../lib/types';

const GiB = 1024 ** 3;

export function SettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const canManage = useCan('org:manage');
  const { data: branding } = useBranding();
  const org = useQuery({ queryKey: ['admin', 'org'], queryFn: () => api<{ org: Org }>('/api/v1/admin/org') });
  const tz = useQuery({ queryKey: ['setup-status'], queryFn: () => api<{ timezones: string[] }>('/api/v1/setup/status', { anonymous: true }) });
  const [f, setF] = useState<{ name: string; timezone: string; locale: string; brandColor: string; quotaGb: number; requireMfa: boolean } | null>(null);
  useEffect(() => {
    const o = org.data?.org;
    if (o) setF({ name: o.name, timezone: o.timezone, locale: o.locale, brandColor: o.brandColor, quotaGb: Math.round((o.defaultQuotaBytes / GiB) * 10) / 10, requireMfa: o.requireMfa });
  }, [org.data]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['admin', 'org'] });
    void qc.invalidateQueries({ queryKey: ['branding'] });
    void qc.invalidateQueries({ queryKey: ['me'] });
  };
  const save = useMutation({
    mutationFn: () =>
      api('/api/v1/admin/org', {
        method: 'PATCH',
        body: { name: f!.name, timezone: f!.timezone, locale: f!.locale, brandColor: f!.brandColor, defaultQuotaBytes: Math.round(f!.quotaGb * GiB), requireMfa: f!.requireMfa },
      }),
    onSuccess: () => {
      toast.success('Settings saved');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const logo = useMutation({
    mutationFn: (dataUrl: string | null) => (dataUrl ? api('/api/v1/admin/org/logo', { method: 'PUT', body: { dataUrl } }) : api('/api/v1/admin/org/logo', { method: 'DELETE' })),
    onSuccess: () => {
      toast.success('Logo updated');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (!f) return <PageSpinner />;
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF({ ...f, [k]: v });

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Organisation" description="Name, branding and organisation-wide policies." />
      <form
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <fieldset disabled={!canManage} className="space-y-6">
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
            <CardHeader title="Policies" />
            <CardBody className="space-y-5">
              <Switch
                checked={f.requireMfa}
                onChange={(v) => set('requireMfa', v)}
                label="Require two-step verification for everyone"
                description="Users without an authenticator app must enrol at their next sign-in."
              />
              <Field label="Default storage quota per user (GB)" htmlFor="o-quota" hint="Users with a custom quota are not affected.">
                <Input id="o-quota" type="number" min={0} step={0.5} value={f.quotaGb} onChange={(e) => set('quotaGb', Number(e.target.value))} className="w-40" />
              </Field>
            </CardBody>
          </Card>
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
