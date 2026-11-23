import { driveActivity, driveItems, driveLibraries, orm, siteListActivity, siteListItems, siteLists, sites, stars, users, type Database, type DriveItem, type Star } from '@forge/db';
import { effectiveRole, principalFor, requireItem } from './acl';
import { ancestors } from './items';

const { and, eq, gt, inArray, lte, lt, min, sql } = orm;

/**
 * Starred documents, folders and list items. Changes other people make to
 * them are batched into one email per person per run (the worker runs this
 * every couple of minutes). A starred folder covers everything inside it.
 * Each person is only told about what they can still see.
 */

/** Drive actions worth an email, as "<who> <verb> <name>". */
const DRIVE_VERBS: Record<string, string> = {
  version_added: 'saved a new version of',
  file_uploaded: 'added',
  folder_created: 'created the folder',
  renamed: 'renamed',
  moved: 'moved',
  deleted: 'deleted',
  restored: 'restored',
  version_restored: 'restored an earlier version of',
  checked_out: 'checked out',
  checked_in: 'checked in',
  check_out_discarded: 'discarded changes to',
  commented: 'commented on',
};

export interface StarEvent {
  at: Date;
  actor: string;
  /** e.g. "saved a new version of". */
  verb: string;
  name: string;
  /** Where it is: a folder ("in Projects") or a list ("in Office moves"). */
  where: string | null;
  /** Changed list columns. */
  changes?: { column: string; from: string; to: string }[];
  url: string;
}

