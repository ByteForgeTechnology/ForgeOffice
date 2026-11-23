/**
 * List views, evaluated in the browser (a list holds at most 5,000 items):
 * the built-in Created/Modified columns, filters with [Me] and [Today],
 * sorting and grouping.
 */

export interface ListColumn {
  id: string;
  name: string;
  type: 'text' | 'note' | 'number' | 'choice' | 'date' | 'boolean' | 'person' | 'link';
  required?: boolean;
  choices?: string[];
  withTime?: boolean;
}

export type FilterOp = 'eq' | 'ne' | 'contains' | 'gt' | 'ge' | 'lt' | 'le' | 'empty' | 'notEmpty';

export interface ListView {
  id: string;
  name: string;
  layout: 'table' | 'board';
  columns: string[];
  sort: { column: string; desc: boolean }[];
  filters: { column: string; op: FilterOp; value?: string | number | boolean | null }[];
  groupBy?: string | null;
  boardColumn?: string | null;
}

export interface ListItem {
  id: string;
  values: Record<string, unknown>;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export type People = Record<string, { name: string; email: string | null }>;

export const SYSTEM_COLUMNS: ListColumn[] = [
  { id: '_created', name: 'Created', type: 'date', withTime: true },
  { id: '_modified', name: 'Modified', type: 'date', withTime: true },
  { id: '_createdBy', name: 'Created by', type: 'person' },
  { id: '_modifiedBy', name: 'Modified by', type: 'person' },
];

export const FILTER_OPS: { op: FilterOp; label: string; types: ListColumn['type'][] | 'all' }[] = [
  { op: 'eq', label: 'is', types: 'all' },
  { op: 'ne', label: 'is not', types: 'all' },
  { op: 'contains', label: 'contains', types: ['text', 'note', 'link', 'person'] },
  { op: 'gt', label: 'is after / greater than', types: ['number', 'date'] },
  { op: 'ge', label: 'is on or after / at least', types: ['number', 'date'] },
  { op: 'lt', label: 'is before / less than', types: ['number', 'date'] },
  { op: 'le', label: 'is on or before / at most', types: ['number', 'date'] },
  { op: 'empty', label: 'is empty', types: 'all' },
  { op: 'notEmpty', label: 'is not empty', types: 'all' },
];

/** The list's own columns followed by the built-in ones. */
export const allColumns = (columns: ListColumn[]) => [...columns, ...SYSTEM_COLUMNS];

export const columnById = (columns: ListColumn[], id: string) => allColumns(columns).find((c) => c.id === id);

export function valueOf(item: ListItem, column: string): unknown {
  switch (column) {
    case '_created':
      return item.createdAt;
    case '_modified':
      return item.updatedAt;
    case '_createdBy':
      return item.createdBy;
    case '_modifiedBy':
      return item.updatedBy;
    default:
      return item.values[column];
  }
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === '';

/** A date as a local calendar day, YYYY-MM-DD. */
function day(v: string, withTime?: boolean) {
  if (!withTime && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(v);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "[Today]", "[Today]+7", "[Today]-30" → a day; anything else as given. */
export function resolveDate(v: string) {
  const m = /^\[Today\]([+-]\d+)?$/.exec(v);
  if (!m) return day(v);
  const d = new Date();
  d.setDate(d.getDate() + Number(m[1] ?? 0));
  return day(d.toISOString(), true);
}

const truthy = (v: unknown) => v === true || v === 'true' || v === 'Yes' || v === 'yes';

export function displayText(col: ListColumn, v: unknown, people: People): string {
  if (isEmpty(v)) return '';
  if (col.type === 'boolean') return v ? 'Yes' : 'No';
  if (col.type === 'person') return people[v as string]?.name ?? 'Unknown person';
  if (col.type === 'date') {
    const s = v as string;
    const d = new Date(col.withTime ? s : `${s}T00:00:00`);
    return col.withTime ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
  }
  return String(v);
}

function matches(col: ListColumn, f: ListView['filters'][number], v: unknown, people: People, meId: string | null): boolean {
  if (f.op === 'empty') return isEmpty(v);
  if (f.op === 'notEmpty') return !isEmpty(v);
  let want = f.value;
  if (col.type === 'person' && want === '[Me]') want = meId;
  if (f.op === 'contains') return !isEmpty(v) && displayText(col, v, people).toLowerCase().includes(String(want ?? '').toLowerCase());

  let cmp: number | null = null; // item compared with the filter value
  let equal: boolean;
  if (isEmpty(v)) {
    equal = false;
  } else if (col.type === 'number') {
    cmp = (v as number) - Number(want);
    equal = cmp === 0;
  } else if (col.type === 'date') {
    const a = day(v as string, col.withTime);
    const b = resolveDate(String(want));
    cmp = a < b ? -1 : a > b ? 1 : 0;
    equal = cmp === 0;
  } else if (col.type === 'boolean') {
    equal = !!v === truthy(want);
  } else if (col.type === 'person') {
    equal = v === want;
  } else {
    equal = String(v).toLowerCase() === String(want ?? '').toLowerCase();
  }
  switch (f.op) {
    case 'eq':
      return equal;
    case 'ne':
      return !equal; // empty values are "not" anything, as in SharePoint
    case 'gt':
      return cmp !== null && cmp > 0;
    case 'ge':
      return cmp !== null && cmp >= 0;
    case 'lt':
      return cmp !== null && cmp < 0;
    case 'le':
      return cmp !== null && cmp <= 0;
  }
  return true;
}

function sortKey(col: ListColumn, v: unknown, people: People): string | number {
  if (isEmpty(v)) return '';
  if (col.type === 'number') return v as number;
  if (col.type === 'choice') return col.choices?.indexOf(v as string) ?? 0;
  if (col.type === 'boolean') return v ? 1 : 0;
  if (col.type === 'date') return String(v);
  return displayText(col, v, people).toLowerCase();
}

export function compareBy(col: ListColumn, desc: boolean, people: People) {
  return (a: ListItem, b: ListItem) => {
    const x = sortKey(col, valueOf(a, col.id), people);
    const y = sortKey(col, valueOf(b, col.id), people);
    // Empty values last, whichever way round.
    if (x === '' || y === '') return x === y ? 0 : x === '' ? 1 : -1;
    const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
    return desc ? -r : r;
  };
}

/** Items in a view: its filters (all must match), then its sorting. */
export function applyView(view: ListView, columns: ListColumn[], items: ListItem[], people: People, meId: string | null, sortOverride?: { column: string; desc: boolean } | null) {
  let out = items.filter((i) =>
    view.filters.every((f) => {
      const col = columnById(columns, f.column);
      return !col || matches(col, f, valueOf(i, f.column), people, meId);
    }),
  );
  const sorts = sortOverride ? [sortOverride] : view.sort;
  const comparers = sorts.map((s) => columnById(columns, s.column) && compareBy(columnById(columns, s.column)!, s.desc, people)).filter(Boolean) as ((a: ListItem, b: ListItem) => number)[];
  if (comparers.length) out = [...out].sort((a, b) => comparers.reduce((r, c) => r || c(a, b), 0));
  return out;
}

/** Items grouped by a column's value, groups in the column's natural order. */
export function groupItems(col: ListColumn, items: ListItem[], people: People) {
  const groups = new Map<string, { key: string; label: string; value: unknown; items: ListItem[] }>();
  for (const i of items) {
    const v = valueOf(i, col.id);
    const key = isEmpty(v) ? '' : col.type === 'date' ? day(v as string, col.withTime) : String(v);
    const label = isEmpty(v) ? `(No ${col.name.toLowerCase()})` : col.type === 'date' ? displayText({ ...col, withTime: false }, key, people) : displayText(col, v, people);
    if (!groups.has(key)) groups.set(key, { key, label, value: v, items: [] });
    groups.get(key)!.items.push(i);
  }
  const cmp = compareBy(col, false, people);
  return [...groups.values()].sort((a, b) => cmp(a.items[0]!, b.items[0]!));
}
