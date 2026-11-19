import { Type, type Static } from 'typebox';
import {
  accessibleCalendars,
  buildTask,
  bumpTaskSequence,
  delegatedMailboxes,
  deleteCalendarObject,
  ensureTaskLists,
  nextDue,
  parseTask,
  putCalendarObject,
  resolvePrincipal,
  setTaskResponse,
  taskReply,
  withMethod,
  type CalendarAccess,
  type TaskInfo,
  type TaskPerson,
} from '@forge/calendar';
import { calendarObjects, calendars, messages, orm, users, type Calendar, type CalendarObject, type MailAddress } from '@forge/db';
import { applyFlagTaskChange, composeMessage, submitMessage } from '@forge/mail';
import type { AppContext } from '../context';
import { badRequest, forbidden, notFound } from '../errors';
import { authenticate } from '../plugins/auth';
import type { App } from '../types';

const { and, eq, inArray, isNull } = orm;
const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });
const DATE = '^\\d{4}-\\d{2}-\\d{2}$';
const COLOR = '^#[0-9a-fA-F]{6}$';

const Importance = Type.Union([Type.Literal('low'), Type.Literal('normal'), Type.Literal('high')]);
const Repeat = Type.Union([Type.Literal('daily'), Type.Literal('weekdays'), Type.Literal('weekly'), Type.Literal('monthly'), Type.Literal('yearly'), Type.Null()]);
const Status = Type.Union([Type.Literal('NEEDS-ACTION'), Type.Literal('IN-PROCESS'), Type.Literal('COMPLETED')]);
const TaskChanges = {
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  notes: Type.Optional(Type.String({ maxLength: 20_000 })),
  due: Type.Optional(Type.Union([Type.String({ pattern: DATE }), Type.Null()])),
  reminder: Type.Optional(Type.Union([Type.String({ format: 'date-time' }), Type.Null()])),
  importance: Type.Optional(Importance),
  repeat: Type.Optional(Repeat),
};
const CreateBody = Type.Object({
  listId: Type.Optional(Type.String({ format: 'uuid' })),
  ...TaskChanges,
  title: Type.String({ minLength: 1, maxLength: 500 }),
  /** Email address of someone in the organisation to assign the task to. */
  assignTo: Type.Optional(Type.String({ maxLength: 320 })),
});
const UpdateBody = Type.Object({
  ...TaskChanges,
  status: Type.Optional(Status),
  listId: Type.Optional(Type.String({ format: 'uuid' })),
  /** Assign, reassign (address) or take back (null). */
  assignTo: Type.Optional(Type.Union([Type.String({ maxLength: 320 }), Type.Null()])),
  /** The assignee's answer to a task request. */
  response: Type.Optional(Type.Union([Type.Literal('ACCEPTED'), Type.Literal('DECLINED')])),
});

type List = Calendar & { access: CalendarAccess };
type Role = 'assigner' | 'assignee' | null;

/**
 * Tasks (Outlook / To Do style). Lists are CalDAV collections of VTODOs, so
 * the same tasks sync to phone and desktop task apps. Each person (and shared
 * mailbox) has a default "Tasks" list and a "Flagged email" list that follows
 * message flags.
 *
 * Assigning works like Outlook: the assignee gets a task request by email and
 * a copy in their Tasks list; they accept or decline and report progress, and
 * the assigner's copy is kept up to date. Underneath this is standard iTIP
 * (REQUEST / REPLY / CANCEL) for VTODOs, delivered like meeting invitations.
 */
