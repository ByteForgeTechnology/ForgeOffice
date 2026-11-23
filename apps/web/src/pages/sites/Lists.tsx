import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, ChevronUp, Columns3, Download, EyeOff, KanbanSquare, List as ListIcon, Plus, Search, Settings2, SlidersHorizontal, Table2, Trash2, X } from 'lucide-react';
import { Alert, Avatar, Badge, Button, Dialog, EmptyState, Field, Input, PageSpinner, Select, Switch, Textarea, cn, formatRelative, useToast, type Tone } from '@forge/ui';
import { api, errorMessage } from '../../lib/api';
import { useMe } from '../../lib/hooks';
import { StarButton } from '../../components/StarButton';
import { FILTER_OPS, allColumns, applyView, columnById, displayText, groupItems, valueOf, type FilterOp, type ListColumn, type ListItem, type ListView as ViewDef, type People } from './list-views';

export type { ListColumn };
interface ListInfo {
  id: string;
  name: string;
  description: string;
  columns: ListColumn[];
  views: ViewDef[];
  itemCount?: number;
  updatedAt?: string;
}
interface ListData {
  list: ListInfo;
  canEdit: boolean;
  items: ListItem[];
  people: People;
  /** Items you starred. */
  starred: string[];
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
// Values: display and CSV
// ---------------------------------------------------------------------------

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
      return <span className="whitespace-nowrap">{displayText(col, value, people)}</span>;
    default:
      return <span>{String(value)}</span>;
  }
}

