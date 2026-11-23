import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { FolderOpen, Mail, MessagesSquare, Search, Users } from 'lucide-react';
import { Avatar, Badge, Card, CardHeader, EmptyState, PageHeader, PageSpinner } from '@forge/ui';
import { api } from '../lib/api';
import type { DirectoryCard, Group } from '../lib/types';

export function SearchPage() {
  const [params] = useSearchParams();
  const q = params.get('q')?.trim() ?? '';
  const { data, isLoading } = useQuery({
    queryKey: ['search', q],
    queryFn: () => api<{ people: DirectoryCard[]; groups: Group[] }>(`/api/v1/directory/search?q=${encodeURIComponent(q)}&limit=50`),
    enabled: q.length > 0,
  });

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={q ? `Results for “${q}”` : 'Search'} description="Searching the directory. Mail, files and chat messages join search as those apps arrive." />
      {!q ? (
        <EmptyState icon={<Search />} title="Type in the search box above" />
      ) : isLoading ? (
        <PageSpinner />
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader title="People" description={`${data?.people.length ?? 0} found`} />
            {data?.people.length ? (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {data.people.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 px-5 py-3">
                    <Avatar name={p.displayName} src={p.avatarUrl} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{p.displayName}</p>
                      <p className="truncate text-sm text-zinc-500">{[p.jobTitle, p.department].filter(Boolean).join(' · ') || p.email}</p>
                    </div>
                    <a href={`mailto:${p.email}`} className="hidden text-sm text-brand hover:underline sm:block">
                      {p.email}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={<Users />} title="No people match" />
            )}
          </Card>
          <Card>
            <CardHeader title="Groups" description={`${data?.groups.length ?? 0} found`} />
            {data?.groups.length ? (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {data.groups.map((g) => (
                  <li key={g.id} className="flex items-center gap-3 px-5 py-3">
                    <span className="flex size-9 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800">
                      <Users className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{g.name}</p>
                      <p className="truncate text-sm text-zinc-500">{g.email ?? g.description}</p>
                    </div>
                    <Badge tone={g.type === 'security' ? 'neutral' : 'info'}>{g.type === 'security' ? 'Security' : 'Distribution'}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={<Users />} title="No groups match" />
            )}
          </Card>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { icon: Mail, label: 'Mail', phase: 2 },
              { icon: FolderOpen, label: 'Files & sites', phase: 3 },
              { icon: MessagesSquare, label: 'Messages', phase: 4 },
            ].map(({ icon: Icon, label, phase }) => (
              <div key={label} className="flex items-center gap-3 rounded-xl border border-dashed border-zinc-300 p-4 text-sm text-zinc-500 dark:border-zinc-700">
                <Icon className="size-5" /> {label} search arrives in phase {phase}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