export interface StarEmail {
  to: { name: string; address: string };
  subject: string;
  text: string;
  html: string;
  events: StarEvent[];
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function renderStarEmail(to: { name: string; address: string }, events: StarEvent[], publicUrl: string): StarEmail {
  const first = events[0]!;
  const subject = events.length === 1 ? `${first.actor} ${first.verb} “${first.name}”` : `${events.length} changes to things you starred`;
  const line = (e: StarEvent) => `${e.actor} ${e.verb} “${e.name}”${e.where ? ` ${e.where}` : ''}`;
  const changeText = (c: { column: string; from: string; to: string }) => (c.from || c.to ? `${c.column}: ${c.from} → ${c.to}` : `${c.column} changed`);
  const text = [
    `Hello ${to.name},`,
    '',
    events.length === 1 ? 'Something you starred has changed:' : 'Things you starred have changed:',
    '',
    ...events.flatMap((e) => [`• ${line(e)}`, ...(e.changes ?? []).map((c) => `    ${changeText(c)}`), `  ${e.url}`, '']),
    `You get these emails because you starred these items. Unstar them to stop. Your starred items: ${publicUrl}/drive?view=starred`,
  ].join('\n');
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;color:#18181b;line-height:1.5">
<p>Hello ${esc(to.name)},</p>
<p>${events.length === 1 ? 'Something you starred has changed:' : 'Things you starred have changed:'}</p>
<ul style="padding-left:20px">${events
    .map(
      (e) =>
        `<li style="margin-bottom:10px"><strong>${esc(e.actor)}</strong> ${esc(e.verb)} <a href="${esc(e.url)}">${esc(e.name)}</a>${e.where ? ` ${esc(e.where)}` : ''}${
          e.changes?.length ? `<br><span style="color:#52525b">${e.changes.map((c) => esc(changeText(c))).join('<br>')}</span>` : ''
        }</li>`,
    )
    .join('')}</ul>
<p style="color:#71717a;font-size:12px">You get these emails because you starred these items. Unstar them to stop. <a href="${esc(publicUrl)}/drive?view=starred">Your starred items</a></p>
</body></html>`;
  return { to, subject, text, html, events };
}

/**
 * Tell everyone about changes to what they starred since they were last told.
 * `send` delivers one email; a person whose email fails is retried next run.
 */
export async function runStarNotifications(db: Database, opts: { publicUrl: string; send: (email: StarEmail) => Promise<void>; now?: Date; log?: { warn: (o: unknown, m?: string) => void } }) {
  const now = opts.now ?? new Date();
  const [range] = await db.select({ since: min(stars.notifiedAt) }).from(stars).where(lt(stars.notifiedAt, now));
  if (!range?.since) return { emails: 0 };
  // Never look back more than a week (e.g. after the worker was down).
  const since = new Date(Math.max(new Date(range.since).getTime(), now.getTime() - 7 * 86_400_000));
  const allStars = await db.select().from(stars).where(lt(stars.notifiedAt, now));

  const byUser = new Map<string, { star: Star; event: StarEvent }[]>();
  const add = (star: Star, event: StarEvent) => {
    if (!byUser.has(star.userId)) byUser.set(star.userId, []);
    const list = byUser.get(star.userId)!;
    // One line per change, even when several stars (a file and its folder) cover it.
    if (!list.some((x) => x.event.url === event.url && x.event.at.getTime() === event.at.getTime() && x.event.verb === event.verb)) list.push({ star, event });
  };
  const names = new Map<string, string>();
  const nameOf = async (id: string | null) => {
    if (!id) return 'Someone';
    if (!names.has(id)) {
      const [u] = await db.select({ name: users.displayName }).from(users).where(eq(users.id, id)).limit(1);
      names.set(id, u?.name ?? 'Someone');
    }
    return names.get(id)!;
  };

  // ---- documents and folders -------------------------------------------------
  const driveStars = allStars.filter((s) => s.kind === 'drive_item');
  if (driveStars.length) {
    const events = await db
      .select()
      .from(driveActivity)
      .where(and(gt(driveActivity.createdAt, since), lte(driveActivity.createdAt, now), inArray(driveActivity.action, Object.keys(DRIVE_VERBS))))
      .orderBy(driveActivity.id);
    const starredIds = new Set(driveStars.map((s) => s.targetId));
    const chains = new Map<string, { chain: string[]; item: DriveItem | null }>();
    for (const e of events) {
      if (!e.itemId) continue;
      if (!chains.has(e.itemId)) {
        const [item] = await db.select().from(driveItems).where(eq(driveItems.id, e.itemId)).limit(1);
        chains.set(e.itemId, { chain: item ? (await ancestors({ db }, item)).map((a) => a.id) : [e.itemId], item: item ?? null });
      }
      const { chain, item } = chains.get(e.itemId)!;
      if (!chain.some((id) => starredIds.has(id))) continue;
      for (const star of driveStars) {
        if (!chain.includes(star.targetId) || e.createdAt <= star.notifiedAt || e.userId === star.userId) continue;
        // Only what they can still see (trashed items included, so deletions are told).
        if (item) {
          try {
            await requireItem(db, await principalFor(db, star.userId), item.id, 'viewer', { includeDeleted: true });
          } catch {
            continue;
          }
        }
        const parent = item?.parentId ? (await db.select({ name: driveItems.name }).from(driveItems).where(eq(driveItems.id, item.parentId)).limit(1))[0] : undefined;
        const viaFolder = star.targetId !== e.itemId;
        const name = e.action === 'renamed' && typeof e.detail?.from === 'string' ? (e.detail.from as string) : e.itemName;
        add(star, {
          at: e.createdAt,
          actor: await nameOf(e.userId),
          verb: DRIVE_VERBS[e.action]!,
          name,
          where: e.action === 'renamed' && item ? `to “${item.name}”` : viaFolder && parent ? `in ${parent.name}` : null,
          url: `${opts.publicUrl}/drive?library=${e.libraryId}${item?.parentId ? `&folder=${item.parentId}` : ''}${item && !item.deletedAt ? `&item=${item.id}` : ''}`,
        });
      }
    }
  }

  // ---- list items ------------------------------------------------------------
  const listStars = allStars.filter((s) => s.kind === 'list_item');
  if (listStars.length) {
    const events = await db
      .select({ a: siteListActivity, listName: siteLists.name, slug: sites.slug, libraryId: sites.libraryId })
      .from(siteListActivity)
      .innerJoin(siteLists, eq(siteLists.id, siteListActivity.listId))
      .innerJoin(sites, eq(sites.id, siteLists.siteId))
      .where(and(gt(siteListActivity.createdAt, since), lte(siteListActivity.createdAt, now), inArray(siteListActivity.itemId, listStars.map((s) => s.targetId))))
      .orderBy(siteListActivity.id);
    for (const { a, listName, slug, libraryId } of events) {
      for (const star of listStars) {
        if (star.targetId !== a.itemId || a.createdAt <= star.notifiedAt || a.userId === star.userId) continue;
        const [lib] = await db.select().from(driveLibraries).where(eq(driveLibraries.id, libraryId)).limit(1);
        if (!lib || !(await effectiveRole(db, await principalFor(db, star.userId), lib, null))) continue;
        add(star, {
          at: a.createdAt,
          actor: await nameOf(a.userId),
          verb: a.action === 'deleted' ? 'deleted' : 'changed',
          name: a.itemTitle || 'an item',
          where: `in ${listName}`,
          changes: a.detail?.changes,
          url: `${opts.publicUrl}/sites/${slug}/lists/${a.listId}${a.action === 'deleted' ? '' : `?item=${a.itemId}`}`,
        });
      }
    }
  }

  // ---- send, then move everyone's "told up to" forward ----------------------
  let emails = 0;
  const failed = new Set<string>();
  for (const [userId, entries] of byUser) {
    const [u] = await db.select({ name: users.displayName, email: users.email, status: users.status }).from(users).where(eq(users.id, userId)).limit(1);
    if (!u?.email || u.status !== 'active') continue;
    const events = entries.map((x) => x.event).sort((a, b) => a.at.getTime() - b.at.getTime());
    try {
      await opts.send(renderStarEmail({ name: u.name, address: u.email }, events, opts.publicUrl));
      emails++;
    } catch (err) {
      failed.add(userId);
      opts.log?.warn({ err, userId }, 'could not send a starred-items email');
    }
  }
  const told = allStars.filter((s) => !failed.has(s.userId));
  for (const kind of ['drive_item', 'list_item'] as const) {
    const ids = told.filter((s) => s.kind === kind);
    if (!ids.length) continue;
    await db
      .update(stars)
      .set({ notifiedAt: now })
      .where(and(eq(stars.kind, kind), lt(stars.notifiedAt, now), inArray(sql`(${stars.userId}, ${stars.targetId})`, ids.map((s) => sql`(${s.userId}::uuid, ${s.targetId}::uuid)`))));
  }

  // Stars on things that are gone for good (purged files, deleted list items), now that it has been told.
  await db.delete(stars).where(and(eq(stars.kind, 'drive_item'), lte(stars.notifiedAt, now), sql`not exists (select 1 from ${driveItems} where ${driveItems.id} = ${stars.targetId})`));
  await db.delete(stars).where(and(eq(stars.kind, 'list_item'), lte(stars.notifiedAt, now), sql`not exists (select 1 from ${siteListItems} where ${siteListItems.id} = ${stars.targetId})`));
  return { emails };
}
