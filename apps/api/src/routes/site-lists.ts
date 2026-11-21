import { randomBytes } from 'node:crypto';
import { Type } from 'typebox';
import { orm, siteListItems, siteLists, users, type DriveRole, type Site, type SiteList, type SiteListColumn } from '@forge/db';
import type { AppContext } from '../context';
import { badRequest, notFound } from '../errors';
import type { App } from '../types';

const { and, asc, count, eq, inArray, sql } = orm;

type Req = { principal: { user: { id: string; orgId: string } } | null };
type RequireSite = (req: Req, where: { id?: string; slug?: string }, need: DriveRole) => Promise<{ site: Site; role: DriveRole }>;

/** Like SharePoint's list view threshold: lists stay quick to load and sort in the browser. */
export const MAX_LIST_ITEMS = 5000;
const MAX_COLUMNS = 50;
const COLUMN_TYPES = ['text', 'note', 'number', 'choice', 'date', 'boolean', 'person', 'link'] as const;

const newColumnId = () => `c${randomBytes(4).toString('hex')}`;
const title = (name = 'Title'): SiteListColumn => ({ id: 'title', name, type: 'text', required: true });

/** Ready-made lists, as SharePoint offers. */
export const LIST_TEMPLATES: Record<string, { description: string; columns: () => SiteListColumn[] }> = {
  blank: { description: '', columns: () => [title()] },
  tasks: {
    description: 'Work to do, who is doing it and when it is due.',
    columns: () => [
      title('Task'),
      { id: newColumnId(), name: 'Status', type: 'choice', choices: ['Not started', 'In progress', 'Completed', 'Blocked'] },
      { id: newColumnId(), name: 'Priority', type: 'choice', choices: ['High', 'Normal', 'Low'] },
      { id: newColumnId(), name: 'Assigned to', type: 'person' },
      { id: newColumnId(), name: 'Due date', type: 'date' },
      { id: newColumnId(), name: 'Notes', type: 'note' },
    ],
  },
  issues: {
    description: 'Track issues from report to resolution.',
    columns: () => [
      title('Issue'),
      { id: newColumnId(), name: 'Description', type: 'note' },
      { id: newColumnId(), name: 'Status', type: 'choice', choices: ['New', 'Active', 'Resolved', 'Closed'] },
      { id: newColumnId(), name: 'Priority', type: 'choice', choices: ['Critical', 'High', 'Medium', 'Low'] },
      { id: newColumnId(), name: 'Assigned to', type: 'person' },
      { id: newColumnId(), name: 'Date reported', type: 'date' },
    ],
  },
  contacts: {
    description: 'People outside the organisation the team works with.',
    columns: () => [
      title('Name'),
      { id: newColumnId(), name: 'Company', type: 'text' },
      { id: newColumnId(), name: 'Email', type: 'text' },
      { id: newColumnId(), name: 'Phone', type: 'text' },
      { id: newColumnId(), name: 'Website', type: 'link' },
      { id: newColumnId(), name: 'Notes', type: 'note' },
    ],
  },
  events: {
    description: 'Upcoming dates, with where and when.',
    columns: () => [
      title('Event'),
      { id: newColumnId(), name: 'Start', type: 'date', withTime: true, required: true },
      { id: newColumnId(), name: 'End', type: 'date', withTime: true },
      { id: newColumnId(), name: 'Location', type: 'text' },
      { id: newColumnId(), name: 'Description', type: 'note' },
    ],
  },
};

const ColumnSchema = Type.Object({
  id: Type.Optional(Type.String({ pattern: '^[a-z][a-z0-9]{0,31}$' })),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  type: Type.Union(COLUMN_TYPES.map((t) => Type.Literal(t))),
  required: Type.Optional(Type.Boolean()),
  choices: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 100 })),
  withTime: Type.Optional(Type.Boolean()),
});
type ColumnInput = { id?: string; name: string; type: SiteListColumn['type']; required?: boolean; choices?: string[]; withTime?: boolean };

