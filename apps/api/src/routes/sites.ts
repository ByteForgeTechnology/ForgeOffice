import { Type } from 'typebox';
import { atLeast, effectiveRole, principalFor, purge, type Principal } from '@forge/drive';
import { driveItems, driveLibraries, drivePermissions, groupMembers, groups, orm, siteLists, sitePages, sites, users, type DriveRole, type Site } from '@forge/db';
import type { AppContext } from '../context';
import { badRequest, forbidden, notFound } from '../errors';
import { authenticate } from '../plugins/auth';
import type { App } from '../types';
import { siteListRoutes, viewsOf } from './site-lists';

const { and, asc, desc, eq, inArray, isNotNull, isNull } = orm;
const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });
const COLOR = '^#[0-9a-fA-F]{6}$';
const Doc = Type.Object({ type: Type.Literal('doc') }, { additionalProperties: true });

export const slugify = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'page';

/** A new site's home page: a welcome, news, its documents and recent activity. */
const homeContent = (name: string) => ({
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: `Welcome to ${name}` }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Edit this page to tell people what this site is for.' }] },
    { type: 'forgeWidget', attrs: { widget: 'news', title: 'News' } },
    { type: 'forgeWidget', attrs: { widget: 'library', title: 'Documents' } },
    { type: 'forgeWidget', attrs: { widget: 'activity', title: 'Recent activity' } },
  ],
});

/**
 * ForgeSites: intranet portals, department homepages, wikis and news. A
 * site's document library holds its files, and the library's permissions are
 * the site's permissions (members, owners, or everyone in the organisation).
 */
/** Delete a site: its pages, lists and its library with every file in it. */
export async function deleteSite(ctx: AppContext, site: Site) {
  // Release stored file content before the library (and everything in it) goes.
  const roots = await ctx.db.select().from(driveItems).where(and(eq(driveItems.libraryId, site.libraryId), isNull(driveItems.parentId)));
  for (const r of roots) await purge(ctx.drive, r);
  await ctx.db.delete(sites).where(eq(sites.id, site.id));
  await ctx.db.delete(driveLibraries).where(eq(driveLibraries.id, site.libraryId));
}

