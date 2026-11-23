import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog, EmptyState, Field, Input, PageHeader, PageSpinner, Select, Switch, Textarea, useToast } from '@forge/ui';
import { api, errorMessage } from '../../lib/api';
import type { MailboxInfo } from '../../lib/mail-types';
import { SenderLists } from '../../components/SenderLists';

interface Settings {
  identities: string[];
  undoSendSeconds: number;
  autoReply: { enabled: boolean; subject: string; body: string; startsAt: string | null; endsAt: string | null; internalOnly: boolean };
  connection: { hostname: string; imap: { port: number; security: string }; smtp: { port: number; security: string }; caldav: string; carddav: string };
}

interface Condition {
  field: string;
  op: string;
  value?: string;
}
interface Action {
  type: string;
  value?: string;
}
interface Filter {
  id: string;
  name: string;
  enabled: boolean;
  match: 'all' | 'any';
  conditions: Condition[];
  actions: Action[];
}

const toLocal = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');

export function MailSettingsPage() {
  const settings = useQuery({ queryKey: ['mail', 'settings'], queryFn: () => api<Settings>('/api/v1/mail/settings') });
  if (!settings.data) return <PageSpinner />;
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link to="/mail" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
        <ArrowLeft className="size-4" /> Back to mail
      </Link>
      <PageHeader title="Mail settings" description={`Your addresses: ${settings.data.identities.join(', ')}`} />
      <AutoReplyCard initial={settings.data.autoReply} />
      <RulesCard />
      <Card>
        <CardHeader title="Blocked and allowed senders" description="Use addresses or whole domains. Your organisation may also have its own lists." />
        <CardBody>
          <SenderLists base="/api/v1/mail/sender-lists" scope="mailbox" />
        </CardBody>
      </Card>
      <ConnectCard s={settings.data} />
    </div>
  );
}