/** Checked, tidied columns. The Title column always comes first and stays text. */
function cleanColumns(input: ColumnInput[]): SiteListColumn[] {
  if (!input.length || input.length > MAX_COLUMNS) throw badRequest(`A list has between 1 and ${MAX_COLUMNS} columns`);
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const out = input.map((c, i) => {
    const id = i === 0 ? 'title' : c.id && c.id !== 'title' ? c.id : newColumnId();
    if (seenIds.has(id)) throw badRequest('Two columns have the same id');
    seenIds.add(id);
    const name = c.name.trim();
    if (!name) throw badRequest('Every column needs a name');
    if (seenNames.has(name.toLowerCase())) throw badRequest(`There are two columns called “${name}”`);
    seenNames.add(name.toLowerCase());
    if (i === 0) return { id, name, type: 'text' as const, required: true };
    const col: SiteListColumn = { id, name, type: c.type, ...(c.required ? { required: true } : {}) };
    if (c.type === 'choice') {
      const choices = [...new Set((c.choices ?? []).map((x) => x.trim()).filter(Boolean))];
      if (!choices.length) throw badRequest(`Give “${name}” at least one choice`);
      col.choices = choices;
    }
    if (c.type === 'date' && c.withTime) col.withTime = true;
    return col;
  });
  if (input[0] && input[0].id && input[0].id !== 'title') throw badRequest('The Title column must stay first');
  return out;
}

const empty = (v: unknown) => v === undefined || v === null || v === '';
const LINK = /^(https?:\/\/|mailto:)[^\s]+$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Values checked against the list's columns: unknown columns dropped, each
 * value converted to its column's type, required columns enforced. With
 * `merge`, only the given columns change.
 */
async function cleanValues(ctx: AppContext, orgId: string, columns: SiteListColumn[], input: Record<string, unknown>, merge?: Record<string, unknown>) {
  const out: Record<string, unknown> = merge ? { ...merge } : {};
  for (const col of columns) {
    if (!(col.id in input)) continue;
    const v = input[col.id];
    if (empty(v)) {
      delete out[col.id];
      continue;
    }
    const bad = (why: string) => badRequest(`${col.name}: ${why}`);
    switch (col.type) {
      case 'text':
        if (typeof v !== 'string' || v.length > 255) throw bad('enter up to 255 characters');
        out[col.id] = v.trim();
        break;
      case 'note':
        if (typeof v !== 'string' || v.length > 10_000) throw bad('enter up to 10,000 characters');
        out[col.id] = v;
        break;
      case 'number': {
        const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
        if (!Number.isFinite(n)) throw bad('enter a number');
        out[col.id] = n;
        break;
      }
      case 'choice':
        if (typeof v !== 'string' || !col.choices?.includes(v)) throw bad(`choose one of ${col.choices?.join(', ')}`);
        out[col.id] = v;
        break;
      case 'date': {
        const d = typeof v === 'string' ? new Date(v) : null;
        if (!d || Number.isNaN(d.getTime())) throw bad('enter a date');
        out[col.id] = col.withTime ? d.toISOString() : d.toISOString().slice(0, 10);
        break;
      }
      case 'boolean':
        if (typeof v !== 'boolean') throw bad('choose yes or no');
        out[col.id] = v;
        break;
      case 'person': {
        if (typeof v !== 'string' || !UUID.test(v)) throw bad('choose a person');
        const [u] = await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.id, v), eq(users.orgId, orgId))).limit(1);
        if (!u) throw bad('choose someone in the organisation');
        out[col.id] = v;
        break;
      }
      case 'link':
        if (typeof v !== 'string' || v.length > 2000 || !LINK.test(v.trim())) throw bad('enter a web address starting with https://');
        out[col.id] = v.trim();
        break;
    }
  }
  for (const col of columns) if (col.required && empty(out[col.id])) throw badRequest(`${col.name} is required`);
  return out;
}

