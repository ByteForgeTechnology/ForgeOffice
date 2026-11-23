import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, DoorOpen, Mail, Phone, Plus, Share2, Trash2, Users } from 'lucide-react';
import { ShareDialog, toGrants } from '../../components/ShareDialog';
import { Alert, Avatar, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, PageSpinner, Textarea, cn, useToast } from '@forge/ui';
import { api, errorMessage } from '../../lib/api';
import { useDebounced } from '../../lib/hooks';

interface Contact {
  id: string;
  uid: string;
  fullName: string;
  givenName: string;
  familyName: string;
  emails: { type: string; value: string }[];
  phones: { type: string; value: string }[];
  organization: string;
  title: string;
  note: string;
}

interface GalEntry {
  kind: 'person' | 'group' | 'room' | 'shared';
  id: string;
  name: string;
  email: string;
  detail: string;
}

interface Book {
  id: string;
  name: string;
  access: 'owner' | 'write' | 'read';
  shared: boolean;
  isDefault: boolean;
  canShare: boolean;
}

export function ContactsPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<string>('mine');
  const books = useQuery({ queryKey: ['contacts', 'books'], queryFn: () => api<{ items: Book[] }>('/api/v1/contacts/books') });
  const sharedBooks = books.data?.items.filter((b) => b.shared) ?? [];
  const activeBook = sharedBooks.find((b) => b.id === tab);
  const bookQuery = activeBook ? `bookId=${activeBook.id}` : '';
  const readOnly = activeBook?.access === 'read';
  const ownBook = books.data?.items.find((b) => !b.shared && b.isDefault);
  const shareTarget = tab === 'mine' ? ownBook : activeBook;
  const [sharing, setSharing] = useState(false);
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 250);
  const [editing, setEditing] = useState<Contact | 'new' | null>(null);
  const mine = useQuery({
    queryKey: ['contacts', tab, term],
    queryFn: () => api<{ items: Contact[] }>(`/api/v1/contacts?${[bookQuery, term ? `q=${encodeURIComponent(term)}` : ''].filter(Boolean).join('&')}`),
    enabled: tab !== 'directory',
  });
  const gal = useQuery({ queryKey: ['gal', term], queryFn: () => api<{ items: GalEntry[]; total: number }>(`/api/v1/directory/gal?limit=500${term ? `&q=${encodeURIComponent(term)}` : ''}`), enabled: tab === 'directory' });
  const email = (address: string, name: string) => navigate(`/mail?to=${encodeURIComponent(address)}&name=${encodeURIComponent(name)}`);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="People"
        description="Your contacts sync to phones and desktop apps over CardDAV. The directory lists everyone in your organisation."
        actions={
          tab !== 'directory' && (
            <>
              {shareTarget?.canShare && (
                <Button icon={<Share2 className="size-4" />} onClick={() => setSharing(true)}>
                  Share
                </Button>
              )}
              {!readOnly && (
                <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
                  New contact
                </Button>
              )}
            </>
          )
        }
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-zinc-200 p-4 sm:flex-row sm:items-center dark:border-zinc-800">
          <div role="tablist" className="inline-flex rounded-lg bg-zinc-100 p-0.5 text-sm dark:bg-zinc-800">
            {[{ id: 'mine', label: 'My contacts' }, ...sharedBooks.map((b) => ({ id: b.id, label: b.name })), { id: 'directory', label: 'Directory' }].map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cn('rounded-md px-3 py-1 whitespace-nowrap', tab === t.id && 'bg-white shadow-sm dark:bg-zinc-700')}>
                {t.label}
              </button>
            ))}
          </div>
          <Input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className="sm:max-w-xs" aria-label="Search people" />
        </div>
        {tab !== 'directory' ? (
          mine.isLoading ? (
            <PageSpinner />
          ) : !mine.data?.items.length ? (
            <EmptyState icon={<Users />} title={term ? 'No contacts match' : 'No contacts yet'} description="Add people you email outside the organisation." />
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {mine.data.items.map((c) => (
                <li key={c.id} className={cn('flex items-center gap-3 px-5 py-3', !readOnly && 'cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50')} onClick={() => !readOnly && setEditing(c)}>
                  <Avatar name={c.fullName} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{c.fullName}</p>
                    <p className="truncate text-sm text-zinc-500">{[c.title, c.organization].filter(Boolean).join(' · ') || c.emails[0]?.value}</p>
                  </div>
                  {c.emails[0] && (
                    <Button size="sm" variant="ghost" aria-label={`Email ${c.fullName}`} onClick={(e) => (e.stopPropagation(), email(c.emails[0]!.value, c.fullName))}>
                      <Mail className="size-4" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )
        ) : gal.isLoading ? (
          <PageSpinner />
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {gal.data?.items.map((g) => (
              <li key={`${g.kind}-${g.id}`} className="flex items-center gap-3 px-5 py-3">
                {g.kind === 'person' ? (
                  <Avatar name={g.name} />
                ) : (
                  <span className="flex size-9 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800">{g.kind === 'room' ? <DoorOpen className="size-4" /> : g.kind === 'shared' ? <Mail className="size-4" /> : <Users className="size-4" />}</span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{g.name}</p>
                  <p className="truncate text-sm text-zinc-500">{g.detail || g.email}</p>
                </div>
                {g.kind !== 'room' && (
                  <Button size="sm" variant="ghost" aria-label={`Email ${g.name}`} onClick={() => email(g.email, g.name)}>
                    <Mail className="size-4" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {sharing && shareTarget && (
        <ShareDialog
          title={`Share “${tab === 'mine' ? 'My contacts' : shareTarget.name}”`}
          description="Only this address book is shared. People see it as a tab here and in contacts apps."
          levels={[
            { value: 'read', label: 'Read', description: 'See the contacts.' },
            { value: 'write', label: 'Write', description: 'Also add, change and delete contacts.' },
          ]}
          load={async () => toGrants((await api<{ items: Parameters<typeof toGrants>[0] }>(`/api/v1/contacts/books/${shareTarget.id}/shares`)).items)}
          save={(grants) =>
            api(`/api/v1/contacts/books/${shareTarget.id}/shares`, {
              method: 'PUT',
              body: { grants: grants.map(({ principalType, principalId, access }) => ({ principalType, principalId, access })) },
            })
          }
          onClose={() => setSharing(false)}
        />
      )}
      {editing && <ContactDialog contact={editing === 'new' ? null : editing} bookQuery={bookQuery} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ContactDialog({ contact, bookQuery, onClose }: { contact: Contact | null; bookQuery: string; onClose: () => void }) {
  const qs = bookQuery ? `?${bookQuery}` : '';
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({
    fullName: contact?.fullName ?? '',
    givenName: contact?.givenName ?? '',
    familyName: contact?.familyName ?? '',
    email: contact?.emails[0]?.value ?? '',
    email2: contact?.emails[1]?.value ?? '',
    phone: contact?.phones[0]?.value ?? '',
    organization: contact?.organization ?? '',
    title: contact?.title ?? '',
    note: contact?.note ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const body = () => ({
    fullName: f.fullName || [f.givenName, f.familyName].filter(Boolean).join(' '),
    givenName: f.givenName,
    familyName: f.familyName,
    emails: [f.email, f.email2].filter(Boolean).map((value, i) => ({ type: i ? 'home' : 'work', value })),
    phones: f.phone ? [{ type: 'cell', value: f.phone }] : [],
    organization: f.organization,
    title: f.title,
    note: f.note,
  });
  const save = useMutation({
    mutationFn: () => (contact ? api(`/api/v1/contacts/${contact.id}${qs}`, { method: 'PUT', body: body() }) : api(`/api/v1/contacts${qs}`, { body: body() })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['contacts'] });
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/v1/contacts/${contact!.id}${qs}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['contacts'] });
      toast.success('Contact deleted');
      onClose();
    },
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Dialog
      open
      onClose={onClose}
      title={contact ? contact.fullName : 'New contact'}
      footer={
        <>
          {contact && (
            <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => remove.mutate()} className="mr-auto">
              Delete
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!f.fullName && !f.givenName && !f.familyName} onClick={() => save.mutate()}>
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
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name" htmlFor="c-given">
          <Input id="c-given" value={f.givenName} onChange={set('givenName')} />
        </Field>
        <Field label="Last name" htmlFor="c-family">
          <Input id="c-family" value={f.familyName} onChange={set('familyName')} />
        </Field>
        <Field label="Display name" htmlFor="c-full" className="sm:col-span-2">
          <Input id="c-full" value={f.fullName} onChange={set('fullName')} placeholder={[f.givenName, f.familyName].filter(Boolean).join(' ')} />
        </Field>
        <Field label={<span className="flex items-center gap-1"><Mail className="size-3.5" /> Email</span>} htmlFor="c-email">
          <Input id="c-email" type="email" value={f.email} onChange={set('email')} />
        </Field>
        <Field label="Other email" htmlFor="c-email2">
          <Input id="c-email2" type="email" value={f.email2} onChange={set('email2')} />
        </Field>
        <Field label={<span className="flex items-center gap-1"><Phone className="size-3.5" /> Phone</span>} htmlFor="c-phone">
          <Input id="c-phone" type="tel" value={f.phone} onChange={set('phone')} />
        </Field>
        <Field label={<span className="flex items-center gap-1"><Building2 className="size-3.5" /> Company</span>} htmlFor="c-org">
          <Input id="c-org" value={f.organization} onChange={set('organization')} />
        </Field>
        <Field label="Job title" htmlFor="c-title" className="sm:col-span-2">
          <Input id="c-title" value={f.title} onChange={set('title')} />
        </Field>
        <Field label="Notes" htmlFor="c-note" className="sm:col-span-2">
          <Textarea id="c-note" value={f.note} onChange={set('note')} />
        </Field>
      </div>
    </Dialog>
  );
}
