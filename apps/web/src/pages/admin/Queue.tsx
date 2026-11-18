import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Pause, Play, RotateCcw, Trash2 } from 'lucide-react';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, PageHeader, PageSpinner, cn, formatRelative, useToast } from '@forge/ui';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/hooks';
import type { QueueJob, SystemOverview } from '../../lib/types';

const STATES = ['failed', 'active', 'waiting', 'delayed', 'completed'] as const;

export function QueuePage() {
  const { name = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const canManage = useCan('system:manage');
  const [state, setState] = useState<(typeof STATES)[number]>('failed');
  const overview = useQuery({ queryKey: ['system', 'overview'], queryFn: () => api<SystemOverview>('/api/v1/admin/system/overview') });
  const jobs = useQuery({
    queryKey: ['system', 'queue', name, state],
    queryFn: () => api<{ items: QueueJob[] }>(`/api/v1/admin/system/queues/${name}/jobs?state=${state}&limit=50`),
    refetchInterval: 5_000,
  });
  const queue = overview.data?.queues.find((q) => q.name === name);
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: object }) => api(`/api/v1/admin/system/queues/${name}/${path}`, { body: body ?? {} }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['system'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (overview.isLoading) return <PageSpinner />;
  if (!queue) return <Alert tone="danger">Unknown queue</Alert>;

  return (
    <div className="space-y-6">
      <Link to="/admin" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
        <ArrowLeft className="size-4" /> Overview
      </Link>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {queue.label} {queue.paused && <Badge tone="warning">Paused</Badge>}
          </span>
        }
        description={queue.description}
        actions={
          canManage &&
          queue.available && (
            <>
              {queue.paused ? (
                <Button icon={<Play className="size-4" />} onClick={() => act.mutate({ path: 'resume' })}>
                  Resume
                </Button>
              ) : (
                <Button icon={<Pause className="size-4" />} onClick={() => act.mutate({ path: 'pause' })}>
                  Pause
                </Button>
              )}
              <Button icon={<RotateCcw className="size-4" />} disabled={!queue.counts?.failed} onClick={() => act.mutate({ path: 'retry-failed' })}>
                Retry failed
              </Button>
              <Button icon={<Trash2 className="size-4" />} onClick={() => act.mutate({ path: 'clean', body: { state: 'completed', grace: 0 } })}>
                Clear completed
              </Button>
            </>
          )
        }
      />
      {!queue.available && <Alert tone="warning">{queue.error ?? 'This queue is unavailable (is Redis configured?)'}</Alert>}
      <Card>
        <CardHeader
          title="Jobs"
          actions={
            <div role="tablist" className="flex flex-wrap gap-1">
              {STATES.map((s) => (
                <button
                  key={s}
                  role="tab"
                  aria-selected={state === s}
                  onClick={() => setState(s)}
                  className={cn('rounded-md px-2.5 py-1 text-xs font-medium capitalize', state === s ? 'bg-brand text-white' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800')}
                >
                  {s} {queue.counts && <span className="opacity-70">{queue.counts[s]}</span>}
                </button>
              ))}
            </div>
          }
        />
        {jobs.isLoading ? (
          <PageSpinner />
        ) : !jobs.data?.items.length ? (
          <EmptyState title={`No ${state} jobs`} />
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {jobs.data.items.map((j) => (
              <li key={j.id} className="space-y-1 px-5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-medium">{j.name}</span>
                  <span className="font-mono text-xs text-zinc-400">#{j.id}</span>
                  <span className="text-xs text-zinc-500">· queued {formatRelative(new Date(j.timestamp))}</span>
                  {j.attemptsMade > 0 && <Badge>{j.attemptsMade} attempts</Badge>}
                  {canManage && (
                    <span className="ml-auto flex gap-1">
                      {state === 'failed' && (
                        <Button size="sm" variant="ghost" onClick={() => act.mutate({ path: 'retry-job', body: { jobId: j.id } })}>
                          Retry
                        </Button>
                      )}
                      {state !== 'active' && (
                        <Button size="sm" variant="ghost" onClick={() => act.mutate({ path: 'remove-job', body: { jobId: j.id } })}>
                          Remove
                        </Button>
                      )}
                    </span>
                  )}
                </div>
                {j.failedReason && <p className="text-sm text-red-600">{j.failedReason}</p>}
                <pre className="overflow-x-auto rounded bg-zinc-50 p-2 text-xs dark:bg-zinc-950">{JSON.stringify(j.data)}</pre>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