function AutoReplyCard({ initial }: { initial: Settings['autoReply'] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ ...initial, startsAt: toLocal(initial.startsAt), endsAt: toLocal(initial.endsAt) });
  const save = useMutation({
    mutationFn: () =>
      api('/api/v1/mail/auto-reply', {
        method: 'PUT',
        body: { ...f, startsAt: f.startsAt ? new Date(f.startsAt).toISOString() : null, endsAt: f.endsAt ? new Date(f.endsAt).toISOString() : null },
      }),
    onSuccess: () => {
      toast.success(f.enabled ? 'Automatic replies are on' : 'Automatic replies are off');
      void qc.invalidateQueries({ queryKey: ['mail', 'settings'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card>
      <CardHeader title="Automatic replies" description="Let people know you are away. Each sender gets one reply every four days; mailing lists never do." actions={f.enabled && <Badge tone="warning">On</Badge>} />
      <CardBody className="space-y-4">
        <Switch checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label="Send automatic replies" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Start (optional)" htmlFor="ar-start">
            <Input id="ar-start" type="datetime-local" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} />
          </Field>
          <Field label="End (optional)" htmlFor="ar-end">
            <Input id="ar-end" type="datetime-local" value={f.endsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} />
          </Field>
        </div>
        <Field label="Subject" htmlFor="ar-subject">
          <Input id="ar-subject" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} />
        </Field>
        <Field label="Message" htmlFor="ar-body">
          <Textarea id="ar-body" rows={5} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} placeholder="I'm out of the office until Monday and will reply when I'm back." />
        </Field>
        <Switch checked={f.internalOnly} onChange={(v) => setF({ ...f, internalOnly: v })} label="Only reply to people in my organisation" />
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </CardBody>
    </Card>
  );
}

const FIELDS = [
  { value: 'from', label: 'From' },
  { value: 'to', label: 'To' },
  { value: 'cc', label: 'Cc' },
  { value: 'subject', label: 'Subject' },
  { value: 'body', label: 'Body' },
  { value: 'hasAttachment', label: 'Has attachment' },
  { value: 'size', label: 'Size (bytes)' },
];
const OPS = [
  { value: 'contains', label: 'contains' },
  { value: 'notContains', label: 'does not contain' },
  { value: 'equals', label: 'is' },
  { value: 'startsWith', label: 'starts with' },
  { value: 'endsWith', label: 'ends with' },
  { value: 'matches', label: 'matches pattern' },
];
const ACTIONS = [
  { value: 'move', label: 'Move to folder' },
  { value: 'markRead', label: 'Mark as read' },
  { value: 'flag', label: 'Flag' },
  { value: 'delete', label: 'Move to Trash' },
  { value: 'forward', label: 'Forward to' },
  { value: 'stop', label: 'Stop processing more rules' },
];

function RulesCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<Filter | 'new' | null>(null);
  const filters = useQuery({ queryKey: ['mail', 'filters'], queryFn: () => api<{ items: Filter[] }>('/api/v1/mail/filters') });
  const folders = useQuery({ queryKey: ['mail', 'mailboxes'], queryFn: () => api<{ items: MailboxInfo[] }>('/api/v1/mail/mailboxes') });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/mail/filters/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['mail', 'filters'] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const describe = (f: Filter) =>
    `${f.conditions.map((c) => (c.field === 'hasAttachment' ? 'has an attachment' : `${FIELDS.find((x) => x.value === c.field)?.label.toLowerCase()} ${OPS.find((o) => o.value === c.op)?.label ?? c.op} “${c.value}”`)).join(f.match === 'any' ? ' or ' : ' and ')} → ${f.actions
      .map((a) => (a.type === 'move' ? `move to ${folders.data?.items.find((b) => b.id === a.value)?.name ?? '?'}` : a.type === 'forward' ? `forward to ${a.value}` : ACTIONS.find((x) => x.value === a.type)?.label.toLowerCase()))
      .join(', ')}`;
  return (
    <Card>
      <CardHeader
        title="Rules"
        description="Run on the server as mail arrives, so they apply in every app."
        actions={
          <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            New rule
          </Button>
        }
      />
      {!filters.data?.items.length ? (
        <EmptyState title="No rules yet" description="Sort newsletters into folders, flag mail from your manager, and more." />
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {filters.data.items.map((f) => (
            <li key={f.id} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1 cursor-pointer" onClick={() => setEditing(f)}>
                <p className="text-sm font-medium">
                  {f.name} {!f.enabled && <Badge>Off</Badge>}
                </p>
                <p className="truncate text-xs text-zinc-500">{describe(f)}</p>
              </div>
              <Button size="sm" variant="ghost" aria-label={`Delete ${f.name}`} onClick={() => remove.mutate(f.id)}>
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {editing && <RuleDialog filter={editing === 'new' ? null : editing} folders={folders.data?.items ?? []} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function RuleDialog({ filter, folders, onClose }: { filter: Filter | null; folders: MailboxInfo[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<Omit<Filter, 'id'>>(
    filter ?? { name: '', enabled: true, match: 'all', conditions: [{ field: 'from', op: 'contains', value: '' }], actions: [{ type: 'move', value: folders.find((b) => b.specialUse === '\\Archive')?.id }] },
  );
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => (filter ? api(`/api/v1/mail/filters/${filter.id}`, { method: 'PUT', body: f }) : api('/api/v1/mail/filters', { body: f })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['mail', 'filters'] });
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const setCond = (i: number, c: Partial<Condition>) => setF({ ...f, conditions: f.conditions.map((x, j) => (j === i ? { ...x, ...c } : x)) });
  const setAct = (i: number, a: Partial<Action>) => setF({ ...f, actions: f.actions.map((x, j) => (j === i ? { ...x, ...a } : x)) });
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={filter ? 'Edit rule' : 'New rule'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!f.name} onClick={() => save.mutate()}>
            Save rule
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      <div className="space-y-5">
        <Field label="Name" htmlFor="rule-name">
          <Input id="rule-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Newsletters" />
        </Field>
        <fieldset className="space-y-2">
          <legend className="mb-1 flex items-center gap-2 text-sm font-medium">
            When a message arrives and
            <Select value={f.match} onChange={(e) => setF({ ...f, match: e.target.value as 'all' | 'any' })} className="h-8 w-auto py-0">
              <option value="all">all</option>
              <option value="any">any</option>
            </Select>
            of these match:
          </legend>
          {f.conditions.map((c, i) => (
            <div key={i} className="flex flex-wrap gap-2">
              <Select aria-label="Field" value={c.field} onChange={(e) => setCond(i, { field: e.target.value, op: e.target.value === 'size' ? 'greaterThan' : e.target.value === 'hasAttachment' ? 'isTrue' : c.op })} className="w-40">
                {FIELDS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              {c.field === 'size' ? (
                <Select aria-label="Comparison" value={c.op} onChange={(e) => setCond(i, { op: e.target.value })} className="w-40">
                  <option value="greaterThan">larger than</option>
                  <option value="lessThan">smaller than</option>
                </Select>
              ) : c.field !== 'hasAttachment' ? (
                <Select aria-label="Comparison" value={c.op} onChange={(e) => setCond(i, { op: e.target.value })} className="w-44">
                  {OPS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              ) : null}
              {c.field !== 'hasAttachment' && <Input aria-label="Value" value={c.value ?? ''} onChange={(e) => setCond(i, { value: e.target.value })} className="min-w-40 flex-1" />}
              {f.conditions.length > 1 && (
                <Button variant="ghost" aria-label="Remove condition" onClick={() => setF({ ...f, conditions: f.conditions.filter((_, j) => j !== i) })}>
                  <Trash2 className="size-4" />
                </Button>
              )}
            </div>
          ))}
          <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setF({ ...f, conditions: [...f.conditions, { field: 'subject', op: 'contains', value: '' }] })}>
            Add condition
          </Button>
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">Do this:</legend>
          {f.actions.map((a, i) => (
            <div key={i} className="flex flex-wrap gap-2">
              <Select aria-label="Action" value={a.type} onChange={(e) => setAct(i, { type: e.target.value, value: undefined })} className="w-56">
                {ACTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              {a.type === 'move' && (
                <Select aria-label="Folder" value={a.value ?? ''} onChange={(e) => setAct(i, { value: e.target.value })} className="flex-1">
                  <option value="">Choose folder…</option>
                  {folders.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              )}
              {a.type === 'forward' && <Input aria-label="Forward to" type="email" placeholder="name@example.com" value={a.value ?? ''} onChange={(e) => setAct(i, { value: e.target.value })} className="flex-1" />}
              {f.actions.length > 1 && (
                <Button variant="ghost" aria-label="Remove action" onClick={() => setF({ ...f, actions: f.actions.filter((_, j) => j !== i) })}>
                  <Trash2 className="size-4" />
                </Button>
              )}
            </div>
          ))}
          <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setF({ ...f, actions: [...f.actions, { type: 'markRead' }] })}>
            Add action
          </Button>
        </fieldset>
        <Switch checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label="Rule is on" />
      </div>
    </Dialog>
  );
}

function ConnectCard({ s }: { s: Settings }) {
  const rows = [
    ['Incoming (IMAP)', `${s.connection.hostname}, port ${s.connection.imap.port}, ${s.connection.imap.security}`],
    ['Outgoing (SMTP)', `${s.connection.hostname}, port ${s.connection.smtp.port}, ${s.connection.smtp.security}, authentication required`],
    ['Calendar & contacts (CalDAV / CardDAV)', s.connection.caldav],
    ['Username', 'Your full email address'],
  ];
  useEffect(() => void 0, []);
  return (
    <Card>
      <CardHeader title="Use mail on your desktop or phone" description="Thunderbird, Apple Mail, Outlook, iOS, Android (DAVx⁵ for calendars and contacts)." />
      <CardBody className="space-y-3">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-zinc-500">{k}</dt>
              <dd className="font-mono text-xs break-all sm:text-sm">{v}</dd>
            </div>
          ))}
        </dl>
        <Alert tone="info" title="Using two-step verification?">
          Mail and calendar apps can’t ask for a code, so sign them in with an{' '}
          <Link to="/account#app-passwords" className="font-medium underline">
            app password
          </Link>{' '}
          instead of your normal password.
        </Alert>
      </CardBody>
    </Card>
  );
}
