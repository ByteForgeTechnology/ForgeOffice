import { buildTask, deleteCalendarObject, ensureTaskLists, findByUid, flagTaskUid, messageIdFromTaskUid, parseTask, putCalendarObject } from '@forge/calendar';
import { messages, orm, users, type Message } from '@forge/db';
import type { MailContext } from './context';
import { setFlags } from './store';

const { eq, inArray } = orm;

/*
 * Flagged email ↔ tasks, as in Outlook:
 *  - flag a message        → a task appears in the owner's "Flagged email" list
 *  - unflag it             → the task is marked complete
 *  - flag it again         → the same task is reopened
 *  - complete the task     → the message is unflagged
 *  - reopen / delete task  → the message is flagged again / unflagged
 *  - delete the message    → the task goes too
 * Changes from webmail, IMAP apps, mail rules and CalDAV task apps all meet here.
 */

type Ctx = Pick<MailContext, 'db' | 'bus' | 'events'> & Partial<Pick<MailContext, 'log' | 'config'>>;

const sender = (m: Pick<Message, 'fromAddr'>) => (m.fromAddr ? (m.fromAddr.name ? `${m.fromAddr.name} <${m.fromAddr.address}>` : m.fromAddr.address) : null);

function notifyTasks(ctx: Ctx, userIds: string[]) {
  const payload = { userIds: [...new Set(userIds)] };
  if (!payload.userIds.length) return;
  if (ctx.bus) void ctx.bus.publish('calendar.changed', payload).catch(() => ctx.events.emit('calendar.changed', payload));
  else ctx.events.emit('calendar.changed', payload);
}

/** Make each message's task match its flag. Never throws: mail operations must not fail because of tasks. */
export async function syncFlagTasks(ctx: Ctx, changed: Message[]): Promise<void> {
  if (!changed.length) return;
  try {
    const owners = await ctx.db.select({ id: users.id, orgId: users.orgId }).from(users).where(inArray(users.id, [...new Set(changed.map((m) => m.userId))]));
    const touched: string[] = [];
    for (const owner of owners) {
      const { flagged: list } = await ensureTaskLists(ctx.db, owner);
      for (const m of changed.filter((x) => x.userId === owner.id)) {
        const uid = flagTaskUid(m.id);
        const existing = await findByUid(ctx.db, [list.id], uid);
        const task = existing ? parseTask(existing.ics) : null;
        if (m.flagged && !task) {
          const ics = buildTask({ uid, title: m.subject || '(no subject)', from: sender(m) ?? undefined, url: `${ctx.config?.publicUrl ?? ''}/mail?message=${m.id}`, status: 'NEEDS-ACTION' });
          await putCalendarObject(ctx.db, list.id, `${uid}.ics`, ics);
        } else if (m.flagged && task?.status === 'COMPLETED') {
          await putCalendarObject(ctx.db, list.id, existing!.href, buildTask({ status: 'NEEDS-ACTION' }, existing!.ics));
        } else if (!m.flagged && task && task.status !== 'COMPLETED') {
          await putCalendarObject(ctx.db, list.id, existing!.href, buildTask({ status: 'COMPLETED' }, existing!.ics));
        } else continue;
        touched.push(owner.id);
      }
    }
    notifyTasks(ctx, touched);
  } catch (err) {
    ctx.log?.warn({ err: (err as Error).message }, 'could not update flagged-email tasks');
  }
}

/** Messages were permanently deleted: remove their tasks. */
export async function removeFlagTasks(ctx: Ctx, removed: Pick<Message, 'id' | 'userId'>[]): Promise<void> {
  if (!removed.length) return;
  try {
    const owners = await ctx.db.select({ id: users.id, orgId: users.orgId }).from(users).where(inArray(users.id, [...new Set(removed.map((m) => m.userId))]));
    const touched: string[] = [];
    for (const owner of owners) {
      const { flagged: list } = await ensureTaskLists(ctx.db, owner);
      for (const m of removed.filter((x) => x.userId === owner.id)) {
        const existing = await findByUid(ctx.db, [list.id], flagTaskUid(m.id));
        if (existing && (await deleteCalendarObject(ctx.db, list.id, existing.href))) touched.push(owner.id);
      }
    }
    notifyTasks(ctx, touched);
  } catch (err) {
    ctx.log?.warn({ err: (err as Error).message }, 'could not remove flagged-email tasks');
  }
}

/**
 * A flagged-email task was changed outside mail (task list in the web app,
 * or a phone/desktop task app over CalDAV): bring the message's flag in line.
 * `ics` is null when the task was deleted.
 */
export async function applyFlagTaskChange(ctx: Pick<MailContext, 'db' | 'bus' | 'events'>, ownerId: string, uid: string, ics: string | null): Promise<void> {
  const messageId = messageIdFromTaskUid(uid);
  if (!messageId) return;
  const [m] = await ctx.db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!m || m.userId !== ownerId) return;
  const shouldFlag = ics ? parseTask(ics).status !== 'COMPLETED' : false;
  if (m.flagged !== shouldFlag) await setFlags(ctx, ownerId, [m.id], { flagged: shouldFlag });
}
