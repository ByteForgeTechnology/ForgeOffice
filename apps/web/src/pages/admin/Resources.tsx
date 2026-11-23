import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DoorOpen, Plus, Trash2 } from 'lucide-react';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, PageSpinner, Select, Switch, Table, Td, Th, useToast } from '@forge/ui';
import { ConfirmDialog } from '../../components/admin';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/hooks';
import type { Domain } from '../../lib/types';

interface Resource {
  id: string;
  name: string;
  email: string;
  kind: 'room' | 'equipment';
  capacity: number | null;
  location: string;
  autoAccept: boolean;
}

export function ResourcesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const canManage = useCan('org:manage');
  const [editing, setEditing] = useState<Resource | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Resource | null>(null);
  const list = useQuery({ queryKey: ['admin', 'resources'], queryFn: () => api<{ items: Resource[] }>('/api/v1/admin/resources') });
  const del = useMutation({
    mutationFn: (id: string) => api(`/api/v1/admin/resources/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: ['admin', 'resources'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div>
      <PageHeader
        title="Rooms & equipment"
        description="Bookable resources get their own calendar and address. They accept invitations automatically when free."
        actions={
          canManage && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              Add room
            </Button>
          )
        }
      />
      <Card>
        {list.isLoading ? (
          <PageSpinner />
        ) : !list.data?.items.length ? (
          <EmptyState icon={<DoorOpen />} title="No rooms yet" description="Add meeting rooms so people can book them from their calendar." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th className="hidden sm:table-cell">Address</Th>
                <Th>Capacity</Th>
                <Th>Booking</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((r) => (
                <tr key={r.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                  <Td>
                    <button type="button" className="text-left font-medium hover:text-brand" onClick={() => canManage && setEditing(r)}>
                      {r.name}
                    </button>
                    {r.location && <p className="text-xs text-zinc-500">{r.location}</p>}
                  </Td>
                  <Td className="hidden font-mono text-xs sm:table-cell">{r.email}</Td>
                  <Td>{r.capacity ?? '—'}</Td>
                  <Td>{r.autoAccept ? <Badge tone="success">Automatic</Badge> : <Badge>Tentative</Badge>}</Td>
                  <Td className="text-right">
                    {canManage && (
                      <Button size="sm" variant="ghost" aria-label={`Delete ${r.name}`} onClick={() => setDeleting(r)}>
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {editing && <ResourceDialog resource={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={() => deleting && del.mutate(deleting.id)} title={`Delete ${deleting?.name}?`} danger confirmLabel="Delete" busy={del.isPending}>
        Existing bookings stay in people’s calendars, but the room can no longer be booked.
      </ConfirmDialog>
    </div>
  );
}

function ResourceDialog({ resource, onClose }: { resource: Resource | null; onClose: () => void }) {
  const qc = useQueryClient();
  const domains = useQuery({ queryKey: ['admin', 'domains'], queryFn: () => api<{ items: Domain[] }>('/api/v1/admin/domains') });
  const primary = domains.data?.items.find((d) => d.isPrimary)?.name ?? '';
  const [f, setF] = useState({ name: resource?.name ?? '', local: resource?.email.split('@')[0] ?? '', domain: resource?.email.split('@')[1] ?? '', kind: resource?.kind ?? 'room', capacity: resource?.capacity ?? '', location: resource?.location ?? '', autoAccept: resource?.autoAccept ?? true });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const body = { name: f.name, kind: f.kind, capacity: f.capacity === '' ? null : Number(f.capacity), location: f.location, autoAccept: f.autoAccept };
      return resource ? api(`/api/v1/admin/resources/${resource.id}`, { method: 'PATCH', body }) : api('/api/v1/admin/resources', { body: { ...body, email: `${f.local}@${f.domain || primary}` } });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'resources'] });
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={resource ? `Edit ${resource.name}` : 'Add room or equipment'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!f.name || (!resource && !f.local)} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      <div className="space-y-4">
        <Field label="Name" htmlFor="r-name">
          <Input
            id="r-name"
            value={f.name}
            onChange={(e) => {
              const name = e.target.value;
              setF((x) => ({ ...x, name, local: resource ? x.local : name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') }));
            }}
            placeholder="Board room"
          />
        </Field>
        {!resource && (
          <Field label="Booking address" htmlFor="r-local">
            <div className="flex items-center gap-2">
              <Input id="r-local" value={f.local} onChange={(e) => setF({ ...f, local: e.target.value.toLowerCase() })} />
              <Select value={f.domain || primary} onChange={(e) => setF({ ...f, domain: e.target.value })} className="w-auto" aria-label="Domain">
                {domains.data?.items.map((d) => (
                  <option key={d.id} value={d.name}>
                    @{d.name}
                  </option>
                ))}
              </Select>
            </div>
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type" htmlFor="r-kind">
            <Select id="r-kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as 'room' | 'equipment' })}>
              <option value="room">Room</option>
              <option value="equipment">Equipment</option>
            </Select>
          </Field>
          <Field label="Capacity" htmlFor="r-cap">
            <Input id="r-cap" type="number" min={1} value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} />
          </Field>
        </div>
        <Field label="Location" htmlFor="r-loc">
          <Input id="r-loc" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} placeholder="2nd floor, east wing" />
        </Field>
        <Switch checked={f.autoAccept} onChange={(v) => setF({ ...f, autoAccept: v })} label="Accept invitations automatically" description="Declines automatically when the slot is already booked." />
      </div>
    </Dialog>
  );
}
