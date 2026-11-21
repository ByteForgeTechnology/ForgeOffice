import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, Columns3, Download, List as ListIcon, Plus, Search, Settings2, Trash2, X } from 'lucide-react';
import { Alert, Avatar, Badge, Button, Dialog, EmptyState, Field, Input, PageSpinner, Select, Switch, Textarea, cn, formatRelative, useToast, type Tone } from '@forge/ui';
import { api, errorMessage } from '../../lib/api';

export interface ListColumn {
  id: string;
  name: string;
  type: 'text' | 'note' | 'number' | 'choice' | 'date' | 'boolean' | 'person' | 'link';
  required?: boolean;
  choices?: string[];
  withTime?: boolean;
}
interface ListInfo {
  id: string;
  name: string;
  description: string;
  columns: ListColumn[];
  itemCount?: number;
  updatedAt?: string;
}
interface ListItem {
  id: string;
  values: Record<string, unknown>;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}
type People = Record<string, { name: string; email: string | null }>;
interface ListData {
  list: ListInfo;
  canEdit: boolean;
  items: ListItem[];
  people: People;
}
interface SiteRef {
  id: string;
  slug: string;
  canEdit: boolean;
}

const TYPE_LABELS: Record<ListColumn['type'], string> = {
  text: 'Single line of text',
  note: 'Multiple lines of text',
  number: 'Number',
  choice: 'Choice',
  date: 'Date',
  boolean: 'Yes/No',
  person: 'Person',
  link: 'Hyperlink',
};
const TEMPLATE_LABELS: Record<string, string> = { blank: 'Blank list', tasks: 'Tasks', issues: 'Issue tracker', contacts: 'Contacts', events: 'Events' };
const CHOICE_TONES: Tone[] = ['info', 'success', 'warning', 'danger', 'brand', 'neutral'];

const listKey = (siteId: string, listId: string) => ['sites', 'list', siteId, listId];

// ---------------------------------------------------------------------------
// Values: display, sorting and CSV
// ---------------------------------------------------------------------------

