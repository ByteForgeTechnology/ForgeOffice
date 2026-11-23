import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleSlash, Copy, Eye, EyeOff, HardDrive, LogOut, RotateCcw, ServerCog, Trash2, Video } from 'lucide-react';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, PageHeader, PageSpinner, ProgressBar, Table, Td, Textarea, Th, formatBytes, formatRelative, useToast } from '@forge/ui';
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
  join: JoinInfo;
}

interface JoinInfo {
  available: boolean;
  reason: string | null;
  publicUrl: string;
  databaseHost: string | null;
  storageNodes: string[];
  replicas: number;
  release: string | null;
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

      <JoinCard info={q.data.join} canManage={canManage} />
    </div>
  );
}

/** Adding a server: the installer's join code (holds the database password and master secret). */
function JoinCard({ info, canManage }: { info: JoinInfo; canManage: boolean }) {
  const toast = useToast();
  const [code, setCode] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const reveal = useMutation({
    mutationFn: () => api<{ code: string }>('/api/v1/admin/system/join-code', { method: 'POST' }),
    onSuccess: (r) => setCode(r.code),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // No clipboard API on plain-HTTP addresses: copy the selected text instead.
      box.current?.select();
      if (!document.execCommand('copy')) return toast.error('Select the code and copy it yourself');
    }
    toast.success('Join code copied');
  };

  return (
    <Card>
      <CardHeader title="Add a server" description="Run part of ForgeOffice on another server, or more copies of a part to share the load." />
      <CardBody className="space-y-4">
        {!info.available ? (
          <EmptyState icon={<ServerCog />} title="Other servers can’t join this ForgeOffice" description={info.reason ?? undefined} />
        ) : (
          <>
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              <li>
                Copy the ForgeOffice release{info.release ? <> (<span className="font-mono">{info.release}</span>)</> : null} to the new server and unzip it.
              </li>
              <li>
                Run <span className="font-mono">sudo ./install.sh</span>, choose <strong>Custom</strong>, then <strong>Join a ForgeOffice running on other servers</strong>.
              </li>
              <li>Paste the join code below, and tick the parts the new server should run.</li>
              <li>If it runs web apps, the Directory or app back ends, run the installer again on the gateway’s server and add it under <strong>Other servers</strong>. Storage nodes and media servers appear on this page by themselves.</li>
            </ol>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-zinc-500">Web address</dt>
              <dd className="font-mono break-all">{info.publicUrl}</dd>
              <dt className="text-zinc-500">Database</dt>
              <dd className="font-mono">{info.databaseHost}:5432</dd>
              <dt className="text-zinc-500">Storage nodes</dt>
              <dd className="font-mono break-all">{info.storageNodes.join(', ')}</dd>
              <dt className="text-zinc-500">Copies of each file</dt>
              <dd>{info.replicas}</dd>
            </dl>
            <p className="text-sm text-zinc-500">The new server must reach the database server on ports 5432 and 6379, and the storage nodes on port 8096. Keep those ports closed to the internet.</p>
            {!canManage ? (
              <Alert tone="info">Only administrators who can manage the system can see the join code.</Alert>
            ) : code ? (
              <div className="space-y-2">
                <Alert tone="warning">Keep this code secret: it holds the database password and the master secret, so anyone with it can read everything in ForgeOffice. Viewing it is recorded in the audit log.</Alert>
                <Textarea ref={box} readOnly value={code} rows={4} className="font-mono text-xs break-all" onFocus={(e) => e.currentTarget.select()} aria-label="Join code" />
                <div className="flex gap-2">
                  <Button variant="primary" icon={<Copy className="size-4" />} onClick={() => void copy()}>
                    Copy
                  </Button>
                  <Button variant="ghost" icon={<EyeOff className="size-4" />} onClick={() => setCode(null)}>
                    Hide
                  </Button>
                </div>
              </div>
            ) : (
              <Button icon={<Eye className="size-4" />} loading={reveal.isPending} onClick={() => reveal.mutate()}>
                Show join code
              </Button>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}
