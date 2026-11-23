import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Box, Clock, Database, HardDrive, Pause, Radio, Trash2 } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageHeader,
  PageSpinner,
  ProgressBar,
  StatusDot,
  Table,
  Td,
  Th,
  cn,
  formatBytes,
  formatDateTime,
  formatRelative,
  useToast,
  type Tone,
} from '@forge/ui';
import { useState } from 'react';
import { ConfirmDialog } from '../../components/admin';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/hooks';
import { useSocketConnected, useSocketEvent } from '../../lib/realtime';
import type { AuditEntry, Backup, ServiceState, SystemOverview } from '../../lib/types';

const STATE_TONE: Record<ServiceState, Tone> = { up: 'success', degraded: 'warning', down: 'danger', disabled: 'neutral' };
const STATE_LABEL: Record<ServiceState, string> = { up: 'Healthy', degraded: 'Degraded', down: 'Down', disabled: 'Not configured' };

export function DashboardPage() {
  const qc = useQueryClient();
  const live = useSocketConnected();
  const overview = useQuery({
    queryKey: ['system', 'overview'],
    queryFn: () => api<SystemOverview>('/api/v1/admin/system/overview'),
    // Socket.IO pushes updates every 5 s; poll only as a fallback.
    refetchInterval: live ? false : 15_000,
  });
  useSocketEvent<SystemOverview>('system:overview', (o) => qc.setQueryData(['system', 'overview'], o));

  if (overview.isLoading) return <PageSpinner />;
  if (overview.error) return <Alert tone="danger">{errorMessage(overview.error)}</Alert>;
  const o = overview.data!;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description={`ForgeOffice ${o.version} · API up since ${formatDateTime(o.startedAt)}`}
        actions={
          <span className="flex items-center gap-2 text-sm text-zinc-500">
            <StatusDot tone={live ? 'success' : 'neutral'} pulse={live} />
            {live ? 'Live' : 'Polling'} · updated {formatRelative(o.generatedAt)}
          </span>
        }
      />
      <Services o={o} />
      <div className="grid gap-6 xl:grid-cols-2">
        <Volumes o={o} />
        <Queues o={o} />
      </div>
      {o.containers.enabled && <Containers o={o} />}
      <div className="grid gap-6 xl:grid-cols-2">
        <Backups redisAvailable={o.services.find((s) => s.key === 'redis')?.state === 'up'} />
        <LiveAudit />
      </div>
    </div>
  );
}

function Services({ o }: { o: SystemOverview }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {o.services.map((s) => (
        <Card key={s.key} className="p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-sm font-medium">{s.name}</p>
            <StatusDot tone={STATE_TONE[s.state]} pulse={s.state === 'down'} />
          </div>
          <p className="mt-2 text-lg font-semibold">{STATE_LABEL[s.state]}</p>
          <p className="mt-0.5 truncate text-xs text-zinc-500" title={s.detail}>
            {s.latencyMs !== undefined ? `${s.latencyMs} ms` : s.detail}
          </p>
        </Card>
      ))}
    </div>
  );
}