export function siteRoutes(app: App, ctx: AppContext) {
  const { db } = ctx;
  app.addHook('preHandler', authenticate(ctx));
  const me = (req: { principal: { user: { id: string; orgId: string } } | null }) => req.principal!.user;

  const roleOn = async (p: Principal, site: Site): Promise<DriveRole | null> => {
    const [lib] = await db.select().from(driveLibraries).where(eq(driveLibraries.id, site.libraryId)).limit(1);
    return lib ? effectiveRole(db, p, lib, null) : null;
  };
  const requireSite = async (req: { principal: { user: { id: string; orgId: string } } | null }, where: { id?: string; slug?: string }, need: DriveRole) => {
    const [site] = await db
      .select()
      .from(sites)
      .where(and(eq(sites.orgId, me(req).orgId), where.id ? eq(sites.id, where.id) : eq(sites.slug, where.slug!)))
      .limit(1);
    if (!site) throw notFound('Site');
    const role = await roleOn(await principalFor(db, me(req).id), site);
    if (!role) throw notFound('Site');
    if (!atLeast(role, need)) throw forbidden(need === 'owner' ? 'Only site owners can do this' : 'You can only view this site');
    return { site, role };
  };
  const serialiseSite = (s: Site, role: DriveRole) => ({ id: s.id, slug: s.slug, name: s.name, description: s.description, color: s.color, visibility: s.visibility, libraryId: s.libraryId, groupId: s.groupId, role, canEdit: atLeast(role, 'editor') });

  const freeSlug = async (table: 'site' | 'page', base: string, siteId?: string) => {
    for (let n = 1; n < 500; n++) {
      const slug = n === 1 ? base : `${base}-${n}`;
      const taken =
        table === 'site'
          ? (await db.select({ id: sites.id }).from(sites).where(eq(sites.slug, slug)).limit(1)).length
          : (await db.select({ id: sitePages.id }).from(sitePages).where(and(eq(sitePages.siteId, siteId!), eq(sitePages.slug, slug))).limit(1)).length;
      if (!taken) return slug;
    }
    throw badRequest('Choose a different name');
  };

  app.get('/api/v1/sites/teams', { schema: { tags: ['sites'], summary: 'Security groups you belong to, which a new site can be attached to' } }, async (req) => {
    const user = me(req);
    const rows = await db
      .select({ id: groups.id, name: groups.name, role: groupMembers.role })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .where(and(eq(groupMembers.userId, user.id), eq(groups.orgId, user.orgId), eq(groups.type, 'security')))
      .orderBy(asc(groups.name));
    return { items: rows };
  });

  app.get('/api/v1/sites', { schema: { tags: ['sites'], summary: 'Sites you can visit' } }, async (req) => {
    const p = await principalFor(db, me(req).id);
    const all = await db.select().from(sites).where(eq(sites.orgId, me(req).orgId)).orderBy(asc(sites.name));
    const out = [];
    for (const s of all) {
      const role = await roleOn(p, s);
      if (role) out.push(serialiseSite(s, role));
    }
    return { items: out };
  });

  app.post(
    '/api/v1/sites',
    {
      schema: {
        tags: ['sites'],
        summary: 'Create a site (you become its owner)',
        body: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 120 }),
          description: Type.Optional(Type.String({ maxLength: 1000 })),
          color: Type.Optional(Type.String({ pattern: COLOR })),
          visibility: Type.Optional(Type.Union([Type.Literal('organisation'), Type.Literal('members')])),
          groupId: Type.Optional(Type.String({ format: 'uuid' })),
        }),
      },
    },
    async (req, reply) => {
      const user = me(req);
      const b = req.body;
      if (b.groupId) {
        const [g] = await db.select().from(groups).where(and(eq(groups.id, b.groupId), eq(groups.orgId, user.orgId))).limit(1);
        if (!g || g.type !== 'security') throw badRequest('That team does not exist');
        const [m] = await db.select().from(groupMembers).where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.userId, user.id))).limit(1);
        if (!m) throw forbidden('You can only attach a site to a team you belong to');
      }
      const visibility = b.visibility ?? 'members';
      const [lib] = await db
        .insert(driveLibraries)
        .values({ orgId: user.orgId, kind: 'site', name: b.name.trim(), groupId: b.groupId ?? null, everyoneRole: visibility === 'organisation' ? 'viewer' : null })
        .returning();
      await db.insert(drivePermissions).values({ libraryId: lib!.id, itemId: null, principalType: 'user', principalId: user.id, role: 'owner', createdBy: user.id });
      const [site] = await db
        .insert(sites)
        .values({ orgId: user.orgId, slug: await freeSlug('site', slugify(b.name)), name: b.name.trim(), description: b.description ?? '', color: b.color ?? '#4f46e5', visibility, libraryId: lib!.id, groupId: b.groupId ?? null, createdBy: user.id })
        .returning();
      await db.insert(sitePages).values({ siteId: site!.id, slug: 'home', title: 'Home', content: homeContent(site!.name), isHome: true, publishedAt: new Date(), createdBy: user.id, updatedBy: user.id });
      await ctx.audit.fromRequest(req, { action: 'sites.site_created', targetType: 'site', targetId: site!.id, targetLabel: site!.name, metadata: { visibility, groupId: b.groupId ?? null } });
      reply.code(201);
      return { site: serialiseSite(site!, 'owner') };
    },
  );

  app.get('/api/v1/sites/by-slug/:slug', { schema: { tags: ['sites'], summary: 'A site and its navigation', params: Type.Object({ slug: Type.String({ maxLength: 80 }) }) } }, async (req) => {
    const { site, role } = await requireSite(req, { slug: req.params.slug }, 'viewer');
    const pages = await db
      .select({ id: sitePages.id, slug: sitePages.slug, title: sitePages.title, isHome: sitePages.isHome, sortOrder: sitePages.sortOrder })
      .from(sitePages)
      .where(and(eq(sitePages.siteId, site.id), eq(sitePages.isNews, false)))
      .orderBy(desc(sitePages.isHome), asc(sitePages.sortOrder), asc(sitePages.title));
    const lists = (await db.select().from(siteLists).where(eq(siteLists.siteId, site.id)).orderBy(asc(siteLists.name))).map((l) => ({ id: l.id, name: l.name, views: viewsOf(l).map((v) => ({ id: v.id, name: v.name })) }));
    return { site: serialiseSite(site, role), pages, lists };
  });

  app.patch(
    '/api/v1/sites/:id',
    {
      schema: {
        tags: ['sites'],
        summary: 'Change a site’s name, look or who can see it',
        params: IdParams,
        body: Type.Object({ name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })), description: Type.Optional(Type.String({ maxLength: 1000 })), color: Type.Optional(Type.String({ pattern: COLOR })), visibility: Type.Optional(Type.Union([Type.Literal('organisation'), Type.Literal('members')])) }),
      },
    },
    async (req) => {
      const { site } = await requireSite(req, { id: req.params.id }, 'owner');
      const [updated] = await db.update(sites).set(req.body).where(eq(sites.id, site.id)).returning();
      if (req.body.visibility) await db.update(driveLibraries).set({ everyoneRole: req.body.visibility === 'organisation' ? 'viewer' : null }).where(eq(driveLibraries.id, site.libraryId));
      if (req.body.name) await db.update(driveLibraries).set({ name: req.body.name }).where(eq(driveLibraries.id, site.libraryId));
      await ctx.audit.fromRequest(req, { action: 'sites.site_updated', targetType: 'site', targetId: site.id, targetLabel: updated!.name, metadata: req.body });
      return { site: serialiseSite(updated!, 'owner') };
    },
  );

  app.delete('/api/v1/sites/:id', { schema: { tags: ['sites'], summary: 'Delete a site, its pages and its documents', params: IdParams } }, async (req) => {
    const { site } = await requireSite(req, { id: req.params.id }, 'owner');
    await deleteSite(ctx, site);
    await ctx.audit.fromRequest(req, { action: 'sites.site_deleted', targetType: 'site', targetId: site.id, targetLabel: site.name });
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Pages and news
  // ---------------------------------------------------------------------------

  const authorNames = async (ids: (string | null)[]) => {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    return new Map((list.length ? await db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, list)) : []).map((u) => [u.id, u.name]));
  };

  app.get('/api/v1/sites/:id/pages/:slug', { schema: { tags: ['sites'], summary: 'A page', params: Type.Object({ id: Type.String({ format: 'uuid' }), slug: Type.String({ maxLength: 80 }) }) } }, async (req) => {
    const { site, role } = await requireSite(req, { id: req.params.id }, 'viewer');
    const [page] = await db.select().from(sitePages).where(and(eq(sitePages.siteId, site.id), eq(sitePages.slug, req.params.slug))).limit(1);
    if (!page || (!page.publishedAt && !atLeast(role, 'editor'))) throw notFound('Page');
    const people = await authorNames([page.createdBy, page.updatedBy]);
    return { page: { ...page, author: people.get(page.createdBy ?? '') ?? null, editor: people.get(page.updatedBy ?? '') ?? null } };
  });

  app.post(
    '/api/v1/sites/:id/pages',
    {
      schema: {
        tags: ['sites'],
        summary: 'Add a page or a news post',
        params: IdParams,
        body: Type.Object({ title: Type.String({ minLength: 1, maxLength: 200 }), isNews: Type.Optional(Type.Boolean()), content: Type.Optional(Doc), publish: Type.Optional(Type.Boolean()) }),
      },
    },
    async (req, reply) => {
      const { site } = await requireSite(req, { id: req.params.id }, 'editor');
      const b = req.body;
      const content = b.content ?? { type: 'doc', content: [{ type: 'paragraph' }] };
      if (JSON.stringify(content).length > 1_000_000) throw badRequest('This page is too large');
      const [page] = await db
        .insert(sitePages)
        .values({ siteId: site.id, slug: await freeSlug('page', slugify(b.title), site.id), title: b.title.trim(), content, isNews: !!b.isNews, publishedAt: b.publish === false ? null : new Date(), createdBy: me(req).id, updatedBy: me(req).id })
        .returning();
      reply.code(201);
      return { page };
    },
  );

  app.put(
    '/api/v1/sites/:id/pages/:pageId',
    {
      schema: {
        tags: ['sites'],
        summary: 'Save a page',
        params: Type.Object({ id: Type.String({ format: 'uuid' }), pageId: Type.String({ format: 'uuid' }) }),
        body: Type.Object({ title: Type.String({ minLength: 1, maxLength: 200 }), content: Doc, publish: Type.Optional(Type.Boolean()), sortOrder: Type.Optional(Type.Integer()) }),
      },
    },
    async (req) => {
      const { site } = await requireSite(req, { id: req.params.id }, 'editor');
      if (JSON.stringify(req.body.content).length > 1_000_000) throw badRequest('This page is too large');
      const [existing] = await db.select().from(sitePages).where(and(eq(sitePages.id, req.params.pageId), eq(sitePages.siteId, site.id))).limit(1);
      if (!existing) throw notFound('Page');
      const publishedAt = req.body.publish === undefined ? existing.publishedAt : req.body.publish ? (existing.publishedAt ?? new Date()) : null;
      const [page] = await db
        .update(sitePages)
        .set({ title: req.body.title.trim(), content: req.body.content, publishedAt: existing.isHome ? existing.publishedAt : publishedAt, sortOrder: req.body.sortOrder ?? existing.sortOrder, updatedBy: me(req).id })
        .where(eq(sitePages.id, existing.id))
        .returning();
      return { page };
    },
  );

  app.delete('/api/v1/sites/:id/pages/:pageId', { schema: { tags: ['sites'], summary: 'Delete a page', params: Type.Object({ id: Type.String({ format: 'uuid' }), pageId: Type.String({ format: 'uuid' }) }) } }, async (req) => {
    const { site } = await requireSite(req, { id: req.params.id }, 'editor');
    const [page] = await db.select().from(sitePages).where(and(eq(sitePages.id, req.params.pageId), eq(sitePages.siteId, site.id))).limit(1);
    if (!page) throw notFound('Page');
    if (page.isHome) throw badRequest('The home page cannot be deleted');
    await db.delete(sitePages).where(eq(sitePages.id, page.id));
    return { ok: true };
  });

  const newsItems = async (siteIds: string[], limit: number) => {
    if (!siteIds.length) return [];
    const rows = await db
      .select({ id: sitePages.id, siteId: sitePages.siteId, slug: sitePages.slug, title: sitePages.title, content: sitePages.content, publishedAt: sitePages.publishedAt, createdBy: sitePages.createdBy })
      .from(sitePages)
      .where(and(inArray(sitePages.siteId, siteIds), eq(sitePages.isNews, true), isNotNull(sitePages.publishedAt)))
      .orderBy(desc(sitePages.publishedAt))
      .limit(limit);
    const people = await authorNames(rows.map((r) => r.createdBy));
    const siteRows = await db.select({ id: sites.id, name: sites.name, slug: sites.slug, color: sites.color }).from(sites).where(inArray(sites.id, siteIds));
    // A short plain-text excerpt for cards.
    const excerpt = (doc: unknown): string => {
      const parts: string[] = [];
      const walk = (n: unknown) => {
        if (!n || typeof n !== 'object' || parts.join(' ').length > 240) return;
        const node = n as { text?: string; content?: unknown[] };
        if (node.text) parts.push(node.text);
        node.content?.forEach(walk);
      };
      walk(doc);
      return parts.join(' ').slice(0, 240);
    };
    return rows.map(({ content, createdBy, ...r }) => ({ ...r, excerpt: excerpt(content), author: people.get(createdBy ?? '') ?? null, site: siteRows.find((s) => s.id === r.siteId) ?? null }));
  };

  app.get('/api/v1/sites/:id/news', { schema: { tags: ['sites'], summary: 'A site’s news posts', params: IdParams } }, async (req) => {
    const { site } = await requireSite(req, { id: req.params.id }, 'viewer');
    return { items: await newsItems([site.id], 50) };
  });

  app.get('/api/v1/sites/news', { schema: { tags: ['sites'], summary: 'Latest news from every site you can visit' } }, async (req) => {
    const p = await principalFor(db, me(req).id);
    const all = await db.select().from(sites).where(eq(sites.orgId, me(req).orgId));
    const readable: string[] = [];
    for (const s of all) if (await roleOn(p, s)) readable.push(s.id);
    return { items: await newsItems(readable, 20) };
  });

  siteListRoutes(app, ctx, requireSite);
}