export function taskRoutes(app: App, ctx: AppContext) {
  const { db } = ctx;
  app.addHook('preHandler', authenticate(ctx));

  const me = (req: { principal: { user: { id: string; orgId: string; email: string; displayName: string } } | null }) => req.principal!.user;
  type Me = ReturnType<typeof me>;

  const lists = async (user: Me): Promise<List[]> => {
    await ensureTaskLists(db, user);
    return (await accessibleCalendars(db, user.id, 'tasks')).filter((c) => c.access !== 'freebusy');
  };
  const listFor = async (user: Me, id: string, write = false) => {
    const l = (await lists(user)).find((x) => x.id === id);
    if (!l) throw notFound('List');
    if (write && l.access !== 'owner' && l.access !== 'write') throw forbidden('You have read-only access to this list');
    return l;
  };
  const loadTask = async (user: Me, id: string, write = false) => {
    const [obj] = await db.select().from(calendarObjects).where(and(eq(calendarObjects.id, id), isNull(calendarObjects.deletedAt))).limit(1);
    if (!obj) throw notFound('Task');
    const list = (await lists(user)).find((l) => l.id === obj.calendarId);
    if (!list || obj.componentType !== 'VTODO') throw notFound('Task');
    if (write && list.access !== 'owner' && list.access !== 'write') throw forbidden('You have read-only access to this list');
    return { obj, list };
  };
  const changed = (list: List) => void ctx.bus?.publish('calendar.changed', { userIds: [list.ownerId] }).catch(() => {});
  /** Keep the message flag in step with a flagged-email task. */
  const syncFlag = async (list: List, uid: string, ics: string | null) => {
    if (list.ownerType === 'user') await applyFlagTaskChange(ctx.mail, list.ownerId, uid, ics);
  };

  const { ownerOf, roleOf, request, cancel, reply, assignable } = taskScheduling(ctx);

  const serialise = (o: CalendarObject, t: TaskInfo, role: Role, extra: { message?: unknown } = {}) => ({ id: o.id, listId: o.calendarId, ...t, role, ...extra });

  // ---------------------------------------------------------------------------
  // Lists
  // ---------------------------------------------------------------------------

  app.get('/api/v1/tasks/lists', { schema: { tags: ['tasks'], summary: 'Task lists you can see, with open task counts' } }, async (req) => {
    const user = me(req);
    const all = await lists(user);
    const owners = await db.select({ id: users.id, name: users.displayName, email: users.email }).from(users).where(inArray(users.id, [...new Set(all.map((l) => l.ownerId))]));
    const objs = all.length ? await db.select({ calendarId: calendarObjects.calendarId, ics: calendarObjects.ics }).from(calendarObjects).where(and(inArray(calendarObjects.calendarId, all.map((l) => l.id)), isNull(calendarObjects.deletedAt), eq(calendarObjects.componentType, 'VTODO'))) : [];
    const open = new Map<string, number>();
    for (const o of objs) {
      try {
        if (parseTask(o.ics).status !== 'COMPLETED') open.set(o.calendarId, (open.get(o.calendarId) ?? 0) + 1);
      } catch {
        /* unreadable task */
      }
    }
    return {
      items: all
        .map((l) => {
          const owner = owners.find((o) => o.id === l.ownerId);
          return {
            id: l.id,
            name: l.name,
            color: l.color,
            isDefault: l.isDefault && l.ownerId === user.id,
            role: l.role,
            access: l.access,
            owner: l.ownerId === user.id ? null : { id: l.ownerId, name: owner?.name ?? '', email: owner?.email ?? '' },
            openCount: open.get(l.id) ?? 0,
          };
        })
        .sort((a, b) => Number(!!a.owner) - Number(!!b.owner) || (a.owner?.name ?? '').localeCompare(b.owner?.name ?? '') || Number(b.isDefault) - Number(a.isDefault) || Number(!!b.role) - Number(!!a.role) || a.name.localeCompare(b.name)),
    };
  });

  app.post(
    '/api/v1/tasks/lists',
    { schema: { tags: ['tasks'], summary: 'Create a task list', body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 200 }), color: Type.Optional(Type.String({ pattern: COLOR })) }) } },
    async (req, reply) => {
      const user = me(req);
      const [row] = await db.insert(calendars).values({ orgId: user.orgId, ownerType: 'user', ownerId: user.id, kind: 'tasks', name: req.body.name.trim(), color: req.body.color ?? '#0891b2' }).returning();
      reply.code(201);
      return { list: { id: row!.id, name: row!.name, color: row!.color } };
    },
  );

  app.patch(
    '/api/v1/tasks/lists/:id',
    { schema: { tags: ['tasks'], summary: 'Rename or recolour a task list', params: IdParams, body: Type.Object({ name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), color: Type.Optional(Type.String({ pattern: COLOR })) }) } },
    async (req) => {
      const l = await listFor(me(req), req.params.id, true);
      if (l.role && req.body.name) throw badRequest('The Flagged email list cannot be renamed');
      await db.update(calendars).set({ ...(req.body.name ? { name: req.body.name.trim() } : {}), ...(req.body.color ? { color: req.body.color } : {}) }).where(eq(calendars.id, l.id));
      return { ok: true };
    },
  );

  app.delete('/api/v1/tasks/lists/:id', { schema: { tags: ['tasks'], summary: 'Delete a task list and its tasks', params: IdParams } }, async (req) => {
    const l = await listFor(me(req), req.params.id, true);
    if (l.access !== 'owner') throw forbidden('Only the owner can delete a list');
    if (l.isDefault || l.role) throw badRequest('This list cannot be deleted');
    await db.delete(calendars).where(eq(calendars.id, l.id));
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Tasks
  // ---------------------------------------------------------------------------

  app.get(
    '/api/v1/tasks',
    {
      schema: {
        tags: ['tasks'],
        summary: 'Tasks in a list, or a smart view across lists (important, planned, assigned to me, all)',
        querystring: Type.Object({
          listId: Type.Optional(Type.String({ format: 'uuid' })),
          view: Type.Optional(Type.Union([Type.Literal('important'), Type.Literal('planned'), Type.Literal('assigned'), Type.Literal('all')])),
        }),
      },
    },
    async (req) => {
      const user = me(req);
      const all = await lists(user);
      const { listId, view } = req.query;
      if (!listId && !view) throw badRequest('Choose a list or a view');
      const target = listId ? all.filter((l) => l.id === listId) : all;
      if (listId && !target.length) throw notFound('List');
      if (!target.length) return { items: [] };
      const owners = new Map((await db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, [...new Set(target.map((l) => l.ownerId))]))).map((u) => [u.id, u.email]));
      const ownerEmail = new Map(target.map((l) => [l.id, owners.get(l.ownerId) ?? '']));
      const objs = await db.select().from(calendarObjects).where(and(inArray(calendarObjects.calendarId, target.map((l) => l.id)), isNull(calendarObjects.deletedAt), eq(calendarObjects.componentType, 'VTODO')));
      const parsed = objs.flatMap((o) => {
        try {
          const t = parseTask(o.ics);
          return [{ o, t, role: roleOf(t, ownerEmail.get(o.calendarId)!) }];
        } catch {
          return [];
        }
      });
      const filtered = parsed.filter(({ t, role }) => (view === 'important' ? t.importance === 'high' : view === 'planned' ? !!t.due : view === 'assigned' ? role === 'assignee' : true));
      // Flagged email: where the message is now (it may have moved).
      const ids = filtered.map(({ t }) => t.messageId).filter((x): x is string => !!x);
      const msgs = ids.length
        ? await db.select({ id: messages.id, userId: messages.userId, mailboxId: messages.mailboxId, threadId: messages.threadId, flagged: messages.flagged }).from(messages).where(inArray(messages.id, ids))
        : [];
      return {
        items: filtered.map(({ o, t, role }) => serialise(o, t, role, t.messageId ? { message: msgs.find((m) => m.id === t.messageId) ?? null } : {})),
      };
    },
  );

  app.post('/api/v1/tasks', { schema: { tags: ['tasks'], summary: 'Create a task (optionally assigned to someone)', body: CreateBody } }, async (req, reply) => {
    const user = me(req);
    const { assignTo, ...b } = req.body as Static<typeof CreateBody>;
    const list = b.listId ? await listFor(user, b.listId, true) : await ensureTaskLists(db, user).then((x) => ({ ...x.tasks, access: 'owner' as const }));
    if (list.role === 'flagged') throw badRequest('Flag a message to add it to Flagged email');
    if (b.repeat && !b.due) throw badRequest('Set a due date for a repeating task');
    let assign: { organizer: TaskPerson; assignee: TaskPerson } | undefined;
    if (assignTo) {
      if (b.repeat) throw badRequest('Assigned tasks cannot repeat');
      const owner = await ownerOf(list);
      assign = { organizer: owner, assignee: await assignable(user, assignTo, owner) };
    }
    const ics = buildTask({ ...b, status: 'NEEDS-ACTION', assign });
    const t = parseTask(ics);
    const { object } = await putCalendarObject(db, list.id, `${t.uid}.ics`, ics);
    if (assign) await request(user, list, object.ics, 'new');
    changed(list);
    reply.code(201);
    return { task: serialise(object, t, assign ? 'assigner' : null) };
  });

  app.patch('/api/v1/tasks/:id', { schema: { tags: ['tasks'], summary: 'Update, complete, move, assign or answer a task', params: IdParams, body: UpdateBody } }, async (req) => {
    const user = me(req);
    const { obj, list } = await loadTask(user, req.params.id, true);
    const { listId, assignTo, response, ...changes } = req.body as Static<typeof UpdateBody>;
    const before = parseTask(obj.ics);
    const owner = await ownerOf(list);
    const role = roleOf(before, owner.email);

    // --- The assignee: answer the request, report progress, set their own reminder. -------------
    if (role === 'assignee') {
      const details = (['title', 'notes', 'due', 'importance', 'repeat'] as const).filter((k) => changes[k] !== undefined);
      if (details.length || assignTo !== undefined) throw badRequest(`${before.assignedBy?.name || before.assignedBy?.email} assigned this task, so only they can change its details`);
      if (response === 'DECLINED') {
        await reply(user, list, setTaskResponse(obj.ics, 'DECLINED'), 'declined');
        await deleteCalendarObject(db, list.id, obj.href);
        changed(list);
        return { task: null, next: null };
      }
      let ics = obj.ics;
      const accepting = response === 'ACCEPTED' || (changes.status !== undefined && before.assignee!.response === 'NEEDS-ACTION');
      if (accepting) ics = setTaskResponse(ics, 'ACCEPTED');
      ics = buildTask({ ...(changes.status !== undefined ? { status: changes.status } : {}), ...(changes.reminder !== undefined ? { reminder: changes.reminder } : {}) }, ics);
      let target = list;
      let href = obj.href;
      if (listId && listId !== list.id) {
        target = await listFor(user, listId, true);
        if (target.ownerId !== list.ownerId || target.role) throw badRequest('Move it to another of your own lists');
        await deleteCalendarObject(db, list.id, obj.href);
        href = `${before.uid}.ics`;
      }
      const { object } = await putCalendarObject(db, target.id, href, ics);
      // Status report to the assigner, as Outlook does.
      const status = changes.status ?? before.status;
      if (changes.status !== undefined && changes.status !== before.status)
        await reply(user, list, object.ics, status === 'COMPLETED' ? 'completed' : before.status === 'COMPLETED' ? 'reopened' : status === 'IN-PROCESS' ? 'in progress' : 'accepted');
      else if (accepting) await reply(user, list, object.ics, 'accepted');
      changed(target);
      return { task: serialise(object, parseTask(object.ics), 'assignee'), next: null };
    }

    // --- The owner or assigner. -------------------------------------------------------------------
    if (role === 'assigner' && changes.status !== undefined && before.assignee!.response !== 'DECLINED')
      throw badRequest(`${before.assignee!.name || before.assignee!.email} is doing this task, so they update its progress`);
    if (changes.repeat && !(changes.due ?? before.due)) throw badRequest('Set a due date for a repeating task');
    const willBeAssigned = assignTo === undefined ? !!before.assignee : !!assignTo;
    if (willBeAssigned && (changes.repeat ?? (changes.repeat === undefined ? before.repeat : null))) throw badRequest('Assigned tasks cannot repeat');
    if (assignTo && (before.messageId || list.role === 'flagged')) throw badRequest('Flagged email cannot be assigned. Forward the email instead.');

    // Completing a repeating task: this one is done, and the next one is created (as in Outlook).
    let next: ReturnType<typeof serialise> | null = null;
    const repeat = changes.repeat === undefined ? before.repeat : changes.repeat;
    const due = changes.due === undefined ? before.due : changes.due;
    if (changes.status === 'COMPLETED' && before.status !== 'COMPLETED' && repeat && due) {
      const shift = (iso: string | null) => (iso && before.due ? new Date(new Date(iso).getTime() + (Date.parse(nextDue(due, repeat)) - Date.parse(due))).toISOString() : null);
      const nextIcs = buildTask({ title: changes.title ?? before.title, notes: changes.notes ?? before.notes, importance: changes.importance ?? before.importance, due: nextDue(due, repeat), repeat, reminder: shift(changes.reminder === undefined ? before.reminder : changes.reminder), status: 'NEEDS-ACTION' });
      const nt = parseTask(nextIcs);
      const { object } = await putCalendarObject(db, list.id, `${nt.uid}.ics`, nextIcs);
      next = serialise(object, nt, null);
      changes.repeat = null;
    }

    // Assigning, reassigning or taking a task back.
    const previous = before.assignee;
    let assign: { organizer: TaskPerson; assignee: TaskPerson } | null | undefined;
    if (assignTo !== undefined) {
      const assignee = assignTo ? await assignable(user, assignTo, owner) : null;
      if (assignee?.email !== previous?.email) assign = assignee ? { organizer: owner, assignee } : null;
    }
    if (assign !== undefined && previous && previous.response !== 'DECLINED') await cancel(user, list, obj.ics, previous.email);

    let ics = buildTask({ ...changes, ...(assign !== undefined ? { assign } : {}) }, obj.ics);
    const detailsChanged = (['title', 'notes', 'due', 'importance'] as const).some((k) => changes[k] !== undefined && changes[k] !== before[k]);
    const now = parseTask(ics);
    if (now.assignee && (assign || detailsChanged)) ics = bumpTaskSequence(ics);

    let target = list;
    let href = obj.href;
    if (listId && listId !== list.id) {
      if (before.messageId || list.role === 'flagged') throw badRequest('Flagged email stays in the Flagged email list');
      target = await listFor(user, listId, true);
      if (target.role === 'flagged') throw badRequest('Flag a message to add it to Flagged email');
      if (now.assignee && target.ownerId !== list.ownerId) throw badRequest('Assigned tasks stay in their owner’s lists');
      await deleteCalendarObject(db, list.id, obj.href);
      href = `${before.uid}.ics`;
    }
    const { object } = await putCalendarObject(db, target.id, href, ics);
    if (assign) await request(user, target, object.ics, 'new');
    else if (now.assignee && detailsChanged && now.assignee.response !== 'DECLINED') await request(user, target, object.ics, 'updated');
    await syncFlag(target, before.uid, object.ics);
    changed(target);
    return { task: serialise(object, parseTask(object.ics), now.assignee ? 'assigner' : null), next };
  });

  app.delete('/api/v1/tasks/:id', { schema: { tags: ['tasks'], summary: 'Delete a task (a flagged email is unflagged; an assigned task is cancelled or declined)', params: IdParams } }, async (req) => {
    const user = me(req);
    const { obj, list } = await loadTask(user, req.params.id, true);
    const t = parseTask(obj.ics);
    const role = roleOf(t, (await ownerOf(list)).email);
    if (role === 'assigner' && t.assignee!.response !== 'DECLINED' && t.status !== 'COMPLETED') await cancel(user, list, obj.ics, t.assignee!.email);
    if (role === 'assignee' && t.status !== 'COMPLETED') await reply(user, list, setTaskResponse(obj.ics, 'DECLINED'), 'declined');
    await deleteCalendarObject(db, list.id, obj.href);
    await syncFlag(list, obj.uid, null);
    changed(list);
    return { ok: true };
  });
}

