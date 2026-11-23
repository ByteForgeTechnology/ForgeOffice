import { describe, expect, it } from 'vitest';
import { applyView, groupItems, resolveDate, type ListColumn, type ListItem, type ListView } from './list-views';

const columns: ListColumn[] = [
  { id: 'title', name: 'Task', type: 'text' },
  { id: 'status', name: 'Status', type: 'choice', choices: ['Not started', 'In progress', 'Completed'] },
  { id: 'who', name: 'Assigned to', type: 'person' },
  { id: 'due', name: 'Due', type: 'date' },
  { id: 'cost', name: 'Cost', type: 'number' },
  { id: 'ok', name: 'Approved', type: 'boolean' },
];
const people = { me: { name: 'Alice', email: null }, bob: { name: 'Bob', email: null } };
const today = resolveDate('[Today]');
const plus = (n: number) => resolveDate(`[Today]${n >= 0 ? '+' : ''}${n}`);
let n = 0;
const item = (values: Record<string, unknown>, by = 'me'): ListItem => ({ id: String(++n), values, createdBy: by, updatedBy: by, createdAt: `2026-01-0${n}T10:00:00Z`, updatedAt: `2026-02-0${n}T10:00:00Z` });
const items = [
  item({ title: 'Paint', status: 'In progress', who: 'me', due: plus(-2), cost: 50, ok: true }),
  item({ title: 'Wire', status: 'Not started', who: 'bob', due: today, cost: 500 }),
  item({ title: 'Clean', status: 'Completed', who: 'me', due: plus(10) }, 'bob'),
  item({ title: 'Plan' }),
];
const view = (v: Partial<ListView>): ListView => ({ id: 'v', name: 'v', layout: 'table', columns: ['title'], sort: [], filters: [], ...v });
const titles = (v: Partial<ListView>) => applyView(view(v), columns, items, people, 'me').map((i) => i.values.title);

describe('list views', () => {
  it('filters with [Me], [Today] and empty values', () => {
    expect(titles({ filters: [{ column: 'who', op: 'eq', value: '[Me]' }] })).toEqual(['Paint', 'Clean']);
    expect(titles({ filters: [{ column: 'due', op: 'lt', value: '[Today]' }] })).toEqual(['Paint']);
    expect(titles({ filters: [{ column: 'due', op: 'ge', value: '[Today]' }, { column: 'due', op: 'le', value: '[Today]+7' }] })).toEqual(['Wire']);
    // "is not" includes items with no value, as in SharePoint.
    expect(titles({ filters: [{ column: 'status', op: 'ne', value: 'Completed' }] })).toEqual(['Paint', 'Wire', 'Plan']);
    expect(titles({ filters: [{ column: 'status', op: 'empty' }] })).toEqual(['Plan']);
    expect(titles({ filters: [{ column: 'cost', op: 'gt', value: 100 }] })).toEqual(['Wire']);
    expect(titles({ filters: [{ column: 'ok', op: 'eq', value: true }] })).toEqual(['Paint']);
    expect(titles({ filters: [{ column: 'who', op: 'contains', value: 'bo' }] })).toEqual(['Wire']);
    expect(titles({ filters: [{ column: '_createdBy', op: 'eq', value: '[Me]' }, { column: 'title', op: 'contains', value: 'a' }] })).toEqual(['Paint', 'Plan']);
  });

  it('sorts by up to two columns, empty values last; choices in their own order', () => {
    expect(titles({ sort: [{ column: 'status', desc: false }] })).toEqual(['Wire', 'Paint', 'Clean', 'Plan']);
    expect(titles({ sort: [{ column: 'cost', desc: true }] })).toEqual(['Wire', 'Paint', 'Clean', 'Plan']);
    expect(titles({ sort: [{ column: 'who', desc: false }, { column: 'title', desc: true }] })).toEqual(['Paint', 'Clean', 'Wire', 'Plan']);
    expect(titles({ sort: [{ column: '_modified', desc: true }] })).toEqual(['Plan', 'Clean', 'Wire', 'Paint']);
  });

  it('groups by a column', () => {
    const groups = groupItems(columns[1]!, items, people);
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([
      ['Not started', 1],
      ['In progress', 1],
      ['Completed', 1],
      ['(No status)', 1],
    ]);
  });
});
