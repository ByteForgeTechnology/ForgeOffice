import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleSlash, HardDrive, LogOut, RotateCcw, Trash2, Video } from 'lucide-react';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, PageHeader, PageSpinner, ProgressBar, Table, Td, Th, formatBytes, formatRelative, useToast } from '@forge/ui';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/hooks';

interface ClusterInfo {
  storage: {
    mode: 'local' | 'cluster' | 'mail-store';
    replicas: number;
    underReplicated: number;
    nodes: { id: string; url: string | null; online: boolean; draining: boolean; namespaces: string[]; freeBytes: number; totalBytes: number; blobs: Record<string, number> }[];
  };
  media: { id: string; address: string | null; meetings: number; people: number; seenAt: number }[];
}

const NS_LABEL: Record<string, string> = { mail: 'Mail', drive: 'Drive', team: 'Recordings' };

/** Admin → Organisation → Servers & storage: storage nodes and media servers across machines. */
export function ClusterPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const canManage = useCan('system:manage');
  const q = useQuery({ queryKey: ['admin', 'cluster'], queryFn: () => api<ClusterInfo>('/api/v1/admin/system/cluster'), refetchInterval: 15_000 });
  const drain = useMutation({
    mutationFn: ({ id, draining }: { id: string; draining: boolean }) => api(`/api/v1/admin/system/storage/${id}`, { method: 'PUT', body: { draining } }),
    onSuccess: (_r, v) => {
      toast.success(v.draining ? `${v.id} is being retired: its files are copied to other nodes, then removed from it` : `${v.id} is back in use`);
      void qc.invalidateQueries({ queryKey: ['admin', 'cluster'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const forget = useMutation({
    mutationFn: (id: string) => api(`/api/v1/admin/system/storage/${id}`, { method: 'DELETE' }),
    onSuccess: (_r, id) => {
      toast.success(`${id} forgotten: missing copies will be made again from the other nodes`);
      void qc.invalidateQueries({ queryKey: ['admin', 'cluster'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!q.data) return <PageSpinner />;
  const { storage, media } = q.data;
  const online = storage.nodes.filter((n) => n.online && !n.draining).length;

  return (
    <div className="space-y-6">
      <PageHeader title="Servers & storage" description="Where ForgeOffice keeps files and runs meetings when it spans several machines. Add a storage node or media server on another machine and it appears here by itself." />

      <Card>
        <CardHeader
          title="Storage nodes"
          description={
            storage.mode === 'local'
              ? 'Files are on this machine’s volumes (no storage service configured).'
              : `Every file is kept on ${Math.min(storage.replicas, online)} of ${online} node${online === 1 ? '' : 's'}. Copies are checked every 10 minutes.`
          }
        />
        {storage.mode !== 'local' && storage.underReplicated > 0 && (
          <CardBody>
            <Alert tone="warning">
              {storage.underReplicated.toLocaleString()} file{storage.underReplicated === 1 ? ' has' : 's have'} fewer copies than they should. The worker is copying them{storage.replicas > online ? `; add ${storage.replicas - online} more node${storage.replicas - online === 1 ? '' : 's'} to keep ${storage.replicas} copies` : ''}.
            </Alert>
          </CardBody>
        )}
        {storage.mode !== 'local' && storage.replicas > 1 && online < 2 && (
          <CardBody>
            <Alert tone="info">With one storage node, every file has a single copy. Run a store on a second machine for redundancy.</Alert>
          </CardBody>
        )}
        {!storage.nodes.length ? (
          <CardBody>
            <EmptyState icon={<HardDrive />} title={storage.mode === 'local' ? 'Single machine' : 'No storage node is reachable'} description={storage.mode === 'local' ? 'Set FORGE_STORE_NODES to use storage nodes.' : 'Check the store containers and FORGE_STORE_NODES.'} />
          </CardBody>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Node</Th>
                <Th>Holds</Th>
                <Th className="hidden md:table-cell">Space</Th>
                <Th>State</Th>
                {canManage && <Th />}
              </tr>
            </thead>
            <tbody>
              {storage.nodes.map((n) => {
                const used = n.totalBytes - n.freeBytes;
                return (
                  <tr key={n.id}>
                    <Td>
                      <span className="font-medium">{n.id}</span>
                      {n.url && <span className="block text-xs text-zinc-500">{n.url}</span>}
                    </Td>
                    <Td className="text-sm">
                      {Object.keys(n.blobs).length ? (
                        Object.entries(n.blobs).map(([ns, count]) => (
                          <span key={ns} className="mr-3 inline-block">
                            {NS_LABEL[ns] ?? ns} <span className="text-zinc-500 tabular-nums">{count.toLocaleString()}</span>
                          </span>
                        ))
                      ) : (
                        <span className="text-zinc-500">{n.namespaces.map((ns) => NS_LABEL[ns] ?? ns).join(', ') || '—'}</span>
                      )}
                    </Td>
                    <Td className="hidden min-w-48 md:table-cell">
                      {n.totalBytes ? (
                        <>
                          <ProgressBar value={(100 * used) / n.totalBytes} tone={n.freeBytes < 5 * 1024 ** 3 ? 'danger' : undefined} />
                          <span className="text-xs text-zinc-500">
                            {formatBytes(n.freeBytes)} free of {formatBytes(n.totalBytes)}
                          </span>
                        </>
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td>
                      {!n.online ? (
                        <Badge tone="danger">
                          <CircleSlash className="mr-1 inline size-3" /> Not reachable
                        </Badge>
                      ) : n.draining ? (
                        <Badge tone="warning">Retiring</Badge>
                      ) : (
                        <Badge tone="success">
                          <CheckCircle2 className="mr-1 inline size-3" /> Online
                        </Badge>
                      )}
                    </Td>
                    {canManage && (
                      <Td className="text-right whitespace-nowrap">
                        {n.online ? (
                          <Button size="sm" variant="ghost" icon={n.draining ? <RotateCcw className="size-4" /> : <LogOut className="size-4" />} onClick={() => (n.draining || window.confirm(`Retire ${n.id}? Its files are copied to the other nodes, then removed from it. Stop it once it holds nothing.`)) && drain.mutate({ id: n.id, draining: !n.draining })}>
                            {n.draining ? 'Keep using' : 'Retire'}
                          </Button>
                        ) : (
                          <Button size="sm" variant="ghost" className="text-red-600" icon={<Trash2 className="size-4" />} onClick={() => window.confirm(`Forget ${n.id}? Only do this if it is gone for good: its copies are made again from the other nodes.`) && forget.mutate(n.id)}>
                            Forget
                          </Button>
                        )}
                      </Td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader title="Media servers" description="Each meeting runs on one media server: the least busy when it starts. Run more on other machines for more meetings at once." />
        {!media.length ? (
          <CardBody>
            <EmptyState icon={<Video />} title="No media server is running" description="Meetings can’t start until one is. Check the media container." />
          </CardBody>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Server</Th>
                <Th>Address for browsers</Th>
                <Th className="text-right">Meetings</Th>
                <Th className="text-right">People</Th>
                <Th className="hidden sm:table-cell">Last seen</Th>
              </tr>
            </thead>
            <tbody>
              {media.map((m) => (
                <tr key={m.id}>
                  <Td className="font-medium">{m.id}</Td>
                  <Td>{m.address ?? <span className="text-amber-600">not set (FORGE_RTC_ANNOUNCED_IP)</span>}</Td>
                  <Td className="text-right tabular-nums">{m.meetings}</Td>
                  <Td className="text-right tabular-nums">{m.people}</Td>
                  <Td className="hidden text-zinc-500 sm:table-cell">{formatRelative(new Date(m.seenAt).toISOString())}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