function exportCsv(name: string, columns: ListColumn[], items: ListItem[], people: People) {
  const cell = (s: string) => (/[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s);
  const rows = [columns.map((c) => cell(c.name)).join(',')];
  for (const i of items) rows.push(columns.map((c) => cell(displayText(c, valueOf(i, c.id), people))).join(','));
  const blob = new Blob([`﻿${rows.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Columns a view shows, in its order (unknown ids skipped). */
const viewColumns = (list: ListInfo, view: ViewDef) => view.columns.map((id) => columnById(list.columns, id)).filter(Boolean) as ListColumn[];

// ---------------------------------------------------------------------------
// The list page: view tabs, then the view as a table or a board
// ---------------------------------------------------------------------------

export function ListView({ site, listId }: { site: SiteRef; listId: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<{ column: string; desc: boolean } | null>(null);
  const [editing, setEditing] = useState<ListItem | 'new' | null>(null);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [viewEditor, setViewEditor] = useState<{ view: ViewDef; isNew: boolean } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const q = useQuery({ queryKey: listKey(site.id, listId), queryFn: () => api<ListData>(`/api/v1/sites/${site.id}/lists/${listId}`) });
  const views = q.data?.list.views ?? [];
  const view = views.find((v) => v.id === params.get('view')) ?? views[0];
  // Links in emails open an item: …/lists/<id>?item=<item id>
  const linkedItem = params.get('item');
  useEffect(() => {
    const found = linkedItem && q.data?.items.find((i) => i.id === linkedItem);
    if (!found) return;
    setEditing(found);
    setParams((p) => {
      p.delete('item');
      return p;
    }, { replace: true });
  }, [linkedItem, q.data, setParams]);
  useEffect(() => {
    setFilter('');
    setSort(null);
    setCollapsed(new Set());
  }, [listId, view?.id]);

  const rows = useMemo(() => {
    if (!q.data || !view) return [];
    const { list, items, people } = q.data;
    const inView = applyView(view, list.columns, items, people, me.data?.user.id ?? null, sort);
    const needle = filter.trim().toLowerCase();
    if (!needle) return inView;
    const searchable = allColumns(list.columns);
    return inView.filter((i) => searchable.some((c) => displayText(c, valueOf(i, c.id), people).toLowerCase().includes(needle)));
  }, [q.data, view, filter, sort, me.data]);

  const saveViews = useMutation({
    mutationFn: (next: ViewDef[]) => api<{ list: ListInfo }>(`/api/v1/sites/${site.id}/lists/${listId}/views`, { method: 'PUT', body: { views: next } }),
    onSuccess: (r) => qc.setQueryData<ListData>(listKey(site.id, listId), (d) => (d ? { ...d, list: { ...d.list, views: r.list.views } } : d)),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const moveItem = useMutation({
    mutationFn: ({ item, column, value }: { item: ListItem; column: string; value: string | null }) => api(`/api/v1/sites/${site.id}/lists/${listId}/items/${item.id}`, { method: 'PATCH', body: { values: { [column]: value } } }),
    onMutate: ({ item, column, value }) =>
      qc.setQueryData<ListData>(listKey(site.id, listId), (d) => (d ? { ...d, items: d.items.map((i) => (i.id === item.id ? { ...i, values: { ...i.values, [column]: value ?? undefined } } : i)) } : d)),
    onError: (e) => toast.error(errorMessage(e)),
    onSettled: () => void qc.invalidateQueries({ queryKey: listKey(site.id, listId) }),
  });

  if (q.error) return <EmptyState icon={<ListIcon />} title="List not found" description="It may have been deleted." />;
  if (!q.data || !view) return <PageSpinner />;
  const { list, canEdit, people } = q.data;
  const shown = viewColumns(list, view);
  const groupCol = view.layout === 'table' && view.groupBy ? columnById(list.columns, view.groupBy) : undefined;
  const boardCol = view.layout === 'board' ? list.columns.find((c) => c.id === view.boardColumn && c.type === 'choice') : undefined;
  const pickView = (id: string) => setParams(id === views[0]?.id ? {} : { view: id }, { replace: true });
  const blankView = (): ViewDef => ({ id: '', name: '', layout: 'table', columns: list.columns.slice(0, 6).map((c) => c.id), sort: [], filters: [], groupBy: null, boardColumn: null });

  const header = (c: ListColumn) => {
    const active = sort ? sort.column === c.id : !view.sort.length ? false : view.sort[0]!.column === c.id;
    const desc = sort ? sort.desc : view.sort[0]?.desc;
    return (
      <th key={c.id} className="border-b border-zinc-200 px-3 py-2 font-medium whitespace-nowrap dark:border-zinc-800" aria-sort={active ? (desc ? 'descending' : 'ascending') : 'none'}>
        <button type="button" className="inline-flex items-center gap-1 hover:text-brand" onClick={() => setSort(sort?.column === c.id ? (sort.desc ? null : { column: c.id, desc: true }) : { column: c.id, desc: false })}>
          {c.name}
          {active && (desc ? <ArrowDown className="size-3.5" /> : <ArrowUp className="size-3.5" />)}
        </button>
      </th>
    );
  };
  const isStarred = (i: ListItem) => q.data!.starred.includes(i.id);
  const row = (i: ListItem) => (
    <tr key={i.id} className="group cursor-pointer border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800/70 dark:hover:bg-zinc-800/50" onClick={() => setEditing(i)}>
      {shown.map((c, n) => (
        <td key={c.id} className={cn('max-w-72 px-3 py-2 align-top', n === 0 && 'font-medium')}>
          <Value col={c} value={valueOf(i, c.id)} people={people} />
        </td>
      ))}
      <td className="w-8 py-1 pr-2 text-right align-top">
        <StarButton kind="list_item" id={i.id} starred={isStarred(i)} name={String(i.values.title ?? 'this item')} className={cn(!isStarred(i) && 'opacity-0 group-hover:opacity-100 focus:opacity-100')} />
      </td>
    </tr>
  );

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

      <div role="tablist" aria-label="Views" className="flex flex-wrap items-center gap-1 border-b border-zinc-200 dark:border-zinc-800">
        {views.map((v, n) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={v.id === view.id}
            onClick={() => pickView(v.id)}
            className={cn('-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm', v.id === view.id ? 'border-brand font-medium text-brand' : 'border-transparent text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100')}
          >
            {v.layout === 'board' ? <KanbanSquare className="size-4" /> : <Table2 className="size-4" />}
            {v.name}
            {n === 0 && views.length > 1 && <span className="sr-only">(default)</span>}
          </button>
        ))}
        {canEdit && (
          <button type="button" onClick={() => setViewEditor({ view: blankView(), isNew: true })} className="inline-flex items-center gap-1 px-3 py-2 text-sm text-zinc-500 hover:text-brand">
            <Plus className="size-4" /> Add view
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-zinc-400" />
          <Input aria-label="Filter items" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter items" className="pl-9" />
        </div>
        <span className="text-sm text-zinc-500">
          {rows.length === q.data.items.length ? `${rows.length} items` : `${rows.length} of ${q.data.items.length} items`}
          {view.filters.length > 0 && ` · filtered by ${view.filters.length === 1 ? 'this view' : `${view.filters.length} conditions`}`}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          {canEdit && (
            <Button size="sm" variant="ghost" icon={<SlidersHorizontal className="size-4" />} onClick={() => setViewEditor({ view, isNew: false })}>
              Edit view
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<Download className="size-4" />} onClick={() => exportCsv(`${list.name} - ${view.name}`, view.layout === 'board' ? allColumns(list.columns) : shown, rows, people)}>
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
      ) : boardCol ? (
        <Board
          column={boardCol}
          fields={shown.filter((c) => c.id !== 'title' && c.id !== boardCol.id)}
          items={rows}
          people={people}
          canEdit={canEdit}
          onOpen={setEditing}
          onMove={(item, value) => moveItem.mutate({ item, column: boardCol.id, value })}
        />
      ) : !rows.length ? (
        <EmptyState icon={<ListIcon />} title="Nothing in this view" description="No items match its filters." />
      ) : (
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {shown.map(header)}
                <th className="w-8 border-b border-zinc-200 dark:border-zinc-800">
                  <span className="sr-only">Starred</span>
                </th>
              </tr>
            </thead>
            {groupCol ? (
              groupItems(groupCol, rows, people).map((g) => {
                const closed = collapsed.has(g.key);
                return (
                  <tbody key={g.key}>
                    <tr className="bg-zinc-50 dark:bg-zinc-800/40">
                      <td colSpan={shown.length + 1} className="px-3 py-1.5">
                        <button
                          type="button"
                          aria-expanded={!closed}
                          className="inline-flex items-center gap-1.5 text-sm font-medium"
                          onClick={() => setCollapsed((s) => (s.has(g.key) ? new Set([...s].filter((k) => k !== g.key)) : new Set([...s, g.key])))}
                        >
                          {closed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
                          {groupCol.name}: {g.label} <span className="font-normal text-zinc-500">({g.items.length})</span>
                        </button>
                      </td>
                    </tr>
                    {!closed && g.items.map(row)}
                  </tbody>
                );
              })
            ) : (
              <tbody>{rows.map(row)}</tbody>
            )}
          </table>
        </div>
      )}
      {view.layout === 'board' && !boardCol && <Alert tone="warning">This board’s column no longer exists. Edit the view to choose another.</Alert>}

      {editing && <ItemDialog site={site} data={q.data} item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {columnsOpen && <ColumnsDialog site={site} list={list} onClose={() => setColumnsOpen(false)} />}
      {viewEditor && (
        <ViewEditorDialog
          list={list}
          view={viewEditor.view}
          isNew={viewEditor.isNew}
          isDefault={!viewEditor.isNew && views[0]?.id === viewEditor.view.id}
          saving={saveViews.isPending}
          onClose={() => setViewEditor(null)}
          onSave={(v, makeDefault) => {
            // A new view has no id yet; the server assigns one.
            const { id: _unsaved, ...fresh } = v;
            let next: ViewDef[] = viewEditor.isNew ? [...views, fresh as ViewDef] : views.map((x) => (x.id === viewEditor.view.id ? v : x));
            const target = viewEditor.isNew ? next[next.length - 1]! : next.find((x) => x.id === viewEditor.view.id)!;
            if (makeDefault) next = [target, ...next.filter((x) => x !== target)];
            saveViews.mutate(next, {
              onSuccess: (r) => {
                setViewEditor(null);
                const saved = viewEditor.isNew ? r.list.views[makeDefault ? 0 : r.list.views.length - 1] : r.list.views.find((x) => x.id === viewEditor.view.id);
                if (saved) pickView(makeDefault ? r.list.views[0]!.id : saved.id);
              },
            });
          }}
          onDelete={
            views.length > 1 && !viewEditor.isNew
              ? () =>
                  saveViews.mutate(
                    views.filter((x) => x.id !== viewEditor.view.id),
                    { onSuccess: () => (setViewEditor(null), setParams({}, { replace: true })) },
                  )
              : undefined
          }
        />
      )}
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

/** Board layout: one column per choice; dragging a card changes the item's choice. */
function Board({ column, fields, items, people, canEdit, onOpen, onMove }: { column: ListColumn; fields: ListColumn[]; items: ListItem[]; people: People; canEdit: boolean; onOpen: (i: ListItem) => void; onMove: (i: ListItem, value: string | null) => void }) {
  const [over, setOver] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const lanes = [...(column.choices ?? []).map((c) => ({ key: c, label: c, value: c as string | null })), { key: '', label: `No ${column.name.toLowerCase()}`, value: null }];
  const byLane = (v: string | null) => items.filter((i) => ((i.values[column.id] as string | undefined) ?? null) === v || (v === null && !column.choices?.includes(i.values[column.id] as string)));
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {lanes.map((lane, n) => {
        const cards = byLane(lane.value);
        if (lane.value === null && !cards.length) return null;
        return (
          <section
            key={lane.key}
            aria-label={lane.label}
            className={cn('flex w-72 shrink-0 flex-col rounded-xl bg-zinc-100 p-2 dark:bg-zinc-900', over === lane.key && 'ring-2 ring-brand')}
            onDragOver={(e) => {
              if (!canEdit || !dragging) return;
              e.preventDefault();
              setOver(lane.key);
            }}
            onDragLeave={() => setOver((o) => (o === lane.key ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const item = items.find((i) => i.id === dragging);
              if (item && ((item.values[column.id] as string | undefined) ?? null) !== lane.value) onMove(item, lane.value);
              setDragging(null);
            }}
          >
            <h3 className="mb-2 flex items-center gap-2 px-1 text-sm font-medium">
              {lane.value !== null ? <Badge tone={CHOICE_TONES[n % CHOICE_TONES.length]}>{lane.label}</Badge> : <span className="text-zinc-500">{lane.label}</span>}
              <span className="text-zinc-500">{cards.length}</span>
            </h3>
            <ul className="min-h-12 space-y-2">
              {cards.map((i) => (
                <li key={i.id}>
                  <button
                    type="button"
                    draggable={canEdit}
                    onDragStart={(e) => {
                      setDragging(i.id);
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', i.id);
                    }}
                    onDragEnd={() => setDragging(null)}
                    onClick={() => onOpen(i)}
                    className={cn('block w-full rounded-lg bg-white p-3 text-left text-sm shadow-sm ring-1 ring-zinc-200 hover:ring-brand dark:bg-zinc-800 dark:ring-zinc-700', canEdit && 'cursor-grab active:cursor-grabbing', dragging === i.id && 'opacity-50')}
                  >
                    <span className="block font-medium">{String(i.values.title ?? '')}</span>
                    {fields.slice(0, 4).map((f) => {
                      const v = valueOf(i, f.id);
                      return v === undefined || v === null || v === '' ? null : (
                        <span key={f.id} className="mt-1.5 flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                          <span className="text-zinc-400">{f.name}:</span> <Value col={f} value={v} people={people} />
                        </span>
                      );
                    })}
                  </button>
                </li>
              ))}
            </ul>
            {canEdit && cards.length === 0 && <p className="px-1 py-3 text-center text-xs text-zinc-400">Drop items here</p>}
          </section>
        );
      })}
    </div>
  );
}

/** Create or change a view: layout, columns, sorting, filters, grouping. */
function ViewEditorDialog({
  list,
  view,
  isNew,
  isDefault,
  saving,
  onClose,
  onSave,
  onDelete,
}: {
  list: ListInfo;
  view: ViewDef;
  isNew: boolean;
  isDefault: boolean;
  saving: boolean;
  onClose: () => void;
  onSave: (v: ViewDef, makeDefault: boolean) => void;
  onDelete?: () => void;
}) {
  const [v, setV] = useState<ViewDef>(() => structuredClone(view));
  const [makeDefault, setMakeDefault] = useState(isDefault);
  const cols = allColumns(list.columns);
  const choiceCols = list.columns.filter((c) => c.type === 'choice');
  const hidden = cols.filter((c) => !v.columns.includes(c.id));
  const set = (patch: Partial<ViewDef>) => setV((x) => ({ ...x, ...patch }));
  const moveCol = (i: number, by: number) => {
    const next = [...v.columns];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    set({ columns: next });
  };
  const opsFor = (c?: ListColumn) => FILTER_OPS.filter((o) => o.types === 'all' || (c && o.types.includes(c.type)));
  const valueInput = (f: ViewDef['filters'][number], i: number) => {
    const c = columnById(list.columns, f.column);
    if (!c || f.op === 'empty' || f.op === 'notEmpty') return null;
    const change = (value: string | number | boolean) => set({ filters: v.filters.map((x, n) => (n === i ? { ...x, value } : x)) });
    if (c.type === 'choice')
      return (
        <Select aria-label="Value" value={String(f.value ?? '')} onChange={(e) => change(e.target.value)} className="w-44">
          <option value="">Choose…</option>
          {c.choices?.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </Select>
      );
    if (c.type === 'boolean')
      return (
        <Select aria-label="Value" value={String(f.value ?? 'true')} onChange={(e) => change(e.target.value === 'true')} className="w-28">
          <option value="true">Yes</option>
          <option value="false">No</option>
        </Select>
      );
    if (c.type === 'person' && f.op !== 'contains')
      return (
        <Select aria-label="Value" value={String(f.value ?? '')} onChange={(e) => change(e.target.value)} className="w-44">
          <option value="">Choose…</option>
          <option value="[Me]">[Me] (whoever is looking)</option>
        </Select>
      );
    if (c.type === 'date')
      return (
        <span className="inline-flex items-center gap-1">
          <Input aria-label="Value" value={String(f.value ?? '')} onChange={(e) => change(e.target.value)} placeholder="[Today] or 2026-12-31" className="w-44" list="list-date-values" />
        </span>
      );
    return <Input aria-label="Value" type={c.type === 'number' ? 'number' : 'text'} value={String(f.value ?? '')} onChange={(e) => change(c.type === 'number' ? Number(e.target.value) : e.target.value)} className="w-44" />;
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={isNew ? 'Add a view' : `Edit “${view.name}”`}
      footer={
        <>
          {onDelete && (
            <Button variant="ghost" className="mr-auto text-red-600" icon={<Trash2 className="size-4" />} onClick={() => window.confirm(`Delete the “${view.name}” view? The items stay in the list.`) && onDelete()}>
              Delete view
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} disabled={!v.name.trim() || (v.layout === 'board' && !v.boardColumn)} onClick={() => onSave({ ...v, name: v.name.trim() }, makeDefault)}>
            {isNew ? 'Add view' : 'Save view'}
          </Button>
        </>
      }
    >
      <datalist id="list-date-values">
        <option value="[Today]" />
        <option value="[Today]+7" />
        <option value="[Today]-7" />
        <option value="[Today]+30" />
        <option value="[Today]-30" />
      </datalist>
      <div className="space-y-5">
        <div className="flex flex-wrap gap-3">
          <Field label="Name" htmlFor="ve-name">
            <Input id="ve-name" value={v.name} onChange={(e) => set({ name: e.target.value })} placeholder="My open items" className="w-56" />
          </Field>
          <Field label="Show as" htmlFor="ve-layout">
            <Select id="ve-layout" value={v.layout} onChange={(e) => set({ layout: e.target.value as ViewDef['layout'], boardColumn: v.boardColumn ?? choiceCols[0]?.id ?? null })} className="w-40">
              <option value="table">Table</option>
              <option value="board" disabled={!choiceCols.length}>
                Board{!choiceCols.length ? ' (needs a Choice column)' : ''}
              </option>
            </Select>
          </Field>
          {v.layout === 'board' ? (
            <Field label="Board columns from" htmlFor="ve-board">
              <Select id="ve-board" value={v.boardColumn ?? ''} onChange={(e) => set({ boardColumn: e.target.value })} className="w-44">
                {choiceCols.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label="Group by" htmlFor="ve-group">
              <Select id="ve-group" value={v.groupBy ?? ''} onChange={(e) => set({ groupBy: e.target.value || null })} className="w-44">
                <option value="">None</option>
                {cols
                  .filter((c) => c.type !== 'note')
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </Select>
            </Field>
          )}
        </div>

        <section>
          <h3 className="mb-2 text-sm font-medium">{v.layout === 'board' ? 'Fields on cards' : 'Columns'}</h3>
          <ul className="divide-y divide-zinc-100 rounded-lg ring-1 ring-zinc-200 dark:divide-zinc-800 dark:ring-zinc-800">
            {v.columns.map((id, i) => {
              const c = columnById(list.columns, id);
              if (!c) return null;
              return (
                <li key={id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                  <span className="flex-1">{c.name}</span>
                  <button type="button" aria-label={`Move ${c.name} up`} disabled={i === 0} onClick={() => moveCol(i, -1)} className="rounded p-1 hover:bg-zinc-100 disabled:opacity-30 dark:hover:bg-zinc-800">
                    <ChevronUp className="size-4" />
                  </button>
                  <button type="button" aria-label={`Move ${c.name} down`} disabled={i === v.columns.length - 1} onClick={() => moveCol(i, 1)} className="rounded p-1 hover:bg-zinc-100 disabled:opacity-30 dark:hover:bg-zinc-800">
                    <ChevronDown className="size-4" />
                  </button>
                  <button type="button" aria-label={`Hide ${c.name}`} disabled={v.columns.length === 1} onClick={() => set({ columns: v.columns.filter((x) => x !== id) })} className="rounded p-1 hover:bg-zinc-100 disabled:opacity-30 dark:hover:bg-zinc-800">
                    <EyeOff className="size-4" />
                  </button>
                </li>
              );
            })}
          </ul>
          {hidden.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-sm">
              <span className="text-zinc-500">Show:</span>
              {hidden.map((c) => (
                <button key={c.id} type="button" onClick={() => set({ columns: [...v.columns, c.id] })} className="rounded-full px-2.5 py-0.5 ring-1 ring-zinc-300 hover:ring-brand dark:ring-zinc-700">
                  + {c.name}
                </button>
              ))}
            </div>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-sm font-medium">Sort</h3>
          <div className="space-y-2">
            {[0, 1].map((n) => {
              const s = v.sort[n];
              if (n === 1 && !v.sort[0]) return null;
              return (
                <div key={n} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="w-16 text-zinc-500">{n === 0 ? 'Sort by' : 'then by'}</span>
                  <Select
                    aria-label={n === 0 ? 'Sort by' : 'Then by'}
                    value={s?.column ?? ''}
                    onChange={(e) => {
                      const next = [...v.sort];
                      if (e.target.value) next[n] = { column: e.target.value, desc: s?.desc ?? false };
                      else next.splice(n);
                      set({ sort: next });
                    }}
                    className="w-48"
                  >
                    <option value="">{n === 0 ? 'The order items were added' : 'Nothing else'}</option>
                    {cols
                      .filter((c) => c.type !== 'note')
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </Select>
                  {s && (
                    <Select aria-label="Direction" value={s.desc ? 'desc' : 'asc'} onChange={(e) => set({ sort: v.sort.map((x, i) => (i === n ? { ...x, desc: e.target.value === 'desc' } : x)) })} className="w-40">
                      <option value="asc">Ascending (A–Z, 1–9, oldest)</option>
                      <option value="desc">Descending (Z–A, 9–1, newest)</option>
                    </Select>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section>
          <h3 className="mb-1 text-sm font-medium">Filter</h3>
          <p className="mb-2 text-xs text-zinc-500">Show only items where all of these are true. Use [Me] for the person looking, and [Today], [Today]+7 or [Today]-30 for dates.</p>
          <div className="space-y-2">
            {v.filters.map((f, i) => {
              const c = columnById(list.columns, f.column);
              return (
                <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="w-10 text-zinc-500">{i === 0 ? 'Where' : 'and'}</span>
                  <Select
                    aria-label="Column"
                    value={f.column}
                    onChange={(e) => {
                      const nc = columnById(list.columns, e.target.value);
                      set({ filters: v.filters.map((x, n) => (n === i ? { column: e.target.value, op: opsFor(nc).some((o) => o.op === x.op) ? x.op : 'eq', value: nc?.type === 'person' ? '[Me]' : nc?.type === 'boolean' ? true : '' } : x)) });
                    }}
                    className="w-40"
                  >
                    {cols.map((col) => (
                      <option key={col.id} value={col.id}>
                        {col.name}
                      </option>
                    ))}
                  </Select>
                  <Select aria-label="Condition" value={f.op} onChange={(e) => set({ filters: v.filters.map((x, n) => (n === i ? { ...x, op: e.target.value as FilterOp } : x)) })} className="w-48">
                    {opsFor(c).map((o) => (
                      <option key={o.op} value={o.op}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                  {valueInput(f, i)}
                  <button type="button" aria-label="Remove condition" onClick={() => set({ filters: v.filters.filter((_, n) => n !== i) })} className="rounded p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                    <X className="size-4" />
                  </button>
                </div>
              );
            })}
            {v.filters.length < 10 && (
              <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => set({ filters: [...v.filters, { column: 'title', op: 'contains', value: '' }] })}>
                Add condition
              </Button>
            )}
          </div>
        </section>

        {!isDefault && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} /> Make this the default view (shown first, and on pages)
          </label>
        )}
      </div>
    </Dialog>
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
      title={
        item ? (
          <span className="flex items-center gap-2">
            <span className="min-w-0 truncate">{String(item.values.title ?? 'Item')}</span>
            <StarButton kind="list_item" id={item.id} starred={data.starred.includes(item.id)} name={String(item.values.title ?? 'this item')} />
          </span>
        ) : (
          'New item'
        )
      }
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

export function ListWidget({ site, listId, viewId }: { site: SiteRef; listId: string | null; viewId?: string | null }) {
  const me = useMe();
  const q = useQuery({ queryKey: listKey(site.id, listId ?? ''), queryFn: () => api<ListData>(`/api/v1/sites/${site.id}/lists/${listId}`), enabled: !!listId, retry: false });
  if (!listId) return <p className="text-sm text-zinc-500">Edit the page and choose a list.</p>;
  if (q.error) return <p className="text-sm text-zinc-500">This list no longer exists.</p>;
  if (!q.data) return <PageSpinner />;
  const { list, people } = q.data;
  const view = list.views.find((v) => v.id === viewId) ?? list.views[0]!;
  const all = applyView(view, list.columns, q.data.items, people, me.data?.user.id ?? null);
  const items = all.slice(0, 10);
  const cols = (view.layout === 'board' && view.boardColumn ? [columnById(list.columns, 'title'), columnById(list.columns, view.boardColumn), ...viewColumns(list, view).filter((c) => c.id !== 'title')] : viewColumns(list, view)).filter(Boolean).slice(0, 4) as ListColumn[];
  const href = `/sites/${site.slug}/lists/${list.id}${view.id !== list.views[0]?.id ? `?view=${view.id}` : ''}`;
  return (
    <div>
      {!items.length ? (
        <p className="text-sm text-zinc-500">Nothing to show.</p>
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
                      <Value col={c} value={valueOf(i, c.id)} people={people} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Link to={href} className="mt-2 inline-block text-sm text-brand hover:underline">
        {all.length > items.length ? `All ${all.length} items` : 'Open the list'}
      </Link>
    </div>
  );
}