type Actor = { id: string; orgId: string; email: string; displayName: string };

/**
 * Task assignment messages (iTIP for VTODO), shared by the REST API and the
 * CalDAV server so phone and desktop task apps take part too.
 */
export function taskScheduling(ctx: AppContext) {
  const { db } = ctx;
  /** Whose list this is: a person, or a shared mailbox. */
  const ownerOf = async (list: List): Promise<TaskPerson> => {
    const [u] = await db.select({ email: users.email, name: users.displayName }).from(users).where(eq(users.id, list.ownerId)).limit(1);
    return { email: u?.email ?? '', name: u?.name ?? '' };
  };
  const roleOf = (t: TaskInfo, ownerEmail: string): Role => (!t.assignee ? null : t.assignee.email === ownerEmail ? 'assignee' : t.assignedBy?.email === ownerEmail ? 'assigner' : null);

  /** Send as the list's owner; in a shared mailbox without "Send as", on behalf of the member. */
  const sendItip = async (user: Actor, list: List, to: string, method: 'REQUEST' | 'REPLY' | 'CANCEL', ics: string, subject: string, text: string) => {
    const owner = await ownerOf(list);
    let sender: MailAddress | undefined;
    if (list.ownerId !== user.id) {
      const grant = (await delegatedMailboxes(db, user.id)).find((d) => d.ownerId === list.ownerId);
      if (!grant?.sendAs) sender = { name: user.displayName, address: user.email };
    }
    const { raw } = await composeMessage({
      from: { name: owner.name, address: owner.email },
      sender,
      to: [{ name: '', address: to }],
      subject,
      text,
      calendar: { method, content: withMethod(ics, method) },
      headers: method === 'REPLY' ? { 'Auto-Submitted': 'auto-replied' } : undefined,
    });
    await submitMessage(ctx.mail, { userId: user.id, raw, envelopeFrom: owner.email, recipients: [to], source: 'system' });
  };

  const tasksUrl = `${ctx.config.publicUrl}/tasks?view=assigned`;
  const describe = (t: TaskInfo) => [t.due ? `Due: ${new Date(`${t.due}T12:00:00Z`).toDateString()}` : null, t.importance === 'high' ? 'Importance: high' : null, t.notes ? `\n${t.notes}` : null].filter(Boolean).join('\n');
  const request = (user: Actor, list: List, ics: string, kind: 'new' | 'updated') => {
    const t = parseTask(ics);
    const by = t.assignedBy!.name || t.assignedBy!.email;
    return sendItip(
      user,
      list,
      t.assignee!.email,
      'REQUEST',
      ics,
      `${kind === 'new' ? 'Task request' : 'Task updated'}: ${t.title}`,
      `${by} ${kind === 'new' ? 'has assigned you a task' : 'has updated a task assigned to you'}: ${t.title}\n${describe(t)}\n\nOpen Tasks to ${kind === 'new' ? 'accept or decline it' : 'see it'}: ${tasksUrl}`,
    );
  };
  const cancel = (user: Actor, list: List, ics: string, to: string) => {
    const t = parseTask(ics);
    return sendItip(user, list, to, 'CANCEL', bumpTaskSequence(ics), `Task cancelled: ${t.title}`, `${t.assignedBy?.name || t.assignedBy?.email} no longer needs you to do this task: ${t.title}`);
  };
  const reply = (user: Actor, list: List, ics: string, what: 'accepted' | 'declined' | 'completed' | 'in progress' | 'reopened') => {
    const t = parseTask(ics);
    const who = t.assignee!.name || t.assignee!.email;
    const title = { accepted: 'Task accepted', declined: 'Task declined', completed: 'Task completed', 'in progress': 'Task in progress', reopened: 'Task reopened' }[what];
    return sendItip(user, list, t.assignedBy!.email, 'REPLY', taskReply(ics), `${title}: ${t.title}`, `${who} has ${what === 'in progress' ? 'started' : what} this task: ${t.title}`);
  };

  /** An address in the organisation that can be given tasks. */
  const assignable = async (user: Actor, address: string, owner: TaskPerson): Promise<TaskPerson> => {
    const p = await resolvePrincipal(db, address);
    if (!p || p.kind !== 'user' || p.orgId !== user.orgId) throw badRequest('Tasks can be assigned to people in your organisation');
    if (p.email === owner.email) throw badRequest('This task is already yours');
    return { email: p.email, name: p.name };
  };


  /**
   * A task app changed a task over CalDAV: tell the other side, as the web app would.
   * (The assignee's progress goes to the assigner; the assigner's edits go to the assignee.)
   */
  const afterClientWrite = async (user: Actor, list: List, beforeIcs: string | null, afterIcs: string | null) => {
    const before = beforeIcs ? parseTask(beforeIcs) : null;
    const after = afterIcs ? parseTask(afterIcs) : null;
    const t = after ?? before;
    if (!t?.assignee) return;
    const owner = await ownerOf(list);
    const role = roleOf(t, owner.email);
    if (role === 'assignee') {
      if (!after) {
        if (before!.status !== 'COMPLETED') await reply(user, list, setTaskResponse(beforeIcs!, 'DECLINED'), 'declined');
      } else if (!before || after.status !== before.status) {
        await reply(user, list, after.assignee!.response === 'NEEDS-ACTION' ? setTaskResponse(afterIcs!, 'ACCEPTED') : afterIcs!, after.status === 'COMPLETED' ? 'completed' : before?.status === 'COMPLETED' ? 'reopened' : after.status === 'IN-PROCESS' ? 'in progress' : 'accepted');
      }
    } else if (role === 'assigner' && t.assignee.response !== 'DECLINED') {
      if (!after) await cancel(user, list, beforeIcs!, t.assignee.email);
      else if (!before) await request(user, list, afterIcs!, 'new');
      else if ((['title', 'notes', 'due', 'importance'] as const).some((k) => after[k] !== before[k])) await request(user, list, afterIcs!, 'updated');
    }
  };

  return { ownerOf, roleOf, request, cancel, reply, assignable, afterClientWrite };
}
