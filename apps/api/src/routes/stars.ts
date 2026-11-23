import { Type } from 'typebox';
import { effectiveRole, principalFor, requireItem } from '@forge/drive';
import { driveItems, driveLibraries, orm, siteListItems, siteLists, sites, stars } from '@forge/db';
import type { AppContext } from '../context';
import { notFound } from '../errors';
import { authenticate } from '../plugins/auth';
import type { App } from '../types';

const { and, desc, eq, inArray } = orm;

/**
 * Stars: documents, folders and list items someone follows. Changes others
 * make to them are emailed (see runStarNotifications in @forge/drive).
 */
export function starRoutes(app: App, ctx: AppContext) {
  const { db } = ctx;
  app.addHook('preHandler', authenticate(ctx));
  const Params = Type.Object({ kind: Type.Union([Type.Literal('drive_item'), Type.Literal('list_item')]), targetId: Type.String({ format: 'uuid' }) });

  /** A list item, if this person can see its site. */
  const visibleListItem = async (userId: string, itemId: string) => {
    const [row] = await db
      .select({ item: siteListItems, list: siteLists, site: sites })
      .from(siteListItems)
      .innerJoin(siteLists, eq(siteLists.id, siteListItems.listId))
      .innerJoin(sites, eq(sites.id, siteLists.siteId))
      .where(eq(siteListItems.id, itemId))
      .limit(1);
    if (!row) return null;
    const [lib] = await db.select().from(driveLibraries).where(eq(driveLibraries.id, row.site.libraryId)).limit(1);
    return lib && (await effectiveRole(db, await principalFor(db, userId), lib, null)) ? row : null;
  };

  app.put('/api/v1/stars/:kind/:targetId', { schema: { tags: ['drive'], summary: 'Star a document, folder or list item (and get emails when others change it)', params: Params } }, async (req) => {
    const user = req.principal!.user;
    if (req.params.kind === 'drive_item') await requireItem(db, await principalFor(db, user.id), req.params.targetId, 'viewer');
    else if (!(await visibleListItem(user.id, req.params.targetId))) throw notFound('Item');
    await db.insert(stars).values({ userId: user.id, kind: req.params.kind, targetId: req.params.targetId }).onConflictDoNothing();
    return { starred: true };
  });

  app.delete('/api/v1/stars/:kind/:targetId', { schema: { tags: ['drive'], summary: 'Unstar', params: Params } }, async (req) => {
    await db.delete(stars).where(and(eq(stars.userId, req.principal!.user.id), eq(stars.kind, req.params.kind), eq(stars.targetId, req.params.targetId)));
    return { starred: false };
  });

  app.get('/api/v1/stars', { schema: { tags: ['drive'], summary: 'What you starred: documents and folders, and list items' } }, async (req) => {
    const user = req.principal!.user;
    const mine = await db.select().from(stars).where(eq(stars.userId, user.id)).orderBy(desc(stars.createdAt));
    const p = await principalFor(db, user.id);

    const driveIds = mine.filter((s) => s.kind === 'drive_item').map((s) => s.targetId);
    const documents: { id: string; libraryId: string; parentId: string | null; kind: string; name: string; mime: string | null; size: number; updatedAt: Date; libraryName: string }[] = [];
    if (driveIds.length) {
      const rows = await db.select({ item: driveItems, lib: driveLibraries }).from(driveItems).innerJoin(driveLibraries, eq(driveLibraries.id, driveItems.libraryId)).where(inArray(driveItems.id, driveIds));
      for (const id of driveIds) {
        const r = rows.find((x) => x.item.id === id);
        if (!r || r.item.deletedAt || !(await effectiveRole(db, p, r.lib, r.item))) continue;
        documents.push({ id: r.item.id, libraryId: r.lib.id, parentId: r.item.parentId, kind: r.item.kind, name: r.item.name, mime: r.item.mime, size: r.item.size, updatedAt: r.item.updatedAt, libraryName: r.lib.kind === 'personal' && r.lib.ownerUserId === user.id ? 'My files' : r.lib.name });
      }
    }

    const listItems: { id: string; title: string; listId: string; listName: string; siteSlug: string; siteName: string; siteColor: string; updatedAt: Date }[] = [];
    for (const s of mine.filter((x) => x.kind === 'list_item')) {
      const row = await visibleListItem(user.id, s.targetId);
      if (row) listItems.push({ id: row.item.id, title: String(row.item.values.title ?? ''), listId: row.list.id, listName: row.list.name, siteSlug: row.site.slug, siteName: row.site.name, siteColor: row.site.color, updatedAt: row.item.updatedAt });
    }
    return { documents, listItems };
  });
}
