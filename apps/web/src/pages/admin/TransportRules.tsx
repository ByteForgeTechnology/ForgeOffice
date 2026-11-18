import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, FlaskConical, ListChecks, Plus, Route, Trash2 } from 'lucide-react';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, PageSpinner, Select, Switch, Table, Td, Textarea, Th, formatDateTime, useToast } from '@forge/ui';
import { ConfirmDialog } from '../../components/admin';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/hooks';
import type { Group } from '../../lib/types';

type Direction = 'all' | 'inbound' | 'outbound' | 'internal';

interface Condition {
  type: string;
  values?: string[];
  scope?: 'internal' | 'external';
  header?: string;
  number?: number;
}

interface Action {
  type: string;
  text?: string;
  html?: string;
  header?: string;
  addresses?: string[];
}

interface Rule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  mode: 'enforce' | 'test';
  appliesTo: Direction;
  conditions: Condition[];
  exceptions: Condition[];
  actions: Action[];
  stopProcessing: boolean;
  priority: number;
  hits30d: number;
}

/** Field kind per condition type: list of values, scope, header + values, or a number. */
const CONDITIONS: Record<string, { label: string; input: 'values' | 'scope' | 'groups' | 'header' | 'number' | 'none'; hint?: string }> = {
  senderAddress: { label: 'Sender is', input: 'values', hint: 'Addresses or domains, e.g. ceo@acme.com, partner.com' },
  senderScope: { label: 'Sender is located', input: 'scope' },
  senderMemberOf: { label: 'Sender is a member of', input: 'groups' },
  recipientAddress: { label: 'A recipient is', input: 'values', hint: 'Addresses or domains' },
  recipientScope: { label: 'A recipient is located', input: 'scope' },
  recipientMemberOf: { label: 'A recipient is a member of', input: 'groups' },
  subjectContains: { label: 'Subject contains any of', input: 'values', hint: 'Words or phrases' },
  subjectOrBodyContains: { label: 'Subject or body contains any of', input: 'values', hint: 'Words or phrases' },
  headerContains: { label: 'A header contains', input: 'header' },
  hasAttachment: { label: 'Has an attachment', input: 'none' },
  attachmentExtension: { label: 'Attachment type is', input: 'values', hint: 'Extensions, e.g. exe, js, iso' },
  attachmentNameContains: { label: 'Attachment name contains', input: 'values' },
  sizeOver: { label: 'Message is larger than (MB)', input: 'number' },
  spamScoreAbove: { label: 'Spam score is above', input: 'number' },
};

const ACTIONS: Record<string, { label: string; input: 'text' | 'header' | 'disclaimer' | 'addresses' | 'none'; terminal?: boolean }> = {
  prependSubject: { label: 'Prefix the subject with', input: 'text' },
  setHeader: { label: 'Set a header', input: 'header' },
  appendDisclaimer: { label: 'Append a disclaimer', input: 'disclaimer' },
  bcc: { label: 'Bcc the message to', input: 'addresses' },
  redirect: { label: 'Redirect the message to', input: 'addresses' },
  junk: { label: 'Deliver to Junk', input: 'none' },
  quarantine: { label: 'Hold in quarantine for admin review', input: 'none', terminal: true },
  reject: { label: 'Reject with the explanation', input: 'text', terminal: true },
  delete: { label: 'Delete without notifying anyone', input: 'none', terminal: true },
};

const DIRECTIONS: Record<Direction, string> = { all: 'All mail', inbound: 'Incoming from outside', outbound: 'Outgoing to outside', internal: 'Internal' };

const list = (s: string) => s.split(/[,\n;]/).map((x) => x.trim()).filter(Boolean);

function describeCondition(c: Condition, groupName: (id: string) => string) {
  const def = CONDITIONS[c.type];
  if (!def) return c.type;
  if (def.input === 'scope') return `${def.label} ${c.scope === 'internal' ? 'inside' : 'outside'} the organisation`;
  if (def.input === 'groups') return `${def.label} ${(c.values ?? []).map(groupName).join(' or ')}`;
  if (def.input === 'header') return `${c.header} contains ${(c.values ?? []).join(' or ') || 'anything'}`;
  if (def.input === 'number') return `${def.label} ${c.type === 'sizeOver' ? ((c.number ?? 0) / 1048576).toFixed(1) : c.number}`;
  if (def.input === 'none') return def.label;
  return `${def.label} ${(c.values ?? []).join(', ')}`;
}

