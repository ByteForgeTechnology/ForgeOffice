import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleDashed, XCircle } from 'lucide-react';
import { Badge, Button, Card, CardBody, CardHeader, Field, Input, PageHeader, PageSpinner, Switch, Table, Td, Th, formatBytes, formatRelative, useToast } from '@forge/ui';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/hooks';

interface DriveSettings {
  trashDays: number;
  maxUploadMb: number;
  externalSharing: boolean;
  linkMaxDays: number | null;
}
interface ServiceStatus {
  configured: boolean;
  ok: boolean;
  detail: string;
}

function StatusRow({ name, status, help }: { name: string; status: ServiceStatus; help: string }) {
  const Icon = !status.configured ? CircleDashed : status.ok ? CheckCircle2 : XCircle;
  return (
    <div className="flex items-start gap-3">
      <Icon className={`mt-0.5 size-5 shrink-0 ${!status.configured ? 'text-zinc-400' : status.ok ? 'text-emerald-600' : 'text-red-600'}`} />
      <div className="min-w-0">
        <p className="font-medium">
          {name} <span className="font-normal text-zinc-500">· {!status.configured ? 'off' : status.ok ? 'working' : 'not reachable'}</span>
        </p>
        <p className="truncate text-sm text-zinc-500">{status.detail}</p>
        {!status.configured && <p className="text-sm text-zinc-500">{help}</p>}
      </div>
    </div>
  );
}

/** Admin → ForgeDrive → Settings: recycle bin, upload size, sharing policy, service status. */
export function DriveSettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const canManage = useCan('org:manage');
  const q = useQuery({ queryKey: ['admin', 'drive', 'settings'], queryFn: () => api<{ settings: DriveSettings; status: { antivirus: ServiceStatus; office: ServiceStatus }; totals: { libraries: number; bytes: number } }>('/api/v1/admin/drive/settings') });
  const [f, setF] = useState<DriveSettings | null>(null);
  useEffect(() => {
    if (q.data && !f) setF(q.data.settings);
  }, [q.data, f]);
  const save = useMutation({
    mutationFn: () => api('/api/v1/admin/drive/settings', { method: 'PUT', body: f }),
    onSuccess: () => {
      toast.success('Drive settings saved');
      void qc.invalidateQueries({ queryKey: ['admin', 'drive'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!q.data || !f) return <PageSpinner />;
  const { status, totals } = q.data;
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Drive settings" description="Organisation-wide settings for ForgeDrive and ForgeSites." />
      <Card>
        <CardHeader title="Services" />
        <CardBody className="space-y-4">
          <StatusRow name="Virus scanning (ClamAV)" status={status.antivirus} help="Start the stack with the “av” profile and set FORGE_CLAMAV=clamav:3310 to scan every upload." />
          <StatusRow name="Office editing (Euro-Office)" status={status.office} help="Start the stack with the “office” profile and set FORGE_OFFICE_URL to edit documents in the browser." />
          <p className="text-sm text-zinc-500">
            {totals.libraries} libraries using {formatBytes(totals.bytes)} (before de-duplication).
          </p>
        </CardBody>
      </Card>
      <form
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <fieldset disabled={!canManage} className="space-y-6">
          <Card>
            <CardHeader title="Files" />
            <CardBody className="grid gap-4 sm:grid-cols-2">
              <Field label="Keep deleted files for (days)" htmlFor="d-trash" hint="Items in the recycle bin are deleted for good after this.">
                <Input id="d-trash" type="number" min={1} max={3650} value={f.trashDays} onChange={(e) => setF({ ...f, trashDays: Number(e.target.value) })} />
              </Field>
              <Field label="Largest upload (MB)" htmlFor="d-max" hint="Per file. Uploads resume if the connection drops.">
                <Input id="d-max" type="number" min={1} max={102400} value={f.maxUploadMb} onChange={(e) => setF({ ...f, maxUploadMb: Number(e.target.value) })} />
              </Field>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Sharing links" />
            <CardBody className="space-y-4">
              <Switch checked={f.externalSharing} onChange={(v) => setF({ ...f, externalSharing: v })} label="Allow links anyone can open" description="When off, people can still share with colleagues, and existing links stop working." />
              <Field label="Links must expire within (days)" htmlFor="d-link" hint="Leave empty to allow links that never expire.">
                <Input id="d-link" type="number" min={1} max={3650} value={f.linkMaxDays ?? ''} onChange={(e) => setF({ ...f, linkMaxDays: e.target.value ? Number(e.target.value) : null })} />
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

interface LibraryRow {
  id: string;
  kind: 'personal' | 'group' | 'site';
  name: string;
  usedBytes: number;
  owner: string | null;
  group: string | null;
  site: string | null;
  items: number;
  createdAt: string;
}

const KIND_LABEL = { personal: 'Personal', group: 'Team', site: 'Site' } as const;

/** Admin → ForgeDrive → Libraries: every library and how much it stores (never its contents). */
export function DriveLibrariesPage() {
  const [filter, setFilter] = useState('');
  const q = useQuery({ queryKey: ['admin', 'drive', 'libraries'], queryFn: () => api<{ items: LibraryRow[] }>('/api/v1/admin/drive/libraries') });
  const rows = (q.data?.items ?? []).filter((r) => !filter || `${r.name} ${r.owner ?? ''} ${r.group ?? ''} ${r.site ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="space-y-6">
      <PageHeader title="Libraries" description="Document libraries: one per person, team and site. Admins see sizes, not files." />
      <Input aria-label="Filter libraries" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} className="max-w-xs" />
      {!q.data ? (
        <PageSpinner />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Library</Th>
                <Th>Type</Th>
                <Th className="hidden md:table-cell">Belongs to</Th>
                <Th className="text-right">Items</Th>
                <Th className="text-right">Size</Th>
                <Th className="hidden sm:table-cell">Created</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td className="font-medium">{r.name}</Td>
                  <Td>
                    <Badge>{KIND_LABEL[r.kind]}</Badge>
                  </Td>
                  <Td className="hidden md:table-cell">{r.site ?? r.group ?? r.owner ?? '—'}</Td>
                  <Td className="text-right tabular-nums">{r.items}</Td>
                  <Td className="text-right tabular-nums">{formatBytes(Number(r.usedBytes))}</Td>
                  <Td className="hidden sm:table-cell">{formatRelative(r.createdAt)}</Td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <Td className="text-zinc-500">No libraries.</Td>
                </tr>
              )}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