/** Lists on a site: the list (columns) and its items, both following the site's permissions. */
export function siteListRoutes(app: App, ctx: AppContext, requireSite: RequireSite) {
  const { db } = ctx;
  const me = (req: Req) => req.principal!.user;
  const ListParams = Type.Object({ id: Type.String({ format: 'uuid' }), listId: Type.String({ format: 'uuid' }) });
  const ItemParams = Type.Object({ id: Type.String({ format: 'uuid' }), listId: Type.String({ format: 'uuid' }), itemId: Type.String({ format: 'uuid' }) });
  const Values = Type.Record(Type.String({ maxLength: 32 }), Type.Unknown());

  const requireList = async (req: Req, siteId: string, listId: string, need: DriveRole) => {
    const { site, role } = await requireSite(req, { id: siteId }, need);
    const [list] = await db.select().from(siteLists).where(and(eq(siteLists.id, listId), eq(siteLists.siteId, site.id))).limit(1);
    if (!list) throw notFound('List');
    return { site, role, list };
  };
  const serialiseList = (l: SiteList, itemCount?: number) => ({ id: l.id, name: l.name, description: l.description, columns: l.columns, itemCount, updatedAt: l.updatedAt });

  /** Names for person columns and who created or changed each item. */
  const peopleFor = async (list: SiteList, items: { values: Record<string, unknown>; createdBy: string | null; updatedBy: string | null }[]) => {
    const personCols = list.columns.filter((c) => c.type === 'person').map((c) => c.id);
    const ids = new Set<string>();
    for (const i of items) {
      if (i.createdBy) ids.add(i.createdBy);
      if (i.updatedBy) ids.add(i.updatedBy);
      for (const c of personCols) if (typeof i.values[c] === 'string') ids.add(i.values[c] as string);
    }
    if (!ids.size) return {};
    const rows = await db.select({ id: users.id, name: users.displayName, email: users.email }).from(users).where(inArray(users.id, [...ids]));
    return Object.fromEntries(rows.map((r) => [r.id, { name: r.name, email: r.email }]));
  };

  app.get('/api/v1/sites/:id/lists', { schema: { tags: ['sites'], summary: 'The site’s lists', params: Type.Object({ id: Type.String({ format: 'uuid' }) }) } }, async (req) => {
    const { site } = await requireSite(req, { id: req.params.id }, 'viewer');
    const rows = await db
      .select({ list: siteLists, items: count(siteListItems.id) })
      .from(siteLists)
      .leftJoin(siteListItems, eq(siteListItems.listId, siteLists.id))
      .where(eq(siteLists.siteId, site.id))
      .groupBy(siteLists.id)
      .orderBy(asc(siteLists.name));
    return { items: rows.map((r) => serialiseList(r.list, Number(r.items))), templates: Object.entries(LIST_TEMPLATES).map(([key, t]) => ({ key, description: t.description, columns: t.columns().map((c) => c.name) })) };
  });

  app.post(
    '/api/v1/sites/:id/lists',
    {
      schema: {
        tags: ['sites'],
        summary: 'Create a list, blank or from a template',
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 120 }), description: Type.Optional(Type.String({ maxLength: 500 })), template: Type.Optional(Type.String({ maxLength: 20 })), columns: Type.Optional(Type.Array(ColumnSchema, { maxItems: MAX_COLUMNS })) }),
      },
    },
    async (req, reply) => {
      const { site } = await requireSite(req, { id: req.params.id }, 'editor');
      const template = LIST_TEMPLATES[req.body.template ?? 'blank'];
      if (!template) throw badRequest('Unknown list template');
      const columns = req.body.columns ? cleanColumns(req.body.columns) : template.columns();
      const [list] = await db
        .insert(siteLists)
        .values({ siteId: site.id, name: req.body.name.trim(), description: req.body.description?.trim() ?? template.description, columns, createdBy: me(req).id })
        .returning();
      reply.code(201);
      return { list: serialiseList(list!, 0) };
    },
  );

  app.get('/api/v1/sites/:id/lists/:listId', { schema: { tags: ['sites'], summary: 'A list and its items', params: ListParams, querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIST_ITEMS })) }) } }, async (req) => {
    const { list, role } = await requireList(req, req.params.id, req.params.listId, 'viewer');
    const items = await db
      .select()
      .from(siteListItems)
      .where(eq(siteListItems.listId, list.id))
      .orderBy(asc(siteListItems.createdAt))
      .limit(req.query.limit ?? MAX_LIST_ITEMS);
    const [total] = await db.select({ n: count() }).from(siteListItems).where(eq(siteListItems.listId, list.id));
    return {
      list: serialiseList(list, Number(total?.n ?? 0)),
      canEdit: role !== 'viewer' && role !== 'commenter',
      items: items.map((i) => ({ id: i.id, values: i.values, createdBy: i.createdBy, updatedBy: i.updatedBy, createdAt: i.createdAt, updatedAt: i.updatedAt })),
      people: await peopleFor(list, items),
    };
  });

  app.patch(
    '/api/v1/sites/:id/lists/:listId',
    {
      schema: {
        tags: ['sites'],
        summary: 'Rename a list or change its columns (removing a column removes its values)',
        params: ListParams,
        body: Type.Object({ name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })), description: Type.Optional(Type.String({ maxLength: 500 })), columns: Type.Optional(Type.Array(ColumnSchema, { minItems: 1, maxItems: MAX_COLUMNS })) }),
      },
    },
    async (req) => {
      const { list } = await requireList(req, req.params.id, req.params.listId, 'editor');
      const columns = req.body.columns ? cleanColumns(req.body.columns) : list.columns;
      const [updated] = await db.transaction(async (tx) => {
        const removed = list.columns.map((c) => c.id).filter((id) => !columns.some((c) => c.id === id));
        for (const id of removed) await tx.update(siteListItems).set({ values: sql`${siteListItems.values} - ${id}::text` }).where(eq(siteListItems.listId, list.id));
        return tx
          .update(siteLists)
          .set({ name: req.body.name?.trim() ?? list.name, description: req.body.description?.trim() ?? list.description, columns })
          .where(eq(siteLists.id, list.id))
          .returning();
      });
      return { list: serialiseList(updated!) };
    },
  );

  app.delete('/api/v1/sites/:id/lists/:listId', { schema: { tags: ['sites'], summary: 'Delete a list and its items', params: ListParams } }, async (req) => {
    const { list } = await requireList(req, req.params.id, req.params.listId, 'editor');
    await db.delete(siteLists).where(eq(siteLists.id, list.id));
    return { ok: true };
  });

  app.post('/api/v1/sites/:id/lists/:listId/items', { schema: { tags: ['sites'], summary: 'Add an item', params: ListParams, body: Type.Object({ values: Values }) } }, async (req, reply) => {
    const { list } = await requireList(req, req.params.id, req.params.listId, 'editor');
    const [total] = await db.select({ n: count() }).from(siteListItems).where(eq(siteListItems.listId, list.id));
    if (Number(total?.n ?? 0) >= MAX_LIST_ITEMS) throw badRequest(`A list holds up to ${MAX_LIST_ITEMS.toLocaleString('en')} items`);
    const values = await cleanValues(ctx, me(req).orgId, list.columns, req.body.values);
    const [item] = await db.insert(siteListItems).values({ listId: list.id, values, createdBy: me(req).id, updatedBy: me(req).id }).returning();
    await db.update(siteLists).set({ updatedAt: new Date() }).where(eq(siteLists.id, list.id));
    reply.code(201);
    return { item: { id: item!.id, values: item!.values, createdBy: item!.createdBy, updatedBy: item!.updatedBy, createdAt: item!.createdAt, updatedAt: item!.updatedAt }, people: await peopleFor(list, [item!]) };
  });

  app.patch('/api/v1/sites/:id/lists/:listId/items/:itemId', { schema: { tags: ['sites'], summary: 'Change an item (only the given columns)', params: ItemParams, body: Type.Object({ values: Values }) } }, async (req) => {
    const { list } = await requireList(req, req.params.id, req.params.listId, 'editor');
    const [existing] = await db.select().from(siteListItems).where(and(eq(siteListItems.id, req.params.itemId), eq(siteListItems.listId, list.id))).limit(1);
    if (!existing) throw notFound('Item');
    const values = await cleanValues(ctx, me(req).orgId, list.columns, req.body.values, existing.values);
    const [item] = await db.update(siteListItems).set({ values, updatedBy: me(req).id }).where(eq(siteListItems.id, existing.id)).returning();
    await db.update(siteLists).set({ updatedAt: new Date() }).where(eq(siteLists.id, list.id));
    return { item: { id: item!.id, values: item!.values, createdBy: item!.createdBy, updatedBy: item!.updatedBy, createdAt: item!.createdAt, updatedAt: item!.updatedAt }, people: await peopleFor(list, [item!]) };
  });

  app.delete('/api/v1/sites/:id/lists/:listId/items/:itemId', { schema: { tags: ['sites'], summary: 'Delete an item', params: ItemParams } }, async (req) => {
    const { list } = await requireList(req, req.params.id, req.params.listId, 'editor');
    const gone = await db.delete(siteListItems).where(and(eq(siteListItems.id, req.params.itemId), eq(siteListItems.listId, list.id))).returning({ id: siteListItems.id });
    if (!gone.length) throw notFound('Item');
    return { ok: true };
  });
}