function describeAction(a: Action) {
  const def = ACTIONS[a.type];
  if (!def) return a.type;
  if (def.input === 'text') return `${def.label} “${a.text}”`;
  if (def.input === 'header') return `Set ${a.header}: ${a.text}`;
  if (def.input === 'addresses') return `${def.label} ${(a.addresses ?? []).join(', ')}`;
  return def.label;
}

export function TransportRulesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const canManage = useCan('org:manage');
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Rule | null>(null);
  const [hitsFor, setHitsFor] = useState<Rule | null>(null);
  const [testing, setTesting] = useState(false);
  const rules = useQuery({ queryKey: ['admin', 'transport-rules'], queryFn: () => api<{ items: Rule[] }>('/api/v1/admin/transport-rules') });
  const groups = useQuery({ queryKey: ['admin', 'groups', 'all'], queryFn: () => api<{ items: Group[] }>('/api/v1/admin/groups') });
  const groupName = (id: string) => groups.data?.items.find((g) => g.id === id)?.name ?? 'unknown group';
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'transport-rules'] });

  const save = useMutation({
    mutationFn: (r: Rule) => api(`/api/v1/admin/transport-rules/${r.id}`, { method: 'PUT', body: toBody(r) }),
    onSuccess: () => void refresh(),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const reorder = useMutation({
    mutationFn: (ids: string[]) => api('/api/v1/admin/transport-rules/order', { body: { ids } }),
    onSuccess: () => void refresh(),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/admin/transport-rules/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeleting(null);
      void refresh();
    },
  });
  const move = (i: number, dir: -1 | 1) => {
    const ids = rules.data!.items.map((r) => r.id);
    [ids[i], ids[i + dir]] = [ids[i + dir]!, ids[i]!];
    reorder.mutate(ids);
  };

  return (
    <div>
      <PageHeader
        title="Transport rules"
        description="Organisation-wide policies for mail in transit: tag, add disclaimers, copy, hold or block messages. Rules run in order, once per message."
        actions={
          <>
            <Button icon={<FlaskConical className="size-4" />} onClick={() => setTesting(true)}>
              Test a message
            </Button>
            {canManage && (
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
                New rule
              </Button>
            )}
          </>
        }
      />
      <Card>
        {rules.isLoading ? (
          <PageSpinner />
        ) : !rules.data?.items.length ? (
          <EmptyState icon={<Route />} title="No transport rules" description="For example: prefix [EXTERNAL] on mail from outside, or add a legal disclaimer to outgoing mail." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th className="w-16">Order</Th>
                <Th>Rule</Th>
                <Th className="hidden md:table-cell">Matches (30 days)</Th>
                <Th>On</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {rules.data.items.map((r, i) => (
                <tr key={r.id} className={r.enabled ? '' : 'opacity-60'}>
                  <Td>
                    <span className="flex items-center gap-1">
                      <span className="w-4 text-xs text-zinc-500">{i + 1}</span>
                      {canManage && (
                        <>
                          <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)} className="rounded p-0.5 hover:bg-zinc-100 disabled:opacity-30 dark:hover:bg-zinc-800">
                            <ArrowUp className="size-3.5" />
                          </button>
                          <button type="button" aria-label="Move down" disabled={i === rules.data.items.length - 1} onClick={() => move(i, 1)} className="rounded p-0.5 hover:bg-zinc-100 disabled:opacity-30 dark:hover:bg-zinc-800">
                            <ArrowDown className="size-3.5" />
                          </button>
                        </>
                      )}
                    </span>
                  </Td>
                  <Td>
                    <button type="button" className="text-left" onClick={() => canManage && setEditing(r)}>
                      <span className="flex flex-wrap items-center gap-2 font-medium text-zinc-900 dark:text-zinc-100">
                        {r.name}
                        <Badge>{DIRECTIONS[r.appliesTo]}</Badge>
                        {r.mode === 'test' && <Badge tone="warning">Test mode</Badge>}
                        {r.stopProcessing && <Badge tone="info">Stops later rules</Badge>}
                      </span>
                      <span className="mt-0.5 block text-xs text-zinc-500">
                        {r.conditions.length ? `If ${r.conditions.map((c) => describeCondition(c, groupName)).join(' and ')}` : 'For every message'}
                        {r.exceptions.length > 0 && `, except if ${r.exceptions.map((c) => describeCondition(c, groupName)).join(' or ')}`}
                        {' → '}
                        {r.actions.map(describeAction).join('; ')}
                      </span>
                    </button>
                  </Td>
                  <Td className="hidden md:table-cell">
                    <button type="button" className="inline-flex items-center gap-1 text-sm text-brand hover:underline" onClick={() => setHitsFor(r)}>
                      <ListChecks className="size-3.5" /> {r.hits30d}
                    </button>
                  </Td>
                  <Td>
                    <Switch label={<span className="sr-only">Enabled</span>} checked={r.enabled} disabled={!canManage} onChange={(v) => save.mutate({ ...r, enabled: v })} />
                  </Td>
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
      {editing && <RuleDialog rule={editing === 'new' ? null : editing} groups={groups.data?.items ?? []} onClose={() => setEditing(null)} />}
      {hitsFor && <HitsDialog rule={hitsFor} onClose={() => setHitsFor(null)} />}
      {testing && <TestDialog onClose={() => setTesting(false)} />}
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={() => deleting && remove.mutate(deleting.id)} title={`Delete “${deleting?.name}”?`} danger confirmLabel="Delete rule" busy={remove.isPending}>
        Mail will no longer be affected by this rule. Consider switching it off instead if you may need it again.
      </ConfirmDialog>
    </div>
  );
}

function toBody(r: Omit<Rule, 'id' | 'priority' | 'hits30d'>) {
  return {
    name: r.name,
    description: r.description,
    enabled: r.enabled,
    mode: r.mode,
    appliesTo: r.appliesTo,
    conditions: r.conditions,
    exceptions: r.exceptions,
    actions: r.actions,
    stopProcessing: r.stopProcessing,
  };
}

function ConditionEditor({ items, onChange, groups, label, addLabel }: { items: Condition[]; onChange: (c: Condition[]) => void; groups: Group[]; label: string; addLabel: string }) {
  const update = (i: number, c: Partial<Condition>) => onChange(items.map((x, j) => (j === i ? { ...x, ...c } : x)));
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-medium">{label}</legend>
      {items.map((c, i) => {
        const def = CONDITIONS[c.type]!;
        return (
          <div key={i} className="flex flex-wrap items-start gap-2 rounded-lg bg-zinc-50 p-2 dark:bg-zinc-800/50">
            <Select aria-label="Condition" value={c.type} onChange={(e) => onChange(items.map((x, j) => (j === i ? { type: e.target.value, scope: 'external' } : x)))} className="w-60">
              {Object.entries(CONDITIONS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </Select>
            {def.input === 'values' && (
              <Input aria-label="Values" className="min-w-48 flex-1" placeholder={def.hint} value={(c.values ?? []).join(', ')} onChange={(e) => update(i, { values: list(e.target.value) })} />
            )}
            {def.input === 'scope' && (
              <Select aria-label="Location" value={c.scope ?? 'external'} onChange={(e) => update(i, { scope: e.target.value as 'internal' | 'external' })} className="w-56">
                <option value="external">outside the organisation</option>
                <option value="internal">inside the organisation</option>
              </Select>
            )}
            {def.input === 'groups' && (
              <Select aria-label="Group" value={c.values?.[0] ?? ''} onChange={(e) => update(i, { values: e.target.value ? [e.target.value] : [] })} className="flex-1">
                <option value="">Choose a group…</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            )}
            {def.input === 'header' && (
              <>
                <Input aria-label="Header name" className="w-44" placeholder="X-Mailer" value={c.header ?? ''} onChange={(e) => update(i, { header: e.target.value })} />
                <Input aria-label="Contains" className="min-w-40 flex-1" placeholder="Any of (leave empty for “present”)" value={(c.values ?? []).join(', ')} onChange={(e) => update(i, { values: list(e.target.value) })} />
              </>
            )}
            {def.input === 'number' && (
              <Input
                aria-label="Value"
                type="number"
                min={0}
                step="any"
                className="w-32"
                value={c.type === 'sizeOver' ? (c.number ?? 0) / 1048576 : (c.number ?? '')}
                onChange={(e) => update(i, { number: c.type === 'sizeOver' ? Math.round(Number(e.target.value) * 1048576) : Number(e.target.value) })}
              />
            )}
            <Button variant="ghost" aria-label="Remove" onClick={() => onChange(items.filter((_, j) => j !== i))}>
              <Trash2 className="size-4" />
            </Button>
          </div>
        );
      })}
      <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => onChange([...items, { type: 'senderScope', scope: 'external' }])}>
        {addLabel}
      </Button>
    </fieldset>
  );
}

function RuleDialog({ rule, groups, onClose }: { rule: Rule | null; groups: Group[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<Omit<Rule, 'id' | 'priority' | 'hits30d'>>(
    rule ?? {
      name: '',
      description: '',
      enabled: true,
      mode: 'test',
      appliesTo: 'inbound',
      conditions: [{ type: 'senderScope', scope: 'external' }],
      exceptions: [],
      actions: [{ type: 'prependSubject', text: '[EXTERNAL]' }],
      stopProcessing: false,
    },
  );
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => (rule ? api(`/api/v1/admin/transport-rules/${rule.id}`, { method: 'PUT', body: toBody(f) }) : api('/api/v1/admin/transport-rules', { body: toBody(f) })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'transport-rules'] });
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const setAction = (i: number, a: Partial<Action>) => setF({ ...f, actions: f.actions.map((x, j) => (j === i ? { ...x, ...a } : x)) });

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={rule ? `Edit “${rule.name}”` : 'New transport rule'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!f.name || !f.actions.length} onClick={() => save.mutate()}>
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
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="tr-name" className="sm:col-span-2">
            <Input id="tr-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Tag external mail" />
          </Field>
          <Field label="Applies to" htmlFor="tr-dir">
            <Select id="tr-dir" value={f.appliesTo} onChange={(e) => setF({ ...f, appliesTo: e.target.value as Direction })}>
              {Object.entries(DIRECTIONS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Mode" htmlFor="tr-mode" hint={f.mode === 'test' ? 'Matches are recorded but no message is changed.' : undefined}>
            <Select id="tr-mode" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value as 'enforce' | 'test' })}>
              <option value="enforce">Enforce</option>
              <option value="test">Test (record matches only)</option>
            </Select>
          </Field>
        </div>
        <ConditionEditor label="Apply when all of these are true (none = every message)" addLabel="Add condition" items={f.conditions} groups={groups} onChange={(conditions) => setF({ ...f, conditions })} />
        <ConditionEditor label="Except if any of these are true" addLabel="Add exception" items={f.exceptions} groups={groups} onChange={(exceptions) => setF({ ...f, exceptions })} />
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">Do the following</legend>
          {f.actions.map((a, i) => {
            const def = ACTIONS[a.type]!;
            return (
              <div key={i} className="space-y-2 rounded-lg bg-zinc-50 p-2 dark:bg-zinc-800/50">
                <div className="flex flex-wrap items-start gap-2">
                  <Select aria-label="Action" value={a.type} onChange={(e) => setF({ ...f, actions: f.actions.map((x, j) => (j === i ? { type: e.target.value } : x)) })} className="w-72">
                    {Object.entries(ACTIONS)
                      .filter(([k]) => k !== 'junk' || f.appliesTo === 'inbound')
                      .map(([k, v]) => (
                        <option key={k} value={k}>
                          {v.label}
                        </option>
                      ))}
                  </Select>
                  {def.input === 'text' && <Input aria-label="Text" className="min-w-48 flex-1" value={a.text ?? ''} onChange={(e) => setAction(i, { text: e.target.value })} />}
                  {def.input === 'header' && (
                    <>
                      <Input aria-label="Header" className="w-48" placeholder="X-Classification" value={a.header ?? ''} onChange={(e) => setAction(i, { header: e.target.value })} />
                      <Input aria-label="Value" className="min-w-32 flex-1" value={a.text ?? ''} onChange={(e) => setAction(i, { text: e.target.value })} />
                    </>
                  )}
                  {def.input === 'addresses' && (
                    <Input aria-label="Addresses" className="min-w-48 flex-1" placeholder="archive@example.com" value={(a.addresses ?? []).join(', ')} onChange={(e) => setAction(i, { addresses: list(e.target.value) })} />
                  )}
                  <Button variant="ghost" aria-label="Remove action" onClick={() => setF({ ...f, actions: f.actions.filter((_, j) => j !== i) })}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
                {def.input === 'disclaimer' && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Textarea aria-label="Plain-text disclaimer" rows={3} placeholder="Plain text" value={a.text ?? ''} onChange={(e) => setAction(i, { text: e.target.value })} />
                    <Textarea aria-label="HTML disclaimer" rows={3} placeholder="HTML (optional)" value={a.html ?? ''} onChange={(e) => setAction(i, { html: e.target.value })} />
                  </div>
                )}
                {def.terminal && <p className="text-xs text-zinc-500">The message is not delivered normally; later actions are ignored.</p>}
              </div>
            );
          })}
          <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setF({ ...f, actions: [...f.actions, { type: 'setHeader', header: 'X-', text: '' }] })}>
            Add action
          </Button>
        </fieldset>
        <Switch checked={f.stopProcessing} onChange={(v) => setF({ ...f, stopProcessing: v })} label="Stop processing more rules" description="When this rule matches, rules after it are skipped." />
        <Field label="Notes (optional)" htmlFor="tr-desc">
          <Textarea id="tr-desc" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}

