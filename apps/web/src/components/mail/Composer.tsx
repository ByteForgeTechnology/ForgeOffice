import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { richTextExtensions } from '../../lib/editor';
import { Bold, Clock, Italic, Link2, List, ListOrdered, Maximize2, Minimize2, Paperclip, Quote, Send, Strikethrough, Trash2, Underline, X } from 'lucide-react';
import { Button, cn, formatBytes, useToast } from '@forge/ui';
import { ApiError, api, errorMessage } from '../../lib/api';
import { getAccessToken } from '../../lib/auth';
import { useDebounced } from '../../lib/hooks';
import type { Addr, ComposeState, Upload } from '../../lib/mail-types';

const ADDRESS_RE = /^[^\s@<>()",;:]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

function parseTyped(text: string): Addr | null {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(text);
  const address = (m ? m[2]! : text).trim().toLowerCase();
  return ADDRESS_RE.test(address) ? { name: m ? m[1]!.trim() : '', address } : null;
}

export function RecipientInput({ label, value, onChange, autoFocus }: { label: string; value: Addr[]; onChange: (v: Addr[]) => void; autoFocus?: boolean }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const term = useDebounced(text.trim(), 150);
  const { data } = useQuery({
    queryKey: ['mail', 'suggest', term],
    queryFn: () => api<{ items: (Addr & { kind: string })[] }>(`/api/v1/mail/suggest?q=${encodeURIComponent(term)}`),
    enabled: term.length >= 1,
  });
  const suggestions = (data?.items ?? []).filter((s) => !value.some((v) => v.address === s.address));

  const add = (a: Addr) => {
    if (!value.some((v) => v.address === a.address)) onChange([...value, a]);
    setText('');
    setActive(0);
  };
  const commit = () => {
    const parts = text.split(/[,;]/).map(parseTyped);
    const valid = parts.filter((p): p is Addr => !!p);
    if (valid.length && valid.length === parts.length) {
      onChange([...value, ...valid.filter((a) => !value.some((v) => v.address === a.address))]);
      setText('');
      return true;
    }
    return false;
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === 'Tab') && open && suggestions[active] && text) {
      e.preventDefault();
      add(suggestions[active]!);
    } else if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      if (text.trim()) {
        e.preventDefault();
        commit();
      }
    } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
    else if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, suggestions.length - 1));
    else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
  };

  return (
    <div className="relative flex min-h-10 flex-wrap items-center gap-1 border-b border-zinc-200 px-3 py-1 dark:border-zinc-800">
      <span className="w-10 shrink-0 text-sm text-zinc-500">{label}</span>
      {value.map((a) => (
        <span key={a.address} className="inline-flex items-center gap-1 rounded-full bg-zinc-100 py-0.5 pr-1 pl-2.5 text-sm dark:bg-zinc-800" title={a.address}>
          {a.name || a.address}
          <button type="button" aria-label={`Remove ${a.address}`} className="rounded-full p-0.5 hover:bg-zinc-200 dark:hover:bg-zinc-700" onClick={() => onChange(value.filter((v) => v !== a))}>
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        aria-label={label}
        autoFocus={autoFocus}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onKeyDown={onKey}
        onBlur={() => {
          setTimeout(() => setOpen(false), 150);
          commit();
        }}
        className="min-w-32 flex-1 border-0 bg-transparent py-1 text-sm focus:ring-0"
      />
      {open && term && suggestions.length > 0 && (
        <ul className="absolute top-full left-12 z-20 mt-1 w-80 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          {suggestions.map((s, i) => (
            <li key={s.address}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(s);
                }}
                className={cn('flex w-full flex-col px-3 py-2 text-left text-sm', i === active ? 'bg-zinc-100 dark:bg-zinc-800' : '')}
              >
                <span className="font-medium">{s.name || s.address}</span>
                <span className="text-xs text-zinc-500">
                  {s.address}
                  {s.kind === 'group' ? ' · list' : s.kind === 'recent' ? ' · recent' : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor | null }) {
  if (!editor) return null;
  const btn = (active: boolean, label: string, onClick: () => void, Icon: typeof Bold) => (
    <button type="button" title={label} aria-label={label} aria-pressed={active} onClick={onClick} className={cn('rounded p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800', active && 'bg-zinc-200 dark:bg-zinc-700')}>
      <Icon className="size-4" />
    </button>
  );
  return (
    <div className="flex flex-wrap gap-0.5 border-b border-zinc-200 px-2 py-1 dark:border-zinc-800">
      {btn(editor.isActive('bold'), 'Bold', () => editor.chain().focus().toggleBold().run(), Bold)}
      {btn(editor.isActive('italic'), 'Italic', () => editor.chain().focus().toggleItalic().run(), Italic)}
      {btn(editor.isActive('underline'), 'Underline', () => editor.chain().focus().toggleUnderline().run(), Underline)}
      {btn(editor.isActive('strike'), 'Strikethrough', () => editor.chain().focus().toggleStrike().run(), Strikethrough)}
      {btn(editor.isActive('bulletList'), 'Bulleted list', () => editor.chain().focus().toggleBulletList().run(), List)}
      {btn(editor.isActive('orderedList'), 'Numbered list', () => editor.chain().focus().toggleOrderedList().run(), ListOrdered)}
      {btn(editor.isActive('blockquote'), 'Quote', () => editor.chain().focus().toggleBlockquote().run(), Quote)}
      {btn(editor.isActive('link'), 'Link', () => {
        if (editor.isActive('link')) return editor.chain().focus().unsetLink().run();
        const url = window.prompt('Link address');
        if (url) editor.chain().focus().extendMarkRange('link').setLink({ href: /^(https?:|mailto:)/i.test(url) ? url : `https://${url}` }).run();
      }, Link2)}
    </div>
  );
}

async function uploadFile(file: File): Promise<Upload> {
  const token = await getAccessToken();
  const res = await fetch('/api/v1/mail/uploads', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name), 'x-content-type': file.type || 'application/octet-stream' },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.message ?? 'Upload failed');
  return data.upload;
}

export function Composer({
  initial,
  identities,
  onBehalfOf = [],
  headers,
  undoSeconds,
  onClose,
}: {
  initial: ComposeState;
  identities: string[];
  onBehalfOf?: string[];
  /** Selects the shared mailbox the message is composed from (drafts, replies). */
  headers?: Record<string, string>;
  undoSeconds: number;
  onClose: () => void;
}) {
  const fromOptions = [...identities.map((i) => ({ value: i, label: i })), ...onBehalfOf.map((i) => ({ value: i, label: `${i} (on behalf)` }))];
  const qc = useQueryClient();
  const toast = useToast();
  const [state, setState] = useState<ComposeState>(initial);
  const [showCc, setShowCc] = useState(initial.cc.length > 0 || initial.bcc.length > 0);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState('');
  const [maximised, setMaximised] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirty = useRef(false);

  const editor = useEditor({
    extensions: richTextExtensions('Write your message…'),
    content: initial.html,
    editorProps: { attributes: { class: 'forge-editor min-h-48 px-4 py-3 text-sm focus:outline-none' } },
    onUpdate: () => (dirty.current = true),
  });

  // The organisation signature goes in fresh messages (not reopened drafts), above any quoted text.
  const signature = useQuery({
    queryKey: ['mail', 'signature'],
    queryFn: () => api<{ signature: { html: string; useForNew: boolean; useForReplies: boolean } | null }>('/api/v1/mail/signature'),
    staleTime: 5 * 60_000,
    enabled: !initial.draftId,
  });
  const signed = useRef(false);
  useEffect(() => {
    const sig = signature.data?.signature;
    if (!editor || signed.current || !sig || initial.draftId) return;
    if (dirty.current) return; // never overwrite what the person already typed
    signed.current = true;
    const isReply = !!(initial.replyToMessageId || initial.forwardMessageId);
    if (isReply ? !sig.useForReplies : !sig.useForNew) return;
    const rest = initial.html.replace(/^<p><\/p>/, '');
    editor.commands.setContent(`<p></p>${sig.html}${rest}`, { emitUpdate: false });
    editor.commands.focus('start');
  }, [editor, signature.data, initial]);

  const set = <K extends keyof ComposeState>(k: K, v: ComposeState[K]) => {
    dirty.current = true;
    setState((s) => ({ ...s, [k]: v }));
  };

  const payload = () => ({
    from: state.from,
    to: state.to,
    cc: state.cc,
    bcc: state.bcc,
    subject: state.subject,
    html: editor?.getHTML() ?? '',
    attachmentIds: state.attachments.map((a) => a.id),
    replyToMessageId: state.replyToMessageId,
    forwardMessageId: state.forwardMessageId,
    draftId: state.draftId,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['mail'] });

  const send = async (sendAt?: string) => {
    if (!state.to.length && !state.cc.length && !state.bcc.length) return toast.error('Add at least one recipient');
    if (uploading) return toast.error('Wait for attachments to finish uploading');
    setBusy(true);
    try {
      const res = await api<{ outbound: { id: string; undoable: boolean; sendAt: string } }>('/api/v1/mail/send', { body: { ...payload(), ...(sendAt ? { sendAt } : {}) }, headers });
      dirty.current = false;
      onClose();
      void invalidate();
      const undo = async () => {
        try {
          const r = await api<{ draftMessageId: string | null }>(`/api/v1/mail/outbound/${res.outbound.id}/cancel`, { body: {} });
          toast.success(sendAt ? 'Scheduled message cancelled and moved to Drafts' : 'Sending undone — the message is in Drafts');
          void invalidate();
          void r;
        } catch (err) {
          toast.error(errorMessage(err));
        }
      };
      if (sendAt) toast.success(<span>Scheduled for {new Date(sendAt).toLocaleString()} <button className="ml-2 font-medium underline" onClick={undo}>Cancel</button></span>);
      else if (undoSeconds > 0) toast.success(<span>Sending… <button className="ml-2 font-medium underline" onClick={undo}>Undo</button></span>);
      else toast.success('Message sent');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const close = async () => {
    const empty = !state.to.length && !state.subject && !(editor?.getText().trim()) && !state.attachments.length;
    if (dirty.current && !empty) {
      try {
        await api('/api/v1/mail/drafts', { method: 'PUT', body: payload(), headers });
        toast.success('Draft saved');
        void invalidate();
      } catch (err) {
        toast.error(errorMessage(err));
        return;
      }
    }
    onClose();
  };

  const discard = async () => {
    if (state.draftId) await api('/api/v1/mail/messages/actions', { body: { ids: [state.draftId], action: 'delete' }, headers }).catch(() => {});
    void invalidate();
    onClose();
  };

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      setUploading((n) => n + 1);
      try {
        const up = await uploadFile(file);
        setState((s) => ({ ...s, attachments: [...s.attachments, up] }));
        dirty.current = true;
      } catch (err) {
        toast.error(`${file.name}: ${errorMessage(err)}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void send();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div
      role="dialog"
      aria-label="New message"
      className={cn(
        'fixed z-40 flex flex-col overflow-hidden border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900',
        maximised ? 'inset-4 rounded-xl' : 'inset-0 sm:inset-auto sm:right-6 sm:bottom-0 sm:h-[min(640px,85vh)] sm:w-[min(640px,calc(100vw-3rem))] sm:rounded-t-xl',
      )}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void addFiles(e.dataTransfer.files);
      }}
    >
      <header className="flex items-center gap-2 bg-zinc-800 px-4 py-2 text-sm font-medium text-white dark:bg-zinc-950">
        <span className="flex-1 truncate">{state.subject || 'New message'}</span>
        <button type="button" className="hidden rounded p-1 hover:bg-white/10 sm:block" aria-label={maximised ? 'Restore' : 'Maximise'} onClick={() => setMaximised((m) => !m)}>
          {maximised ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </button>
        <button type="button" className="rounded p-1 hover:bg-white/10" aria-label="Save and close" onClick={() => void close()}>
          <X className="size-4" />
        </button>
      </header>
      {fromOptions.length > 1 && (
        <div className="flex items-center border-b border-zinc-200 px-3 py-1 dark:border-zinc-800">
          <span className="w-10 text-sm text-zinc-500">From</span>
          <select value={state.from ?? identities[0]} onChange={(e) => set('from', e.target.value)} className="border-0 bg-transparent text-sm focus:ring-0">
            {fromOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="relative">
        <RecipientInput label="To" value={state.to} onChange={(v) => set('to', v)} autoFocus={!initial.to.length} />
        {!showCc && (
          <button type="button" className="absolute top-2.5 right-3 text-xs text-zinc-500 hover:text-zinc-800" onClick={() => setShowCc(true)}>
            Cc/Bcc
          </button>
        )}
      </div>
      {showCc && <RecipientInput label="Cc" value={state.cc} onChange={(v) => set('cc', v)} />}
      {showCc && <RecipientInput label="Bcc" value={state.bcc} onChange={(v) => set('bcc', v)} />}
      <input
        aria-label="Subject"
        placeholder="Subject"
        value={state.subject}
        onChange={(e) => set('subject', e.target.value)}
        className="border-0 border-b border-zinc-200 bg-transparent px-4 py-2 text-sm focus:ring-0 dark:border-zinc-800"
      />
      <Toolbar editor={editor} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <EditorContent editor={editor} />
      </div>
      {(state.attachments.length > 0 || uploading > 0) && (
        <ul className="flex flex-wrap gap-2 border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
          {state.attachments.map((a) => (
            <li key={a.id} className="flex items-center gap-2 rounded-lg bg-zinc-100 px-2 py-1 text-xs dark:bg-zinc-800">
              <Paperclip className="size-3" /> {a.filename} <span className="text-zinc-500">{formatBytes(a.size)}</span>
              <button type="button" aria-label={`Remove ${a.filename}`} onClick={() => set('attachments', state.attachments.filter((x) => x.id !== a.id))}>
                <X className="size-3" />
              </button>
            </li>
          ))}
          {uploading > 0 && <li className="text-xs text-zinc-500">Uploading {uploading}…</li>}
        </ul>
      )}
      <footer className="relative flex items-center gap-2 border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <Button variant="primary" icon={<Send className="size-4" />} loading={busy} onClick={() => void send()} title="Send (Ctrl+Enter)">
          Send
        </Button>
        <Button variant="ghost" size="sm" icon={<Clock className="size-4" />} onClick={() => setScheduleOpen((o) => !o)}>
          <span className="hidden sm:inline">Schedule</span>
        </Button>
        <Button variant="ghost" size="sm" icon={<Paperclip className="size-4" />} onClick={() => fileRef.current?.click()}>
          <span className="hidden sm:inline">Attach</span>
        </Button>
        <input ref={fileRef} type="file" multiple className="sr-only" onChange={(e) => void addFiles(e.target.files)} />
        <span className="flex-1" />
        <Button variant="ghost" size="sm" aria-label="Discard" icon={<Trash2 className="size-4" />} onClick={() => void discard()} />
        {scheduleOpen && (
          <div className="absolute bottom-14 left-3 z-10 w-72 space-y-2 rounded-lg border border-zinc-200 bg-white p-3 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
            <p className="text-sm font-medium">Send later</p>
            {[
              { label: 'Tomorrow morning', at: () => tomorrowAt(8) },
              { label: 'Tomorrow afternoon', at: () => tomorrowAt(13) },
              { label: 'Monday morning', at: () => nextMondayAt(8) },
            ].map((o) => (
              <button key={o.label} type="button" className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={() => void send(o.at().toISOString())}>
                {o.label} <span className="text-xs text-zinc-500">{o.at().toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>
              </button>
            ))}
            <input type="datetime-local" aria-label="Custom send time" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} className="w-full rounded-md border-zinc-300 text-sm dark:border-zinc-700 dark:bg-zinc-800" />
            <Button size="sm" variant="primary" className="w-full" disabled={!scheduleAt || new Date(scheduleAt) <= new Date()} onClick={() => void send(new Date(scheduleAt).toISOString())}>
              Schedule send
            </Button>
          </div>
        )}
      </footer>
    </div>
  );
}

function tomorrowAt(hour: number) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function nextMondayAt(hour: number) {
  const d = new Date();
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  d.setHours(hour, 0, 0, 0);
  return d;
}