function formatDate(v: string, withTime?: boolean) {
  const d = new Date(withTime ? v : `${v}T00:00:00`);
  return withTime ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

function plainValue(col: ListColumn, v: unknown, people: People): string {
  if (v === undefined || v === null || v === '') return '';
  if (col.type === 'boolean') return v ? 'Yes' : 'No';
  if (col.type === 'person') return people[v as string]?.name ?? 'Unknown person';
  if (col.type === 'date') return formatDate(v as string, col.withTime);
  return String(v);
}

function sortValue(col: ListColumn, v: unknown, people: People): string | number {
  if (v === undefined || v === null || v === '') return '';
  if (col.type === 'number') return v as number;
  if (col.type === 'choice') return col.choices?.indexOf(v as string) ?? 0;
  if (col.type === 'boolean') return v ? 1 : 0;
  if (col.type === 'date') return String(v);
  return plainValue(col, v, people).toLowerCase();
}

function Value({ col, value, people }: { col: ListColumn; value: unknown; people: People }) {
  if (value === undefined || value === null || value === '') return <span className="text-zinc-400">—</span>;
  switch (col.type) {
    case 'choice': {
      const i = col.choices?.indexOf(value as string) ?? -1;
      return <Badge tone={CHOICE_TONES[(i < 0 ? 5 : i) % CHOICE_TONES.length]}>{String(value)}</Badge>;
    }
    case 'boolean':
      return <span>{value ? 'Yes' : 'No'}</span>;
    case 'person': {
      const p = people[value as string];
      return (
        <span className="inline-flex items-center gap-1.5">
          <Avatar name={p?.name ?? '?'} size="sm" />
          {p?.name ?? 'Unknown person'}
        </span>
      );
    }
    case 'link':
      return (
        <a href={value as string} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline" onClick={(e) => e.stopPropagation()}>
          {(value as string).replace(/^(https?:\/\/|mailto:)/i, '').replace(/\/$/, '')}
        </a>
      );
    case 'note':
      return <span className="line-clamp-2 whitespace-pre-line">{String(value)}</span>;
    case 'number':
      return <span className="tabular-nums">{(value as number).toLocaleString()}</span>;
    case 'date':
      return <span className="whitespace-nowrap">{formatDate(value as string, col.withTime)}</span>;
    default:
      return <span>{String(value)}</span>;
  }
}

function exportCsv(data: ListData) {
  const cell = (s: string) => (/[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s);
  const rows = [data.list.columns.map((c) => cell(c.name)).join(',')];
  for (const i of data.items) rows.push(data.list.columns.map((c) => cell(plainValue(c, i.values[c.id], data.people))).join(','));
  const blob = new Blob([`﻿${rows.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${data.list.name}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------------------
// The list page
// ---------------------------------------------------------------------------

export function ListView({ site, listId }: { site: SiteRef; listId: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<{ col: string; desc: boolean } | null>(null);
  const [editing, setEditing] = useState<ListItem | 'new' | null>(null);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const q = useQuery({ queryKey: listKey(site.id, listId), queryFn: () => api<ListData>(`/api/v1/sites/${site.id}/lists/${listId}`) });
  useEffect(() => {
    setFilter('');
    setSort(null);
  }, [listId]);

  const rows = useMemo(() => {
    if (!q.data) return [];
    const { list, items, people } = q.data;
    const needle = filter.trim().toLowerCase();
    let out = needle ? items.filter((i) => list.columns.some((c) => plainValue(c, i.values[c.id], people).toLowerCase().includes(needle))) : items;
    const col = sort && list.columns.find((c) => c.id === sort.col);
    if (col) {
      out = [...out].sort((a, b) => {
        const x = sortValue(col, a.values[col.id], people);
        const y = sortValue(col, b.values[col.id], people);
        // Empty values last, whichever way round.
        if (x === '' || y === '') return x === y ? 0 : x === '' ? 1 : -1;
        const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
        return sort!.desc ? -r : r;
      });
    }
    return out;
  }, [q.data, filter, sort]);

  if (q.error) return <EmptyState icon={<ListIcon />} title="List not found" description="It may have been deleted." />;
  if (!q.data) return <PageSpinner />;
  const { list, canEdit, people } = q.data;
  const shown = list.columns.slice(0, 8);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold">{list.name}</h1>
          {list.description && <p className="text-sm text-zinc-500">{list.description}</p>}
        </div>
        {canEdit && (
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            New item
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-zinc-400" />
          <Input aria-label="Filter items" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter items" className="pl-9" />
        </div>
        <span className="text-sm text-zinc-500">
          {rows.length === q.data.items.length ? `${q.data.items.length} items` : `${rows.length} of ${q.data.items.length} items`}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" icon={<Download className="size-4" />} onClick={() => exportCsv(q.data!)}>
            Export to CSV
          </Button>
          {canEdit && (
            <>
              <Button size="sm" variant="ghost" icon={<Columns3 className="size-4" />} onClick={() => setColumnsOpen(true)}>
                Columns
              </Button>
              <Button size="sm" variant="ghost" icon={<Settings2 className="size-4" />} onClick={() => setSettingsOpen(true)}>
                List settings
              </Button>
            </>
          )}
        </div>
      </div>

      {!q.data.items.length ? (
        <EmptyState icon={<ListIcon />} title="No items yet" description={canEdit ? 'Add the first item with “New item”.' : 'Nothing has been added to this list.'} />
      ) : (
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {shown.map((c) => {
                  const active = sort?.col === c.id;
                  return (
                    <th key={c.id} className="border-b border-zinc-200 px-3 py-2 font-medium whitespace-nowrap dark:border-zinc-800" aria-sort={active ? (sort!.desc ? 'descending' : 'ascending') : 'none'}>
                      <button type="button" className="inline-flex items-center gap-1 hover:text-brand" onClick={() => setSort(active ? (sort!.desc ? null : { col: c.id, desc: true }) : { col: c.id, desc: false })}>
                        {c.name}
                        {active && (sort!.desc ? <ArrowDown className="size-3.5" /> : <ArrowUp className="size-3.5" />)}
                      </button>
                    </th>
                  );
                })}
                <th className="border-b border-zinc-200 px-3 py-2 font-medium whitespace-nowrap text-zinc-500 dark:border-zinc-800">Modified</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id} className="cursor-pointer border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800/70 dark:hover:bg-zinc-800/50" onClick={() => setEditing(i)}>
                  {shown.map((c, n) => (
                    <td key={c.id} className={cn('max-w-72 px-3 py-2 align-top', n === 0 && 'font-medium')}>
                      <Value col={c} value={i.values[c.id]} people={people} />
                    </td>
                  ))}
                  <td className="px-3 py-2 align-top whitespace-nowrap text-zinc-500">{formatRelative(i.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.columns.length > shown.length && <p className="text-xs text-zinc-500">Open an item to see all {list.columns.length} columns.</p>}

      {editing && <ItemDialog site={site} data={q.data} item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {columnsOpen && <ColumnsDialog site={site} list={list} onClose={() => setColumnsOpen(false)} />}
      {settingsOpen && (
        <ListSettingsDialog
          site={site}
          list={list}
          onClose={() => setSettingsOpen(false)}
          onDeleted={() => {
            toast.success(`“${list.name}” deleted`);
            void qc.invalidateQueries({ queryKey: ['sites'] });
            navigate(`/sites/${site.slug}`);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item form
// ---------------------------------------------------------------------------

function PersonPicker({ id, value, people, onChange }: { id: string; value: string | null; people: People; onChange: (id: string | null, person?: { name: string; email: string | null }) => void }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const term = text.trim();
  const results = useQuery({
    queryKey: ['directory', 'people', term],
    queryFn: () => api<{ people: { id: string; displayName: string; email: string | null; jobTitle?: string | null }[] }>(`/api/v1/directory/search?q=${encodeURIComponent(term)}&limit=8`),
    enabled: term.length > 0,
  });
  if (value)
    return (
      <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 ring-1 ring-zinc-200 dark:ring-zinc-700">
        <Avatar name={people[value]?.name ?? '?'} size="sm" />
        <span className="min-w-0 flex-1 truncate text-sm">{people[value]?.name ?? 'Unknown person'}</span>
        <button type="button" aria-label="Remove person" onClick={() => onChange(null)} className="rounded p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800">
          <X className="size-3.5" />
        </button>
      </div>
    );
  return (
    <div className="relative">
      <Input id={id} value={text} placeholder="Search for a person" autoComplete="off" onChange={(e) => (setText(e.target.value), setOpen(true))} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {open && term && !!results.data?.people.length && (
        <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg bg-white py-1 shadow-lg ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-700">
          {results.data.people.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(p.id, { name: p.displayName, email: p.email });
                  setText('');
                }}
              >
                <Avatar name={p.displayName} size="sm" />
                <span className="min-w-0 flex-1 truncate">
                  {p.displayName}
                  {p.jobTitle && <span className="text-zinc-500"> · {p.jobTitle}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The value as an <input> wants it, and back. */
const toInput = (c: ListColumn, v: unknown) => {
  if (v === undefined || v === null) return c.type === 'boolean' ? false : '';
  if (c.type === 'date' && c.withTime) {
    const d = new Date(v as string);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  }
  return v;
};
const fromInput = (c: ListColumn, v: unknown) => {
  if (v === '' || v === undefined) return null;
  if (c.type === 'date' && c.withTime) return new Date(v as string).toISOString();
  if (c.type === 'number') return Number(v);
  return v;
};

function ItemDialog({ site, data, item, onClose }: { site: SiteRef; data: ListData; item: ListItem | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { list, canEdit } = data;
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(list.columns.map((c) => [c.id, toInput(c, item?.values[c.id])])));
  const [people, setPeople] = useState<People>(data.people);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/v1/sites/${site.id}/lists/${list.id}/items`;
  const save = useMutation({
    mutationFn: () => {
      const body = { values: Object.fromEntries(list.columns.map((c) => [c.id, fromInput(c, values[c.id])])) };
      return item ? api(`${base}/${item.id}`, { method: 'PATCH', body }) : api(base, { body });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: listKey(site.id, list.id) });
      toast.success(item ? 'Item saved' : 'Item added');
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => api(`${base}/${item!.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: listKey(site.id, list.id) });
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const set = (id: string, v: unknown) => setValues((x) => ({ ...x, [id]: v }));

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={item ? String(item.values.title ?? 'Item') : 'New item'}
      description={item ? `Created ${formatRelative(item.createdAt)}${item.createdBy && people[item.createdBy] ? ` by ${people[item.createdBy]!.name}` : ''} · modified ${formatRelative(item.updatedAt)}${item.updatedBy && people[item.updatedBy] ? ` by ${people[item.updatedBy]!.name}` : ''}` : list.name}
      footer={
        canEdit ? (
          <>
            {item && (
              <Button variant="ghost" className="mr-auto text-red-600" icon={<Trash2 className="size-4" />} loading={remove.isPending} onClick={() => window.confirm('Delete this item?') && remove.mutate()}>
                Delete
              </Button>
            )}
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
              Save
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Close</Button>
        )
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (canEdit) save.mutate();
        }}
      >
        <fieldset disabled={!canEdit} className="space-y-3">
          {list.columns.map((c) => {
            const id = `li-${c.id}`;
            const v = values[c.id];
            const label = `${c.name}${c.required ? ' *' : ''}`;
            if (c.type === 'boolean') return <Switch key={c.id} checked={!!v} onChange={(x) => set(c.id, x)} label={c.name} />;
            return (
              <Field key={c.id} label={label} htmlFor={id}>
                {c.type === 'note' ? (
                  <Textarea id={id} rows={4} value={String(v ?? '')} onChange={(e) => set(c.id, e.target.value)} />
                ) : c.type === 'choice' ? (
                  <Select id={id} value={String(v ?? '')} onChange={(e) => set(c.id, e.target.value)}>
                    <option value="">{c.required ? 'Choose…' : '—'}</option>
                    {c.choices?.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </Select>
                ) : c.type === 'person' ? (
                  canEdit ? (
                    <PersonPicker
                      id={id}
                      value={(v as string) || null}
                      people={people}
                      onChange={(pid, p) => {
                        if (pid && p) setPeople((x) => ({ ...x, [pid]: p }));
                        set(c.id, pid ?? '');
                      }}
                    />
                  ) : (
                    <p className="text-sm">{v ? (people[v as string]?.name ?? 'Unknown person') : '—'}</p>
                  )
                ) : (
                  <Input
                    id={id}
                    type={c.type === 'number' ? 'number' : c.type === 'date' ? (c.withTime ? 'datetime-local' : 'date') : c.type === 'link' ? 'url' : 'text'}
                    step={c.type === 'number' ? 'any' : undefined}
                    placeholder={c.type === 'link' ? 'https://' : undefined}
                    value={String(v ?? '')}
                    onChange={(e) => set(c.id, e.target.value)}
                  />
                )}
              </Field>
            );
          })}
        </fieldset>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Columns and list settings
// ---------------------------------------------------------------------------

type DraftColumn = ListColumn & { choicesText?: string; isNew?: boolean };

function ColumnsDialog({ site, list, onClose }: { site: SiteRef; list: ListInfo; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [cols, setCols] = useState<DraftColumn[]>(() => list.columns.map((c) => ({ ...c, choicesText: c.choices?.join('\n') ?? '' })));
  const [error, setError] = useState<string | null>(null);
  const removed = list.columns.filter((c) => !cols.some((d) => d.id === c.id));
  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/sites/${site.id}/lists/${list.id}`, {
        method: 'PATCH',
        body: {
          columns: cols.map((c) => ({
            ...(c.isNew ? {} : { id: c.id }),
            name: c.name,
            type: c.type,
            required: !!c.required,
            ...(c.type === 'choice' ? { choices: (c.choicesText ?? '').split('\n').map((x) => x.trim()).filter(Boolean) } : {}),
            ...(c.type === 'date' ? { withTime: !!c.withTime } : {}),
          })),
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sites'] });
      toast.success('Columns saved');
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const update = (i: number, patch: Partial<DraftColumn>) => setCols((cs) => cs.map((c, n) => (n === i ? { ...c, ...patch } : c)));
  const moveCol = (i: number, by: number) =>
    setCols((cs) => {
      const next = [...cs];
      [next[i], next[i + by]] = [next[i + by]!, next[i]!];
      return next;
    });

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Columns"
      description="The first column is each item’s title."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            onClick={() => (!removed.length || window.confirm(`Remove ${removed.map((c) => `“${c.name}”`).join(', ')} and the values in ${removed.length === 1 ? 'it' : 'them'}?`)) && save.mutate()}
          >
            Save
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <ul className="space-y-3">
        {cols.map((c, i) => (
          <li key={c.id} className="rounded-lg p-3 ring-1 ring-zinc-200 dark:ring-zinc-800">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Name" htmlFor={`col-n-${c.id}`}>
                <Input id={`col-n-${c.id}`} value={c.name} onChange={(e) => update(i, { name: e.target.value })} className="w-48" />
              </Field>
              <Field label="Type" htmlFor={`col-t-${c.id}`}>
                <Select id={`col-t-${c.id}`} value={c.type} disabled={i === 0 || !c.isNew} onChange={(e) => update(i, { type: e.target.value as ListColumn['type'] })} className="w-52">
                  {Object.entries(TYPE_LABELS).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
              {i > 0 && (
                <div className="ml-auto flex gap-1 pb-1">
                  <button type="button" aria-label="Move up" disabled={i === 1} onClick={() => moveCol(i, -1)} className="rounded p-1.5 hover:bg-zinc-100 disabled:opacity-30 dark:hover:bg-zinc-800">
                    <ChevronUp className="size-4" />
                  </button>
                  <button type="button" aria-label="Move down" disabled={i === cols.length - 1} onClick={() => moveCol(i, 1)} className="rounded p-1.5 hover:bg-zinc-100 disabled:opacity-30 dark:hover:bg-zinc-800">
                    <ChevronDown className="size-4" />
                  </button>
                  <button type="button" aria-label={`Remove ${c.name}`} onClick={() => setCols((cs) => cs.filter((_, n) => n !== i))} className="rounded p-1.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-950">
                    <Trash2 className="size-4" />
                  </button>
                </div>
              )}
            </div>
            {i > 0 && (
              <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2 text-sm">
                <label className="inline-flex items-center gap-2">
                  <input type="checkbox" checked={!!c.required} onChange={(e) => update(i, { required: e.target.checked })} /> Required
                </label>
                {c.type === 'date' && (
                  <label className="inline-flex items-center gap-2">
                    <input type="checkbox" checked={!!c.withTime} onChange={(e) => update(i, { withTime: e.target.checked })} /> Include time
                  </label>
                )}
              </div>
            )}
            {c.type === 'choice' && (
              <Field label="Choices (one per line)" htmlFor={`col-c-${c.id}`}>
                <Textarea id={`col-c-${c.id}`} rows={3} value={c.choicesText ?? ''} onChange={(e) => update(i, { choicesText: e.target.value })} />
              </Field>
            )}
          </li>
        ))}
      </ul>
      <Button className="mt-3" icon={<Plus className="size-4" />} onClick={() => setCols((cs) => [...cs, { id: `new${Date.now().toString(36)}`, name: '', type: 'text', isNew: true, choicesText: '' }])}>
        Add column
      </Button>
      <p className="mt-2 text-xs text-zinc-500">A column’s type can’t be changed once it has been saved; add a new column instead.</p>
    </Dialog>
  );
}

function ListSettingsDialog({ site, list, onClose, onDeleted }: { site: SiteRef; list: ListInfo; onClose: () => void; onDeleted: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ name: list.name, description: list.description });
  const save = useMutation({
    mutationFn: () => api(`/api/v1/sites/${site.id}/lists/${list.id}`, { method: 'PATCH', body: f }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sites'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="List settings"
      footer={
        <>
          <Button
            variant="danger"
            className="mr-auto"
            onClick={async () => {
              if (!window.confirm(`Delete “${list.name}” and all its items? This cannot be undone.`)) return;
              try {
                await api(`/api/v1/sites/${site.id}/lists/${list.id}`, { method: 'DELETE' });
                onDeleted();
              } catch (e) {
                toast.error(errorMessage(e));
              }
            }}
          >
            Delete list
          </Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!f.name.trim()} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name" htmlFor="ls-name">
          <Input id="ls-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Description" htmlFor="ls-desc">
          <Textarea id="ls-desc" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}

export function CreateListDialog({ site, onClose }: { site: SiteRef; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('blank');
  const [error, setError] = useState<string | null>(null);
  const templates = useQuery({ queryKey: ['sites', 'lists', site.id], queryFn: () => api<{ templates: { key: string; description: string; columns: string[] }[] }>(`/api/v1/sites/${site.id}/lists`) });
  const create = useMutation({
    mutationFn: () => api<{ list: ListInfo }>(`/api/v1/sites/${site.id}/lists`, { body: { name: name.trim(), template } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['sites'] });
      onClose();
      navigate(`/sites/${site.slug}/lists/${r.list.id}`);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Create a list"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate()}>
            Create
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <Field label="Name" htmlFor="nl-name">
        <Input id="nl-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Equipment requests" />
      </Field>
      <p className="mt-4 mb-2 text-sm font-medium">Start from</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {(templates.data?.templates ?? []).map((t) => (
          <button
            key={t.key}
            type="button"
            aria-pressed={template === t.key}
            onClick={() => setTemplate(t.key)}
            className={cn('rounded-lg p-3 text-left ring-1 transition', template === t.key ? 'bg-brand/5 ring-2 ring-brand' : 'ring-zinc-200 hover:ring-zinc-400 dark:ring-zinc-700')}
          >
            <span className="block font-medium">{TEMPLATE_LABELS[t.key] ?? t.key}</span>
            {t.description && <span className="block text-sm text-zinc-500">{t.description}</span>}
            <span className="mt-1 block truncate text-xs text-zinc-500">{t.columns.join(' · ')}</span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Widget for site pages
// ---------------------------------------------------------------------------

export function ListWidget({ site, listId }: { site: SiteRef; listId: string | null }) {
  const q = useQuery({ queryKey: [...listKey(site.id, listId ?? ''), 'widget'], queryFn: () => api<ListData>(`/api/v1/sites/${site.id}/lists/${listId}?limit=10`), enabled: !!listId, retry: false });
  if (!listId) return <p className="text-sm text-zinc-500">Edit the page and choose a list.</p>;
  if (q.error) return <p className="text-sm text-zinc-500">This list no longer exists.</p>;
  if (!q.data) return <PageSpinner />;
  const { list, items, people } = q.data;
  const cols = list.columns.slice(0, 4);
  return (
    <div>
      {!items.length ? (
        <p className="text-sm text-zinc-500">No items yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c.id} className="border-b border-zinc-200 py-1.5 pr-3 font-medium whitespace-nowrap dark:border-zinc-800">
                    {c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/70">
                  {cols.map((c) => (
                    <td key={c.id} className="max-w-56 py-1.5 pr-3 align-top">
                      <Value col={c} value={i.values[c.id]} people={people} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Link to={`/sites/${site.slug}/lists/${list.id}`} className="mt-2 inline-block text-sm text-brand hover:underline">
        {list.itemCount && list.itemCount > items.length ? `All ${list.itemCount} items` : 'Open the list'}
      </Link>
    </div>
  );
}