function HitsDialog({ rule, onClose }: { rule: Rule; onClose: () => void }) {
  const hits = useQuery({
    queryKey: ['admin', 'transport-rule-hits', rule.id],
    queryFn: () => api<{ items: { id: number; direction: string; sender: string; recipients: string[]; subject: string; mode: string; actions: string[]; createdAt: string }[] }>(`/api/v1/admin/transport-rules/${rule.id}/hits`),
  });
  return (
    <Dialog open onClose={onClose} size="lg" title={`Recent matches: ${rule.name}`} description="Messages this rule matched in the last 30 days.">
      {hits.isLoading ? (
        <PageSpinner />
      ) : !hits.data?.items.length ? (
        <EmptyState title="No matches yet" />
      ) : (
        <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
          {hits.data.items.map((h) => (
            <li key={h.id} className="py-2">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{h.subject || '(no subject)'}</span>
                {h.mode === 'test' && <Badge tone="warning">test</Badge>}
                <span className="ml-auto text-xs text-zinc-500">{formatDateTime(h.createdAt)}</span>
              </p>
              <p className="truncate text-xs text-zinc-500">
                {h.sender} → {h.recipients.join(', ')} · {h.actions.join('; ')}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function TestDialog({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ direction: 'inbound', from: '', to: '', subject: '', body: '', attachments: '', includeDisabled: false });
  const run = useMutation({
    mutationFn: () =>
      api<{ matched: { name: string; mode: string; actions: string[] }[]; result: { verdict: string; message?: string; reason?: string; recipients?: string[]; subject?: string; body?: string } }>(
        '/api/v1/admin/transport-rules/test',
        { body: { direction: f.direction, from: f.from, to: list(f.to), subject: f.subject, body: f.body, attachmentNames: list(f.attachments), includeDisabled: f.includeDisabled } },
      ),
  });
  const r = run.data;
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Test a message"
      description="See which rules a message would match and what would happen. Nothing is sent or recorded."
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" loading={run.isPending} disabled={!f.from || !f.to} onClick={() => run.mutate()}>
            Run test
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Direction" htmlFor="t-dir">
          <Select id="t-dir" value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}>
            <option value="inbound">Incoming from outside</option>
            <option value="outbound">Outgoing to outside</option>
            <option value="internal">Internal</option>
          </Select>
        </Field>
        <Field label="From" htmlFor="t-from">
          <Input id="t-from" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        </Field>
        <Field label="To" htmlFor="t-to" className="sm:col-span-2">
          <Input id="t-to" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} placeholder="Comma-separated" />
        </Field>
        <Field label="Subject" htmlFor="t-subj" className="sm:col-span-2">
          <Input id="t-subj" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} />
        </Field>
        <Field label="Body" htmlFor="t-body" className="sm:col-span-2">
          <Textarea id="t-body" rows={3} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
        </Field>
        <Field label="Attachment names" htmlFor="t-att">
          <Input id="t-att" value={f.attachments} onChange={(e) => setF({ ...f, attachments: e.target.value })} placeholder="invoice.pdf, setup.exe" />
        </Field>
        <div className="flex items-end pb-2">
          <Switch checked={f.includeDisabled} onChange={(v) => setF({ ...f, includeDisabled: v })} label="Include switched-off rules" />
        </div>
      </div>
      {run.error && (
        <Alert tone="danger" className="mt-4">
          {errorMessage(run.error)}
        </Alert>
      )}
      {r && (
        <div className="mt-5 space-y-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <p className="text-sm font-medium">Matched rules</p>
          {r.matched.length ? (
            <ul className="space-y-1 text-sm">
              {r.matched.map((m, i) => (
                <li key={i}>
                  <span className="font-medium">{m.name}</span> {m.mode === 'test' && <Badge tone="warning">test only</Badge>} <span className="text-zinc-500">— {m.actions.join('; ')}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-zinc-500">No rules match this message.</p>
          )}
          <Alert tone={r.result.verdict === 'delivered' ? 'success' : r.result.verdict === 'junk' ? 'warning' : 'danger'} title={`Result: ${r.result.verdict}`}>
            {r.result.message && <p>Sender is told: “{r.result.message}”</p>}
            {r.result.reason && <p>{r.result.reason}</p>}
            {r.result.recipients && <p>Delivered to: {r.result.recipients.join(', ')}</p>}
            {r.result.subject !== undefined && <p>Subject: {r.result.subject}</p>}
          </Alert>
          {r.result.body !== undefined && r.result.body !== f.body && <pre className="max-h-48 overflow-auto rounded-lg bg-zinc-100 p-3 text-xs whitespace-pre-wrap dark:bg-zinc-800">{r.result.body}</pre>}
        </div>
      )}
    </Dialog>
  );
}