function Volumes({ o }: { o: SystemOverview }) {
  return (
    <Card>
      <CardHeader
        title="Storage volumes"
        description={o.volumes.scannedAt ? `Content sizes scanned ${formatRelative(o.volumes.scannedAt)}` : 'Filesystem usage via statfs; content scan runs in the worker.'}
      />
      <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {o.volumes.volumes.map((v) => (
          <li key={v.key} className="space-y-2 px-5 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <HardDrive className="size-4 text-zinc-400" /> {v.volume}
                </p>
                <p className="truncate text-xs text-zinc-500">{v.description}</p>
              </div>
              <div className="shrink-0 text-right text-xs text-zinc-500">
                {v.scanned ? (
                  <>
                    <p className="font-medium text-zinc-800 dark:text-zinc-200">{formatBytes(v.scanned.bytes)}</p>
                    <p>{v.scanned.files.toLocaleString()} files</p>
                  </>
                ) : v.mounted ? (
                  'not scanned yet'
                ) : (
                  <Badge tone="danger">Not mounted</Badge>
                )}
              </div>
            </div>
            {v.disk && (
              <div className="space-y-1">
                <ProgressBar value={(v.disk.usedBytes / v.disk.totalBytes) * 100} />
                <p className="text-xs text-zinc-500">
                  Filesystem: {formatBytes(v.disk.usedBytes)} used of {formatBytes(v.disk.totalBytes)} · {formatBytes(v.disk.availableBytes)} free
                </p>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Queues({ o }: { o: SystemOverview }) {
  const upcoming = o.queues
    .flatMap((q) => q.schedules.map((s) => ({ ...s, queue: q.name })))
    .filter((s) => s.next)
    .sort((a, b) => a.next! - b.next!)
    .slice(0, 6);
  const num = (n: number | undefined) => (n === undefined ? '—' : n);
  return (
    <Card>
      <CardHeader title="Job queues" description="Background work done by the worker container (BullMQ on Redis)" />
      <Table>
        <thead>
          <tr>
            <Th>Queue</Th>
            <Th className="text-right">Waiting</Th>
            <Th className="text-right">Active</Th>
            <Th className="text-right" >
              <span title="Waiting to retry, or held until later (not the recurring schedule)">Delayed</span>
            </Th>
            <Th className="text-right">Failed</Th>
            <Th className="hidden text-right sm:table-cell">
              <span title="Recently completed jobs that are kept for inspection">Done</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {o.queues.map((q) => {
            const stuck = q.available && q.workers === 0;
            return (
              <tr key={q.name} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                <Td>
                  <Link to={`/admin/queues/${q.name}`} className="font-medium text-zinc-900 hover:text-brand dark:text-zinc-100">
                    {q.label}
                  </Link>
                  <span className="ml-2 inline-flex gap-1">
                    {q.paused && (
                      <Badge tone="warning">
                        <Pause className="size-3" /> Paused
                      </Badge>
                    )}
                    {!q.available && <Badge tone="danger">Unavailable</Badge>}
                  </span>
                  <span className={cn('mt-0.5 flex items-center gap-1.5 text-xs', stuck ? 'text-red-600' : 'text-zinc-500')} title={q.description}>
                    {q.available && q.workers !== null && <span className={cn('size-1.5 rounded-full', stuck ? 'bg-red-500' : 'bg-emerald-500')} />}
                    {!q.available ? (q.error ?? 'Redis is not reachable') : stuck ? 'No worker running: jobs won’t be processed' : q.workers === null ? q.description : `${q.workers} worker${q.workers === 1 ? '' : 's'}${q.counts?.scheduled ? ` · ${q.counts.scheduled} scheduled` : ''}`}
                  </span>
                </Td>
                <Td className={cn('text-right tabular-nums', stuck && (q.counts?.waiting ?? 0) > 0 && 'font-medium text-red-600')}>{num(q.counts?.waiting)}</Td>
                <Td className="text-right tabular-nums">{num(q.counts?.active)}</Td>
                <Td className="text-right tabular-nums">{num(q.counts?.delayed)}</Td>
                <Td className="text-right tabular-nums">{q.counts?.failed ? <span className="font-medium text-red-600">{q.counts.failed}</span> : num(q.counts?.failed)}</Td>
                <Td className="hidden text-right text-zinc-500 tabular-nums sm:table-cell">{num(q.counts?.completed)}</Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      {upcoming.length > 0 && (
        <CardBody className="border-t border-zinc-100 dark:border-zinc-800">
          <p className="mb-2 text-xs font-medium tracking-wide text-zinc-500 uppercase">Coming up</p>
          <ul className="space-y-1.5 text-sm">
            {upcoming.map((s) => (
              <li key={`${s.queue}:${s.id}`} className="flex items-center gap-2">
                <Clock className="size-3.5 shrink-0 text-zinc-400" />
                <span className="min-w-0 flex-1 truncate">{s.label}</span>
                <span className="shrink-0 text-zinc-500 tabular-nums" title={new Date(s.next!).toLocaleString()}>
                  {untilText(s.next!)}
                </span>
              </li>
            ))}
          </ul>
        </CardBody>
      )}
    </Card>
  );
}

/** "in 3 min", "in 2 h", "tomorrow 03:30". */
function untilText(at: number) {
  const ms = at - Date.now();
  if (ms < 60_000) return 'in under a minute';
  if (ms < 3_600_000) return `in ${Math.round(ms / 60_000)} min`;
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return `today ${time}`;
  if (d.toDateString() === new Date(Date.now() + 86_400_000).toDateString()) return `tomorrow ${time}`;
  return d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function Containers({ o }: { o: SystemOverview }) {
  return (
    <Card>
      <CardHeader title="Containers" description="From the Docker Engine API (read-only)" />
      {o.containers.error ? (
        <CardBody>
          <Alert tone="warning">{o.containers.error}</Alert>
        </CardBody>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Service</Th>
              <Th>Image</Th>
              <Th>State</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {o.containers.items.map((c) => (
              <tr key={c.id}>
                <Td>
                  <span className="flex items-center gap-2 font-medium">
                    <Box className="size-4 text-zinc-400" /> {c.service ?? c.name}
                  </span>
                </Td>
                <Td className="font-mono text-xs">{c.image}</Td>
                <Td>
                  <Badge tone={c.state === 'running' ? (c.health === 'unhealthy' ? 'danger' : 'success') : 'warning'}>{c.health ?? c.state}</Badge>
                </Td>
                <Td className="text-xs text-zinc-500">{c.status}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

const BACKUP_TONE: Record<Backup['status'], Tone> = { queued: 'neutral', running: 'info', completed: 'success', failed: 'danger' };

function Backups({ redisAvailable }: { redisAvailable: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const canManage = useCan('system:manage');
  const [toDelete, setToDelete] = useState<Backup | null>(null);
  const backups = useQuery({
    queryKey: ['system', 'backups'],
    queryFn: () => api<{ items: Backup[]; location: string }>('/api/v1/admin/system/backups'),
    refetchInterval: (q) => (q.state.data?.items.some((b) => b.status === 'queued' || b.status === 'running') ? 3_000 : false),
  });
  useSocketEvent('backup:updated', () => void qc.invalidateQueries({ queryKey: ['system', 'backups'] }));
  const start = useMutation({
    mutationFn: () => api('/api/v1/admin/system/backups', { body: {} }),
    onSuccess: () => {
      toast.success('Backup started');
      void qc.invalidateQueries({ queryKey: ['system', 'backups'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/admin/system/backups/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setToDelete(null);
      void qc.invalidateQueries({ queryKey: ['system', 'backups'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const items = backups.data?.items ?? [];
  return (
    <Card>
      <CardHeader
        title="Backups"
        description={`Database dump and volume archives written to ${backups.data?.location ?? 'forge_backups'}`}
        actions={
          canManage && (
            <Button variant="primary" size="sm" icon={<Archive className="size-4" />} loading={start.isPending} disabled={!redisAvailable} onClick={() => start.mutate()}>
              Back up now
            </Button>
          )
        }
      />
      {!redisAvailable && (
        <CardBody>
          <Alert tone="warning">Backups run in the worker and need Redis.</Alert>
        </CardBody>
      )}
      {items.length === 0 ? (
        <EmptyState icon={<Database />} title="No backups yet" description="Nightly backups run automatically once the worker is running." />
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {items.slice(0, 8).map((b) => (
            <li key={b.id} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-sm">{b.name ?? 'pending…'}</p>
                <p className="text-xs text-zinc-500">
                  {b.trigger === 'manual' ? 'Manual' : 'Scheduled'} · {formatRelative(b.createdAt)}
                  {b.sizeBytes != null && ` · ${formatBytes(b.sizeBytes)}`}
                </p>
                {b.error && <p className="mt-1 truncate text-xs text-red-600" title={b.error}>{b.error}</p>}
              </div>
              <Badge tone={BACKUP_TONE[b.status]}>{b.status}</Badge>
              {canManage && b.status !== 'queued' && b.status !== 'running' && (
                <Button variant="ghost" size="sm" aria-label="Delete backup" onClick={() => setToDelete(b)}>
                  <Trash2 className="size-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog open={!!toDelete} onClose={() => setToDelete(null)} onConfirm={() => toDelete && remove.mutate(toDelete.id)} title="Delete backup?" danger confirmLabel="Delete" busy={remove.isPending}>
        The files for <span className="font-mono">{toDelete?.name}</span> will be removed from the backups volume.
      </ConfirmDialog>
    </Card>
  );
}

function LiveAudit() {
  const canRead = useCan('audit:read');
  const qc = useQueryClient();
  const recent = useQuery({
    queryKey: ['audit', 'recent'],
    queryFn: () => api<{ items: AuditEntry[] }>('/api/v1/admin/audit?limit=10'),
    enabled: canRead,
  });
  useSocketEvent<AuditEntry>(
    'audit:created',
    (e) =>
      qc.setQueryData<{ items: AuditEntry[] }>(['audit', 'recent'], (old) => ({
        items: [{ ...e, metadata: {}, targetLabel: null, targetType: null, targetId: null, ip: null, userAgent: null, actorId: null } as AuditEntry, ...(old?.items ?? [])].slice(0, 10),
      })),
    canRead,
  );
  if (!canRead) return null;
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Radio className="size-4 text-brand" /> Live activity
          </span>
        }
        actions={
          <Link to="/admin/organisation/audit" className="text-sm text-brand hover:underline">
            Full audit log
          </Link>
        }
      />
      <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {recent.data?.items.map((e) => (
          <li key={e.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
            <StatusDot tone={e.outcome === 'success' ? 'success' : 'danger'} />
            <span className="font-mono text-xs">{e.action}</span>
            <span className="min-w-0 flex-1 truncate text-zinc-500">{e.actorLabel ?? 'system'}</span>
            <span className="shrink-0 text-xs text-zinc-400">{formatRelative(e.createdAt)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
