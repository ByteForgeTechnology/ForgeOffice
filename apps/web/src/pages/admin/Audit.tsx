import { Fragment, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Download, ScrollText } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Input, PageHeader, PageSpinner, Select, Table, Td, Th, formatDateTime, useToast } from '@forge/ui';
import { download, errorMessage } from '../../lib/api';
import { api } from '../../lib/api';
import { useDebounced } from '../../lib/hooks';
import { useSocketEvent } from '../../lib/realtime';
import type { AuditEntry } from '../../lib/types';

const CATEGORIES = [
  { value: '', label: 'All activity' },
  { value: 'auth.', label: 'Sign-ins & passwords' },
  { value: 'mfa.', label: 'Two-step verification' },
  { value: 'user.', label: 'Users' },
  { value: 'group.', label: 'Groups' },
  { value: 'role.', label: 'Roles' },
  { value: 'domain.', label: 'Domains' },
  { value: 'org.', label: 'Organisation' },
  { value: 'backup.', label: 'Backups' },
  { value: 'queue.', label: 'Queues' },
  { value: 'access.denied', label: 'Access denied' },
  { value: 'setup.', label: 'Setup' },
];

export function AuditPage() {
  const toast = useToast();
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [outcome, setOutcome] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [fresh, setFresh] = useState(0);
  const actorTerm = useDebounced(actor, 300);
  const params = new URLSearchParams({ ...(action && { action }), ...(actorTerm && { actor: actorTerm }), ...(outcome && { outcome }) });
  const query = useInfiniteQuery({
    queryKey: ['admin', 'audit', params.toString()],
    queryFn: ({ pageParam }) => api<{ items: AuditEntry[]; nextCursor: number | null }>(`/api/v1/admin/audit?${params}&limit=100${pageParam ? `&before=${pageParam}` : ''}`),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  useSocketEvent('audit:created', () => setFresh((n) => n + 1));
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div>
      <PageHeader
        title="Audit log"
        description="Sign-ins, permission changes and administrative actions."
        actions={
          <Button
            icon={<Download className="size-4" />}
            onClick={() => download(`/api/v1/admin/audit/export.csv?${params}`, `audit-${new Date().toISOString().slice(0, 10)}.csv`).catch((e) => toast.error(errorMessage(e)))}
          >
            Export CSV
          </Button>
        }
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-zinc-200 p-4 sm:flex-row sm:items-center dark:border-zinc-800">
          <Select value={action} onChange={(e) => setAction(e.target.value)} className="sm:w-56" aria-label="Category">
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
          <Input placeholder="Actor email" value={actor} onChange={(e) => setActor(e.target.value)} className="sm:max-w-xs" />
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value)} className="sm:w-40" aria-label="Outcome">
            <option value="">Any outcome</option>
            <option value="success">Success</option>
            <option value="failure">Failure</option>
          </Select>
          {fresh > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="sm:ml-auto"
              onClick={() => {
                setFresh(0);
                void query.refetch();
              }}
            >
              {fresh} new {fresh === 1 ? 'event' : 'events'} — refresh
            </Button>
          )}
        </div>
        {query.isLoading ? (
          <PageSpinner />
        ) : rows.length === 0 ? (
          <EmptyState icon={<ScrollText />} title="No matching events" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th className="w-8" />
                <Th>Time</Th>
                <Th>Action</Th>
                <Th>Actor</Th>
                <Th className="hidden md:table-cell">Target</Th>
                <Th className="hidden lg:table-cell">IP</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <Fragment key={e.id}>
                  <tr className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50" onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
                    <Td>{expanded === e.id ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</Td>
                    <Td className="whitespace-nowrap text-zinc-500">{formatDateTime(e.createdAt)}</Td>
                    <Td>
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-xs">{e.action}</span>
                        {e.outcome === 'failure' && <Badge tone="danger">failed</Badge>}
                      </span>
                    </Td>
                    <Td className="max-w-48 truncate">{e.actorLabel ?? 'system'}</Td>
                    <Td className="hidden max-w-48 truncate md:table-cell">{e.targetLabel ?? e.targetId ?? '—'}</Td>
                    <Td className="hidden font-mono text-xs lg:table-cell">{e.ip ?? '—'}</Td>
                  </tr>
                  {expanded === e.id && (
                    <tr>
                      <td colSpan={6} className="bg-zinc-50 px-6 py-3 dark:bg-zinc-950">
                        <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
                          <dt className="font-medium">Target</dt>
                          <dd className="font-mono">{[e.targetType, e.targetId].filter(Boolean).join(' · ') || '—'}</dd>
                          <dt className="font-medium">User agent</dt>
                          <dd className="break-all">{e.userAgent ?? '—'}</dd>
                          <dt className="font-medium">Details</dt>
                          <dd>
                            <pre className="overflow-x-auto font-mono whitespace-pre-wrap">{JSON.stringify(e.metadata, null, 2)}</pre>
                          </dd>
                        </dl>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </Table>
        )}
        {query.hasNextPage && (
          <div className="p-4 text-center">
            <Button loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
              Load older events
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
