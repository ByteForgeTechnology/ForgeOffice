import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, CheckCircle2, Trash2, XCircle } from 'lucide-react';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog, Field, Input, PageHeader, PageSpinner, Select, Switch, Table, Td, Th, formatRelative, useToast } from '@forge/ui';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/hooks';

interface TeamSettings {
  guestAccess: boolean;
  recording: boolean;
  createTeams: 'everyone' | 'admins';
  maxParticipants: number;
}

/** Admin → ForgeTeam → Meetings & policies. */
export function TeamSettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const canManage = useCan('org:manage');
  const q = useQuery({
    queryKey: ['admin', 'team', 'settings'],
    queryFn: () => api<{ settings: TeamSettings; status: { media: { announcedIp: string | null; ports: string; workers: number; liveMeetings: number }; recording: string | null } }>('/api/v1/admin/team/settings'),
  });
  const live = useQuery({ queryKey: ['admin', 'team', 'meetings'], queryFn: () => api<{ items: { id: string; title: string; startedAt: string | null; participants: number; guests: number }[] }>('/api/v1/admin/team/meetings'), refetchInterval: 15_000 });
  const [f, setF] = useState<TeamSettings | null>(null);
  useEffect(() => {
    if (q.data && !f) setF(q.data.settings);
  }, [q.data, f]);
  const save = useMutation({
    mutationFn: () => api('/api/v1/admin/team/settings', { method: 'PUT', body: f }),
    onSuccess: () => {
      toast.success('ForgeTeam settings saved');
      void qc.invalidateQueries({ queryKey: ['admin', 'team'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!q.data || !f) return <PageSpinner />;
  const { media, recording } = q.data.status;
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Meetings & policies" description="Organisation-wide settings for ForgeTeam chat and meetings." />
      <Card>
        <CardHeader title="Meeting server" />
        <CardBody className="space-y-3 text-sm">
          <p className="flex items-start gap-2">
            {media.announcedIp ? <CheckCircle2 className="mt-0.5 size-4 text-emerald-600" /> : <XCircle className="mt-0.5 size-4 text-amber-500" />}
            <span>
              Media address: <strong>{media.announcedIp ?? 'not set'}</strong>, ports {media.ports} (UDP and TCP).
              {!media.announcedIp && <span className="block text-zinc-500">Set FORGE_RTC_ANNOUNCED_IP to this server’s LAN or public IP so other computers can see and hear each other.</span>}
            </span>
          </p>
          <p className="flex items-start gap-2">
            {recording ? <CheckCircle2 className="mt-0.5 size-4 text-emerald-600" /> : <XCircle className="mt-0.5 size-4 text-red-600" />}
            <span>Recording: {recording ?? 'FFmpeg not found, so meetings can’t be recorded'}</span>
          </p>
          <p className="text-zinc-500">{media.liveMeetings ? `${media.liveMeetings} meeting${media.liveMeetings === 1 ? '' : 's'} happening now.` : 'No meetings right now.'}</p>
          {!!live.data?.items.length && (
            <ul className="divide-y divide-zinc-100 rounded-lg ring-1 ring-zinc-200 dark:divide-zinc-800 dark:ring-zinc-800">
              {live.data.items.map((m) => (
                <li key={m.id} className="flex items-center gap-2 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate">{m.title}</span>
                  <span className="text-zinc-500">
                    {m.participants} people{m.guests ? ` (${m.guests} guests)` : ''} · started {formatRelative(m.startedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
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
            <CardHeader title="Meetings" />
            <CardBody className="space-y-4">
              <Switch checked={f.guestAccess} onChange={(v) => setF({ ...f, guestAccess: v })} label="Let guests join from a meeting link" description="People outside the organisation enter their name and wait in the lobby until someone admits them." />
              <Switch checked={f.recording} onChange={(v) => setF({ ...f, recording: v })} label="Allow recording" description="Organisers can record; recordings are posted in the meeting’s channel or chat and kept in forge_team_media." />
              <Field label="Most people in one meeting" htmlFor="tm-max">
                <Input id="tm-max" type="number" min={2} max={500} value={f.maxParticipants} onChange={(e) => setF({ ...f, maxParticipants: Number(e.target.value) })} className="w-32" />
              </Field>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Teams" />
            <CardBody>
              <Field label="Who can create teams" htmlFor="tm-create">
                <Select id="tm-create" value={f.createTeams} onChange={(e) => setF({ ...f, createTeams: e.target.value as TeamSettings['createTeams'] })} className="max-w-xs">
                  <option value="everyone">Everyone</option>
                  <option value="admins">Only administrators (who can manage groups)</option>
                </Select>
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

interface TeamRow {
  id: string;
  name: string;
  description: string;
  color: string;
  visibility: 'public' | 'private';
  archivedAt: string | null;
  createdAt: string;
  members: number;
  channels: number;
  lastActivity: string | null;
  owners: string[];
}

/** Admin → ForgeTeam → Teams: every team (not its messages); archive, restore or delete. */
export function TeamsAdminPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const canManage = useCan('groups:manage');
  const [filter, setFilter] = useState('');
  const [deleting, setDeleting] = useState<TeamRow | null>(null);
  const q = useQuery({ queryKey: ['admin', 'team', 'teams'], queryFn: () => api<{ items: TeamRow[] }>('/api/v1/admin/team/teams') });
  const archive = useMutation({
    mutationFn: (t: TeamRow) => api(`/api/v1/admin/team/teams/${t.id}`, { method: 'PATCH', body: { archived: !t.archivedAt } }),
    onSuccess: (_r, t) => {
      toast.success(t.archivedAt ? `${t.name} restored` : `${t.name} archived`);
      void qc.invalidateQueries({ queryKey: ['admin', 'team', 'teams'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const rows = (q.data?.items ?? []).filter((t) => !filter || `${t.name} ${t.owners.join(' ')}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="space-y-6">
      <PageHeader title="Teams" description="Every team in the organisation. Each team is also a security group (manage its members under ForgeDirectory → Groups) with a document library in Drive." />
      <Input aria-label="Filter teams" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} className="max-w-xs" />
      {!q.data ? (
        <PageSpinner />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Team</Th>
                <Th className="hidden md:table-cell">Owners</Th>
                <Th className="text-right">Members</Th>
                <Th className="hidden text-right sm:table-cell">Channels</Th>
                <Th className="hidden lg:table-cell">Last activity</Th>
                {canManage && <Th />}
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className={t.archivedAt ? 'opacity-70' : undefined}>
                  <Td>
                    <span className="flex items-center gap-2">
                      <span className="size-3 shrink-0 rounded" style={{ background: t.color }} />
                      <span className="font-medium">{t.name}</span>
                      <Badge>{t.visibility === 'public' ? 'Public' : 'Private'}</Badge>
                      {t.archivedAt && <Badge tone="warning">Archived</Badge>}
                    </span>
                  </Td>
                  <Td className="hidden md:table-cell">{t.owners.join(', ') || '—'}</Td>
                  <Td className="text-right tabular-nums">{t.members}</Td>
                  <Td className="hidden text-right tabular-nums sm:table-cell">{t.channels}</Td>
                  <Td className="hidden lg:table-cell">{t.lastActivity ? formatRelative(t.lastActivity) : '—'}</Td>
                  {canManage && (
                    <Td className="text-right whitespace-nowrap">
                      <Button size="sm" variant="ghost" icon={t.archivedAt ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />} onClick={() => archive.mutate(t)}>
                        {t.archivedAt ? 'Restore' : 'Archive'}
                      </Button>
                      <Button size="sm" variant="ghost" className="text-red-600" icon={<Trash2 className="size-4" />} onClick={() => setDeleting(t)}>
                        Delete
                      </Button>
                    </Td>
                  )}
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <Td className="text-zinc-500">No teams yet.</Td>
                </tr>
              )}
            </tbody>
          </Table>
        </Card>
      )}
      {deleting && <DeleteTeamDialog team={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}

function DeleteTeamDialog({ team, onClose }: { team: TeamRow; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const remove = useMutation({
    mutationFn: () => api(`/api/v1/admin/team/teams/${team.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success(`${team.name} deleted`);
      void qc.invalidateQueries({ queryKey: ['admin', 'team', 'teams'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onClose={onClose} title={`Delete ${team.name}?`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" disabled={typed.trim() !== team.name} loading={remove.isPending} onClick={() => remove.mutate()}>Delete team</Button></>}>
      <div className="space-y-3 text-sm">
        <Alert tone="danger">This deletes the team’s channels, messages, meeting history, its security group and every file in its library. It cannot be undone. Archiving keeps everything.</Alert>
        <Field label={`Type “${team.name}” to confirm`} htmlFor="del-team">
          <Input id="del-team" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </Field>
      </div>
    </Dialog>
  );
}
