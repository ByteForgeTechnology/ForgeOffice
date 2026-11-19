import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CalendarDays, ChevronDown, Circle, CircleCheck, CircleDot, Flag, ListTodo, Mail, Menu, MoreHorizontal, Plus, Repeat, Star, Trash2, UserCheck, UserRound, X } from 'lucide-react';
import { Badge, Button, EmptyState, PageSpinner, cn, useToast } from '@forge/ui';
import { UserPicker } from '../../components/admin';
import { api, errorMessage } from '../../lib/api';
import { useSocketEvent } from '../../lib/realtime';

type Importance = 'low' | 'normal' | 'high';
type RepeatKind = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly';

interface TaskList {
  id: string;
  name: string;
  color: string;
  isDefault: boolean;
  role: 'flagged' | null;
  access: 'owner' | 'write' | 'read';
  owner: { id: string; name: string; email: string } | null;
  openCount: number;
}

interface Task {
  id: string;
  listId: string;
  uid: string;
  title: string;
  notes: string;
  due: string | null;
  reminder: string | null;
  importance: Importance;
  status: 'NEEDS-ACTION' | 'IN-PROCESS' | 'COMPLETED';
  completedAt: string | null;
  repeat: RepeatKind | null;
  createdAt: string | null;
  messageId: string | null;
  from: string | null;
  /** assigner: I assigned it (my copy); assignee: it was assigned to me. */
  role: 'assigner' | 'assignee' | null;
  assignedBy: { email: string; name: string } | null;
  assignee: { email: string; name: string; response: 'NEEDS-ACTION' | 'ACCEPTED' | 'DECLINED' } | null;
  message?: { id: string; mailboxId: string; threadId: string; flagged: boolean } | null;
}

const VIEWS = [
  { id: 'important', label: 'Important', icon: Star },
  { id: 'planned', label: 'Planned', icon: CalendarDays },
  { id: 'assigned', label: 'Assigned to me', icon: UserCheck },
  { id: 'all', label: 'All tasks', icon: ListTodo },
] as const;

type TaskChange = Partial<Omit<Task, 'assignee' | 'assignedBy' | 'role'>> & { assignTo?: string | null; response?: 'ACCEPTED' | 'DECLINED' };

const RESPONSE: Record<string, { label: string; tone: 'neutral' | 'success' | 'danger' }> = {
  'NEEDS-ACTION': { label: 'Waiting for a response', tone: 'neutral' },
  ACCEPTED: { label: 'Accepted', tone: 'success' },
  DECLINED: { label: 'Declined', tone: 'danger' },
};
/** Can this copy's progress be changed here? (The assignee reports progress on assigned tasks.) */
const canProgress = (t: Task) => t.role !== 'assigner' || t.assignee?.response === 'DECLINED';

const REPEATS: Record<RepeatKind, string> = { daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' };

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

function dueLabel(due: string) {
  if (due === today()) return 'Today';
  if (due === addDays(1)) return 'Tomorrow';
  if (due === addDays(-1)) return 'Yesterday';
  return new Date(`${due}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(due.slice(0, 4) !== today().slice(0, 4) ? { year: 'numeric' } : {}) });
}

/** datetime-local <-> ISO */
const toLocal = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : null);

/** Sort like To Do: overdue/soonest due first, then important, then newest. */
function sortTasks(a: Task, b: Task) {
  if (a.due !== b.due) return !a.due ? 1 : !b.due ? -1 : a.due.localeCompare(b.due);
  if (a.importance !== b.importance) return a.importance === 'high' ? -1 : b.importance === 'high' ? 1 : 0;
  return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
}

export function TasksPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const lists = useQuery({ queryKey: ['tasks', 'lists'], queryFn: () => api<{ items: TaskList[] }>('/api/v1/tasks/lists') });
  const defaultList = lists.data?.items.find((l) => l.isDefault);
  const listId = params.get('list');
  const view = params.get('view') as (typeof VIEWS)[number]['id'] | null;
  const current = lists.data?.items.find((l) => l.id === listId) ?? (!view ? defaultList : undefined);
  const query = current ? `listId=${current.id}` : view ? `view=${view}` : null;

  const tasks = useQuery({
    queryKey: ['tasks', 'items', query],
    queryFn: () => api<{ items: Task[] }>(`/api/v1/tasks?${query}`),
    enabled: !!query,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['tasks'] });
  };
  useSocketEvent('calendar:changed', refresh);

  const listName = (id: string) => lists.data?.items.find((l) => l.id === id)?.name ?? '';
  const writable = (id: string) => {
    const l = lists.data?.items.find((x) => x.id === id);
    return !!l && l.access !== 'read';
  };
  const canAdd = current ? current.access !== 'read' && current.role !== 'flagged' : !!defaultList && view !== 'assigned';

  const open = useMemo(() => (tasks.data?.items ?? []).filter((t) => t.status !== 'COMPLETED').sort(sortTasks), [tasks.data]);
  const done = useMemo(() => (tasks.data?.items ?? []).filter((t) => t.status === 'COMPLETED').sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '')), [tasks.data]);
  const selected = tasks.data?.items.find((t) => t.id === selectedId) ?? null;

  const update = useMutation({
    mutationFn: ({ id, ...body }: TaskChange & { id: string }) => api<{ task: Task | null; next: Task | null }>(`/api/v1/tasks/${id}`, { method: 'PATCH', body }),
    onSuccess: (r, v) => {
      if (r.next) toast.success(`Next one due ${dueLabel(r.next.due!)}`);
      if (v.assignTo) toast.success(`Task request sent to ${r.task?.assignee?.name || v.assignTo}`);
      if (v.response === 'DECLINED') {
        toast.success('Declined. The task has been removed from your list.');
        setSelectedId(null);
      }
      refresh();
      void qc.invalidateQueries({ queryKey: ['mail'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const create = useMutation({
    mutationFn: (title: string) =>
      api<{ task: Task }>('/api/v1/tasks', {
        body: { title, listId: current && current.role !== 'flagged' ? current.id : undefined, ...(view === 'important' ? { importance: 'high' } : {}), ...(view === 'planned' ? { due: today() } : {}) },
      }),
    onSuccess: () => {
      setNewTitle('');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/tasks/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setSelectedId(null);
      refresh();
      void qc.invalidateQueries({ queryKey: ['mail'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const toggle = (t: Task) => update.mutate({ id: t.id, status: t.status === 'COMPLETED' ? 'NEEDS-ACTION' : 'COMPLETED' });

  const go = (p: { list?: string; view?: string }) => {
    setParams(p.list ? { list: p.list } : p.view ? { view: p.view } : {});
    setSelectedId(null);
    setSidebarOpen(false);
  };

  if (lists.isLoading) return <PageSpinner />;
  const title = current ? current.name : (VIEWS.find((v) => v.id === view)?.label ?? 'Tasks');

  return (
    <div className="flex h-full">
      <aside className={cn('w-64 shrink-0 overflow-y-auto border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950', sidebarOpen ? 'fixed inset-y-0 left-0 z-30 block shadow-xl' : 'hidden md:block')}>
        <Sidebar lists={lists.data?.items ?? []} current={current?.id ?? null} view={current ? null : view} onPick={go} onClose={() => setSidebarOpen(false)} />
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <button type="button" className="rounded-lg p-1.5 hover:bg-zinc-100 md:hidden dark:hover:bg-zinc-800" aria-label="Lists" onClick={() => setSidebarOpen(true)}>
            <Menu className="size-5" />
          </button>
          {current && <span className="size-3 shrink-0 rounded-full" style={{ background: current.color }} />}
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">
            {title}
            {current?.owner && <span className="ml-2 text-sm font-normal text-zinc-500">{current.owner.name}</span>}
          </h1>
          {current && !current.isDefault && !current.role && current.access === 'owner' && <ListMenu list={current} onDeleted={() => go({})} />}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {current?.role === 'flagged' && <p className="mb-3 text-sm text-zinc-500">Flag an email to add it here. Unflag it, or tick it off here, to complete it.</p>}
          {canAdd && (
            <form
              className="mb-3 flex items-center gap-2 rounded-lg bg-white px-3 shadow-sm ring-1 ring-zinc-200 focus-within:ring-2 focus-within:ring-brand dark:bg-zinc-900 dark:ring-zinc-800"
              onSubmit={(e) => {
                e.preventDefault();
                if (newTitle.trim()) create.mutate(newTitle.trim());
              }}
            >
              <Plus className="size-4 text-brand" />
              <input aria-label="Add a task" className="h-11 flex-1 border-0 bg-transparent px-0 text-sm focus:ring-0" placeholder={`Add a task${!current && defaultList ? ` to ${defaultList.name}` : ''}`} value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
            </form>
          )}

          {tasks.isLoading ? (
            <PageSpinner />
          ) : !open.length && !done.length ? (
            <EmptyState icon={current?.role === 'flagged' ? <Flag /> : <ListTodo />} title={current?.role === 'flagged' ? 'No flagged email' : 'Nothing to do'} description={current?.role === 'flagged' ? undefined : view === 'assigned' ? 'Tasks other people assign to you appear here.' : 'Add a task above.'} />
          ) : (
            <>
              <ul className="space-y-1.5">
                {open.map((t) => (
                  <TaskRow key={t.id} task={t} listName={!current ? listName(t.listId) : null} selected={t.id === selectedId} canEdit={writable(t.listId)} onSelect={() => setSelectedId(t.id)} onToggle={() => toggle(t)} onImportance={() => update.mutate({ id: t.id, importance: t.importance === 'high' ? 'normal' : 'high' })} />
                ))}
              </ul>
              {done.length > 0 && (
                <div className="mt-4">
                  <button type="button" onClick={() => setShowCompleted((s) => !s)} className="mb-1.5 flex items-center gap-1 rounded px-1 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800">
                    <ChevronDown className={cn('size-4 transition-transform', !showCompleted && '-rotate-90')} /> Completed <span className="text-zinc-400">{done.length}</span>
                  </button>
                  {showCompleted && (
                    <ul className="space-y-1.5">
                      {done.map((t) => (
                        <TaskRow key={t.id} task={t} listName={!current ? listName(t.listId) : null} selected={t.id === selectedId} canEdit={writable(t.listId)} onSelect={() => setSelectedId(t.id)} onToggle={() => toggle(t)} onImportance={() => update.mutate({ id: t.id, importance: t.importance === 'high' ? 'normal' : 'high' })} />
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {selected && (
        <TaskDetail
          key={selected.id}
          task={selected}
          lists={(lists.data?.items ?? []).filter((l) => l.access !== 'read' && !l.role)}
          canEdit={writable(selected.listId)}
          onChange={(c) => update.mutate({ id: selected.id, ...c })}
          onDelete={() => remove.mutate(selected.id)}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

function Sidebar({ lists, current, view, onPick, onClose }: { lists: TaskList[]; current: string | null; view: string | null; onPick: (p: { list?: string; view?: string }) => void; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api<{ list: { id: string } }>('/api/v1/tasks/lists', { body: { name } }),
    onSuccess: (r) => {
      setAdding(false);
      setName('');
      void qc.invalidateQueries({ queryKey: ['tasks', 'lists'] });
      onPick({ list: r.list.id });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const mine = lists.filter((l) => !l.owner);
  const shared = Object.values(
    lists
      .filter((l) => l.owner)
      .reduce<Record<string, { owner: NonNullable<TaskList['owner']>; lists: TaskList[] }>>((acc, l) => {
        (acc[l.owner!.id] ??= { owner: l.owner!, lists: [] }).lists.push(l);
        return acc;
      }, {}),
  );
  const item = (active: boolean, onClick: () => void, icon: React.ReactNode, label: string, count?: number) => (
    <button
      type="button"
      onClick={onClick}
      className={cn('flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm', active ? 'bg-white font-medium text-zinc-900 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-50 dark:ring-zinc-800' : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800')}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {!!count && <span className="text-xs text-zinc-500">{count}</span>}
    </button>
  );
  const listIcon = (l: TaskList) => (l.role === 'flagged' ? <Flag className="size-4 text-red-600" /> : <span className="flex size-4 items-center justify-center"><span className="size-2.5 rounded-full" style={{ background: l.color }} /></span>);

  return (
    <nav aria-label="Task lists" className="flex flex-col gap-1 p-3">
      <div className="mb-1 flex items-center justify-between md:hidden">
        <span className="px-1 text-sm font-semibold">Lists</span>
        <button type="button" aria-label="Close" className="rounded p-1 hover:bg-zinc-200 dark:hover:bg-zinc-800" onClick={onClose}>
          <X className="size-4" />
        </button>
      </div>
      {VIEWS.map((v) => item(view === v.id, () => onPick({ view: v.id }), <v.icon className="size-4 text-zinc-500" />, v.label))}
      <div className="my-2 border-t border-zinc-200 dark:border-zinc-800" />
      {mine.map((l) => (
        <div key={l.id}>{item(current === l.id, () => onPick({ list: l.id }), listIcon(l), l.name, l.openCount)}</div>
      ))}
      {adding ? (
        <form
          className="px-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <input autoFocus aria-label="List name" className="h-9 w-full rounded-lg border-0 bg-white px-3 text-sm ring-1 ring-zinc-300 ring-inset focus:ring-2 focus:ring-brand dark:bg-zinc-900 dark:ring-zinc-700" placeholder="List name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => !name && setAdding(false)} />
        </form>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-brand hover:bg-zinc-100 dark:hover:bg-zinc-800">
          <Plus className="size-4" /> New list
        </button>
      )}
      {shared.map((g) => (
        <div key={g.owner.id} className="mt-3">
          <p className="mb-1 truncate px-3 text-xs font-semibold text-zinc-500" title={g.owner.email}>
            {g.owner.name}
          </p>
          {g.lists.map((l) => (
            <div key={l.id}>{item(current === l.id, () => onPick({ list: l.id }), listIcon(l), l.name, l.openCount)}</div>
          ))}
        </div>
      ))}
    </nav>
  );
}

function ListMenu({ list, onDeleted }: { list: TaskList; onDeleted: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setOpen(false);
    try {
      await fn();
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <div className="relative">
      <Button size="sm" variant="ghost" aria-label="List options" onClick={() => setOpen((o) => !o)}>
        <MoreHorizontal className="size-4" />
      </Button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-lg border border-zinc-200 bg-white py-1 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <button
            type="button"
            className="w-full px-3 py-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
            onClick={() => {
              const name = window.prompt('List name', list.name);
              if (name?.trim()) void run(() => api(`/api/v1/tasks/lists/${list.id}`, { method: 'PATCH', body: { name: name.trim() } }));
            }}
          >
            Rename list
          </button>
          <button
            type="button"
            className="w-full px-3 py-2 text-left text-red-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            onClick={() => {
              if (window.confirm(`Delete “${list.name}” and all its tasks?`)) void run(() => api(`/api/v1/tasks/lists/${list.id}`, { method: 'DELETE' })).then(onDeleted);
            }}
          >
            Delete list
          </button>
        </div>
      )}
    </div>
  );
}

function TaskRow({ task: t, listName, selected, canEdit, onSelect, onToggle, onImportance }: { task: Task; listName: string | null; selected: boolean; canEdit: boolean; onSelect: () => void; onToggle: () => void; onImportance: () => void }) {
  const doneTask = t.status === 'COMPLETED';
  const overdue = !doneTask && !!t.due && t.due < today();
  const firstName = (p: { name: string; email: string }) => p.name || p.email;
  const meta = [
    listName,
    t.messageId && t.from ? `From ${t.from.replace(/\s*<.*>$/, '')}` : null,
    t.role === 'assignee' && t.assignedBy ? `Assigned by ${firstName(t.assignedBy)}` : null,
    t.role === 'assigner' && t.assignee ? `Assigned to ${firstName(t.assignee)}${t.assignee.response === 'ACCEPTED' ? '' : ` · ${RESPONSE[t.assignee.response]!.label.toLowerCase()}`}` : null,
    t.status === 'IN-PROCESS' ? 'In progress' : null,
  ].filter(Boolean) as string[];
  const pending = t.role === 'assignee' && t.assignee?.response === 'NEEDS-ACTION';
  return (
    <li
      className={cn(
        'group flex cursor-pointer items-center gap-3 rounded-lg bg-white px-3 py-2.5 shadow-sm ring-1 ring-zinc-200 hover:bg-zinc-50 dark:bg-zinc-900 dark:ring-zinc-800 dark:hover:bg-zinc-800/60',
        selected && 'ring-2 ring-brand dark:ring-brand',
      )}
      onClick={onSelect}
    >
      <button
        type="button"
        aria-label={doneTask ? `Mark “${t.title}” as not completed` : `Complete “${t.title}”`}
        title={!canProgress(t) ? `${t.assignee?.name || t.assignee?.email} updates the progress of this task` : undefined}
        disabled={!canEdit || !canProgress(t)}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className="shrink-0 text-zinc-400 hover:text-brand disabled:opacity-50"
      >
        {doneTask ? <CircleCheck className="size-5 text-brand" /> : t.status === 'IN-PROCESS' ? <CircleDot className="size-5" /> : <Circle className="size-5" />}
      </button>
      <div className="min-w-0 flex-1">
        <p className={cn('flex items-center gap-2 truncate text-sm', doneTask && 'text-zinc-500 line-through')}>
          <span className="truncate">{t.title}</span>
          {pending && <Badge tone="info">New request</Badge>}
        </p>
        {(meta.length > 0 || t.due || t.reminder || t.repeat || t.notes || t.messageId) && (
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-500">
            {t.messageId && <Mail className="size-3" aria-label="Flagged email" />}
            {t.role && <UserRound className="size-3" aria-hidden />}
            {meta.map((m) => (
              <span key={m}>{m}</span>
            ))}
            {t.due && (
              <span className={cn('inline-flex items-center gap-1', overdue && 'text-red-600')}>
                <CalendarDays className="size-3" /> {overdue ? `Overdue, ${dueLabel(t.due)}` : dueLabel(t.due)}
              </span>
            )}
            {t.reminder && !doneTask && <Bell className="size-3" aria-label="Reminder" />}
            {t.repeat && <Repeat className="size-3" aria-label="Repeats" />}
          </p>
        )}
      </div>
      <button
        type="button"
        aria-label={t.importance === 'high' ? 'Remove importance' : 'Mark as important'}
        disabled={!canEdit || t.role === 'assignee'}
        onClick={(e) => {
          e.stopPropagation();
          onImportance();
        }}
        className="shrink-0 text-zinc-400 hover:text-amber-500 disabled:opacity-50"
      >
        <Star className={cn('size-4', t.importance === 'high' && 'fill-amber-400 text-amber-500')} />
      </button>
    </li>
  );
}

function TaskDetail({ task, lists, canEdit, onChange, onDelete, onClose }: { task: Task; lists: TaskList[]; canEdit: boolean; onChange: (c: TaskChange) => void; onDelete: () => void; onClose: () => void }) {
  const navigate = useNavigate();
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes);
  useEffect(() => setTitle(task.title), [task.title]);
  useEffect(() => setNotes(task.notes), [task.notes]);
  const doneTask = task.status === 'COMPLETED';
  // Assigned tasks: the assigner owns the details, the assignee owns the progress.
  const editDetails = canEdit && task.role !== 'assignee';
  const editProgress = canEdit && canProgress(task);
  const [picking, setPicking] = useState(false);
  const assignable = canEdit && !task.messageId && task.role !== 'assignee' && !task.repeat;
  const field = 'h-9 w-full rounded-lg border-0 bg-white px-3 text-sm ring-1 ring-zinc-300 ring-inset focus:ring-2 focus:ring-brand disabled:opacity-60 dark:bg-zinc-900 dark:ring-zinc-700';

  return (
    <aside aria-label="Task details" className="fixed inset-0 z-30 flex w-full flex-col border-l border-zinc-200 bg-zinc-50 md:static md:z-auto md:w-96 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-end gap-1 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <button type="button" aria-label="Close details" onClick={onClose} className="rounded p-1.5 hover:bg-zinc-200 dark:hover:bg-zinc-800">
          <X className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div className="flex items-start gap-3 rounded-lg bg-white p-3 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
          <button type="button" disabled={!editProgress} aria-label={doneTask ? 'Mark as not completed' : 'Complete'} onClick={() => onChange({ status: doneTask ? 'NEEDS-ACTION' : 'COMPLETED' })} className="mt-1 text-zinc-400 hover:text-brand disabled:opacity-50">
            {doneTask ? <CircleCheck className="size-5 text-brand" /> : task.status === 'IN-PROCESS' ? <CircleDot className="size-5" /> : <Circle className="size-5" />}
          </button>
          <textarea
            aria-label="Title"
            rows={2}
            disabled={!editDetails}
            className={cn('flex-1 resize-none border-0 bg-transparent p-0 text-base font-medium focus:ring-0', doneTask && 'text-zinc-500 line-through')}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title.trim() && title !== task.title && onChange({ title: title.trim() })}
          />
          <button type="button" disabled={!editDetails} aria-label="Important" onClick={() => onChange({ importance: task.importance === 'high' ? 'normal' : 'high' })} className="mt-1 text-zinc-400 hover:text-amber-500">
            <Star className={cn('size-4', task.importance === 'high' && 'fill-amber-400 text-amber-500')} />
          </button>
        </div>

        {task.role === 'assignee' && task.assignedBy && (
          <div className="rounded-lg bg-white p-3 text-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
            <p className="flex items-center gap-2 font-medium">
              <UserCheck className="size-4 text-brand" /> Assigned to you by {task.assignedBy.name || task.assignedBy.email}
            </p>
            {task.assignee?.response === 'NEEDS-ACTION' ? (
              <>
                <p className="mt-1 text-zinc-500">Accept to take it on. Your progress is reported back automatically.</p>
                {canEdit && (
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" variant="primary" onClick={() => onChange({ response: 'ACCEPTED' })}>
                      Accept
                    </Button>
                    <Button size="sm" onClick={() => window.confirm('Decline this task? It will be removed from your list and the sender told.') && onChange({ response: 'DECLINED' })}>
                      Decline
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <p className="mt-1 text-zinc-500">They'll be told when you start or finish it. Only they can change its details.</p>
            )}
          </div>
        )}

        {(task.role === 'assigner' || assignable) && (
          <div className="rounded-lg bg-white p-3 text-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
            <p className="mb-2 flex items-center gap-2 font-medium">
              <UserRound className="size-4" /> Assigned to
            </p>
            {task.assignee ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 truncate" title={task.assignee.email}>
                  {task.assignee.name || task.assignee.email}
                </span>
                <Badge tone={RESPONSE[task.assignee.response]!.tone}>{RESPONSE[task.assignee.response]!.label}</Badge>
              </div>
            ) : (
              <p className="text-zinc-500">Only you</p>
            )}
            {task.role === 'assigner' && task.assignee?.response !== 'DECLINED' && <p className="mt-1 text-xs text-zinc-500">They update its progress; your copy follows along.</p>}
            {canEdit && !task.messageId && (
              <div className="mt-2 space-y-2">
                {picking ? (
                  <div>
                    <UserPicker
                      onPick={(u) => {
                        setPicking(false);
                        onChange({ assignTo: u.email });
                      }}
                    />
                    <Button size="sm" variant="ghost" className="mt-1" onClick={() => setPicking(false)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {assignable && (
                      <Button size="sm" onClick={() => setPicking(true)}>
                        {task.assignee ? 'Reassign' : 'Assign to someone'}
                      </Button>
                    )}
                    {task.assignee && (
                      <Button size="sm" variant="ghost" onClick={() => window.confirm(`Take this task back from ${task.assignee!.name || task.assignee!.email}? Their copy will be cancelled.`) && onChange({ assignTo: null })}>
                        Take back
                      </Button>
                    )}
                  </div>
                )}
                {!task.assignee && task.repeat && <p className="text-xs text-zinc-500">Repeating tasks can't be assigned.</p>}
              </div>
            )}
          </div>
        )}

        {task.messageId && (
          <div className="rounded-lg bg-white p-3 text-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
            <p className="flex items-center gap-2 font-medium">
              <Flag className={cn('size-4', task.message?.flagged ? 'text-red-600' : 'text-zinc-400')} /> Flagged email
            </p>
            {task.from && <p className="mt-1 truncate text-zinc-500">From {task.from}</p>}
            {task.message ? (
              <Button size="sm" className="mt-2" icon={<Mail className="size-4" />} onClick={() => navigate(`/mail?message=${task.message!.id}`)}>
                Open email
              </Button>
            ) : (
              <p className="mt-1 text-xs text-zinc-500">The email is no longer available.</p>
            )}
          </div>
        )}

        <div className="space-y-3 rounded-lg bg-white p-3 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
          <label className="block text-sm">
            <span className="mb-1 flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
              <CircleDot className="size-4" /> Status
            </span>
            <select disabled={!editProgress} className={field} value={task.status} onChange={(e) => onChange({ status: e.target.value as Task['status'] })}>
              <option value="NEEDS-ACTION">Not started</option>
              <option value="IN-PROCESS">In progress</option>
              <option value="COMPLETED">Completed</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
              <CalendarDays className="size-4" /> Due
            </span>
            <div className="flex gap-2">
              <input type="date" disabled={!editDetails} className={field} value={task.due ?? ''} onChange={(e) => onChange({ due: e.target.value || null, ...(!e.target.value && task.repeat ? { repeat: null } : {}) })} />
              {task.due && editDetails && (
                <Button size="sm" variant="ghost" aria-label="Remove due date" onClick={() => onChange({ due: null, repeat: null })}>
                  <X className="size-4" />
                </Button>
              )}
            </div>
            {editDetails && !task.due && (
              <span className="mt-1.5 flex gap-1">
                {[
                  ['Today', 0],
                  ['Tomorrow', 1],
                  ['Next week', 7],
                ].map(([label, n]) => (
                  <button key={label} type="button" className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700" onClick={() => onChange({ due: addDays(n as number) })}>
                    {label}
                  </button>
                ))}
              </span>
            )}
          </label>
          <label className="block text-sm">
            <span className="mb-1 flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
              <Bell className="size-4" /> Remind me
            </span>
            <input type="datetime-local" disabled={!canEdit} className={field} value={toLocal(task.reminder)} onChange={(e) => onChange({ reminder: fromLocal(e.target.value) })} />
            <span className="mt-1 block text-xs text-zinc-500">Reminders pop up on phones and in desktop apps that sync your tasks.</span>
          </label>
          <label className="block text-sm">
            <span className="mb-1 flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
              <Repeat className="size-4" /> Repeat
            </span>
            <select disabled={!editDetails || !!task.messageId || !!task.assignee} className={field} value={task.repeat ?? ''} onChange={(e) => onChange({ repeat: (e.target.value || null) as RepeatKind | null, ...(e.target.value && !task.due ? { due: today() } : {}) })}>
              <option value="">Doesn't repeat</option>
              {Object.entries(REPEATS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          {!task.messageId && lists.length > 1 && (
            <label className="block text-sm">
              <span className="mb-1 flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
                <ListTodo className="size-4" /> List
              </span>
              <select disabled={!canEdit} className={field} value={task.listId} onChange={(e) => onChange({ listId: e.target.value })}>
                {lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.owner ? `${l.owner.name}: ${l.name}` : l.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <label className="block">
          <span className="sr-only">Notes</span>
          <textarea
            rows={6}
            disabled={!editDetails}
            placeholder="Add a note"
            className="w-full rounded-lg border-0 bg-white px-3 py-2 text-sm ring-1 ring-zinc-200 ring-inset focus:ring-2 focus:ring-brand dark:bg-zinc-900 dark:ring-zinc-800"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => notes !== task.notes && onChange({ notes })}
          />
        </label>
      </div>
      <footer className="flex items-center justify-between border-t border-zinc-200 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800">
        <span>{doneTask && task.completedAt ? `Completed ${new Date(task.completedAt).toLocaleString()}` : task.createdAt ? `Created ${new Date(task.createdAt).toLocaleDateString()}` : ''}</span>
        {canEdit && (
          <Button
            size="sm"
            variant="ghost"
            aria-label="Delete task"
            onClick={() => {
              const msg = task.messageId
                ? 'Delete this task? The email will be unflagged.'
                : task.role === 'assigner' && task.assignee?.response !== 'DECLINED' && !doneTask
                  ? `Delete this task? ${task.assignee!.name || task.assignee!.email} will be told it's cancelled.`
                  : task.role === 'assignee' && !doneTask
                    ? `Delete this task? ${task.assignedBy?.name || task.assignedBy?.email} will be told you declined it.`
                    : 'Delete this task?';
              if (window.confirm(msg)) onDelete();
            }}
          >
            <Trash2 className="size-4" />
          </Button>
        )}
      </footer>
    </aside>
  );
}
