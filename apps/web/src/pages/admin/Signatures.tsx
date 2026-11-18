import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EditorContent, Extension, useEditor, type Editor } from '@tiptap/react';
import { Plugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Bold,
  Braces,
  Eraser,
  ImagePlus,
  Italic,
  Link2,
  Minus,
  Plus,
  Redo2,
  Signature,
  Strikethrough,
  Table2,
  Trash2,
  Underline,
  Undo2,
  X,
} from 'lucide-react';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog, EmptyState, Field, Input, PageHeader, PageSpinner, Select, Switch, Table, Td, Th, cn, useToast } from '@forge/ui';
import { ConfirmDialog, UserPicker } from '../../components/admin';
import { api, errorMessage } from '../../lib/api';
import { richTextExtensions } from '../../lib/editor';
import { useCan, useDebounced } from '../../lib/hooks';
import type { Group } from '../../lib/types';

interface SignatureRow {
  id: string;
  name: string;
  html: string;
  enabled: boolean;
  priority: number;
  audience: 'all' | 'groups';
  groupIds: string[];
  useForNew: boolean;
  useForReplies: boolean;
  applyToApps: boolean;
}
interface Variable {
  key: string;
  label: string;
}
type Draft = Omit<SignatureRow, 'id' | 'priority'>;

const FONTS = ['Arial', 'Helvetica', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Georgia', 'Times New Roman', 'Courier New'];
const SIZES = ['10px', '11px', '12px', '13px', '14px', '16px', '18px', '20px', '24px'];
const SWATCHES = ['#18181b', '#52525b', '#a1a1aa', '#4f46e5', '#2563eb', '#0891b2', '#059669', '#ca8a04', '#ea580c', '#dc2626', '#db2777'];

/** Starting points; admins can change everything afterwards. */
const TEMPLATES: { name: string; html: string }[] = [
  {
    name: 'Simple',
    html: '<p><span style="font-family: Arial; font-size: 14px"><strong>{{displayName}}</strong></span><br><span style="font-family: Arial; font-size: 13px; color: #52525b">{{jobTitle}} · {{company}}</span></p><p><span style="font-family: Arial; font-size: 12px; color: #52525b">T: <a href="tel:{{workPhone}}">{{workPhone}}</a> | M: <a href="tel:{{mobilePhone}}">{{mobilePhone}}</a><br><a href="mailto:{{email}}">{{email}}</a> | <a href="{{website}}">{{website}}</a></span></p>',
  },
  {
    name: 'Logo on the left',
    html: '<table><tbody><tr><td><p>Add your logo here</p></td><td><p><span style="font-family: Arial; font-size: 14px"><strong>{{displayName}}</strong></span> <span style="font-family: Arial; font-size: 12px; color: #a1a1aa">{{pronouns}}</span><br><span style="font-family: Arial; font-size: 13px; color: #4f46e5">{{jobTitle}}</span><br><span style="font-family: Arial; font-size: 12px; color: #52525b">{{department}} · {{company}}</span></p><p><span style="font-family: Arial; font-size: 12px; color: #52525b">T: {{workPhone}}<br>M: {{mobilePhone}}<br><a href="{{website}}">{{website}}</a></span></p></td></tr></tbody></table>',
  },
  {
    name: 'Full address',
    html: '<p><strong>{{displayName}}</strong><br>{{jobTitle}}, {{department}}</p><p>{{company}}<br>{{streetAddress}}<br>{{city}} {{postalCode}}<br>{{country}}</p><p>Phone: {{workPhone}}<br>Mobile: {{mobilePhone}}<br>Web: <a href="{{website}}">{{website}}</a></p>',
  },
];

const EMPTY: Draft = { name: '', html: TEMPLATES[0]!.html, enabled: true, audience: 'all', groupIds: [], useForNew: true, useForReplies: true, applyToApps: false };

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function SignaturesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const canManage = useCan('org:manage');
  const [deleting, setDeleting] = useState<SignatureRow | null>(null);
  const list = useQuery({ queryKey: ['admin', 'signatures'], queryFn: () => api<{ items: SignatureRow[]; variables: Variable[] }>('/api/v1/admin/signatures') });
  const groups = useQuery({ queryKey: ['admin', 'groups', 'all'], queryFn: () => api<{ items: Group[] }>('/api/v1/admin/groups') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'signatures'] });
  const toggle = useMutation({
    mutationFn: (s: SignatureRow) => api(`/api/v1/admin/signatures/${s.id}`, { method: 'PUT', body: toBody({ ...s, enabled: !s.enabled }) }),
    onSuccess: () => void refresh(),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const reorder = useMutation({ mutationFn: (ids: string[]) => api('/api/v1/admin/signatures/order', { body: { ids } }), onSuccess: () => void refresh() });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/admin/signatures/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeleting(null);
      void refresh();
    },
  });
  const items = list.data?.items ?? [];
  const move = (i: number, d: -1 | 1) => {
    const ids = items.map((s) => s.id);
    [ids[i], ids[i + d]] = [ids[i + d]!, ids[i]!];
    reorder.mutate(ids);
  };
  const groupNames = (ids: string[]) => ids.map((id) => groups.data?.items.find((g) => g.id === id)?.name ?? 'unknown group').join(', ');

  return (
    <div>
      <PageHeader
        title="Email signatures"
        description="Design signatures once and apply them to everyone. Variables such as {{displayName}} are filled from each person's contact details. When several apply to someone, the first one in this list is used."
        actions={
          canManage && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => navigate('/admin/signatures/new')}>
              New signature
            </Button>
          )
        }
      />
      <Card>
        {list.isLoading ? (
          <PageSpinner />
        ) : !items.length ? (
          <EmptyState icon={<Signature />} title="No signatures yet" description="Create one to give every message a consistent, branded sign-off." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th className="w-16">Order</Th>
                <Th>Signature</Th>
                <Th>On</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {items.map((s, i) => (
                <tr key={s.id} className={s.enabled ? '' : 'opacity-60'}>
                  <Td>
                    <span className="flex items-center gap-1">
                      <span className="w-4 text-xs text-zinc-500">{i + 1}</span>
                      {canManage && (
                        <>
                          <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)} className="rounded p-0.5 hover:bg-zinc-100 disabled:opacity-30 dark:hover:bg-zinc-800">
                            <ArrowUp className="size-3.5" />
                          </button>
                          <button type="button" aria-label="Move down" disabled={i === items.length - 1} onClick={() => move(i, 1)} className="rounded p-0.5 hover:bg-zinc-100 disabled:opacity-30 dark:hover:bg-zinc-800">
                            <ArrowDown className="size-3.5" />
                          </button>
                        </>
                      )}
                    </span>
                  </Td>
                  <Td>
                    <Link to={`/admin/signatures/${s.id}`} className="font-medium text-zinc-900 hover:underline dark:text-zinc-100">
                      {s.name}
                    </Link>
                    <span className="mt-1 flex flex-wrap gap-1.5">
                      <Badge>{s.audience === 'all' ? 'Everyone' : groupNames(s.groupIds)}</Badge>
                      {s.useForNew && <Badge tone="info">New messages</Badge>}
                      {s.useForReplies && <Badge tone="info">Replies & forwards</Badge>}
                      {s.applyToApps && <Badge tone="brand">Desktop & phone apps</Badge>}
                    </span>
                  </Td>
                  <Td>
                    <Switch label={<span className="sr-only">Enabled</span>} checked={s.enabled} disabled={!canManage} onChange={() => toggle.mutate(s)} />
                  </Td>
                  <Td className="text-right">
                    {canManage && (
                      <Button size="sm" variant="ghost" aria-label={`Delete ${s.name}`} onClick={() => setDeleting(s)}>
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={() => deleting && remove.mutate(deleting.id)} title={`Delete “${deleting?.name}”?`} danger confirmLabel="Delete signature" busy={remove.isPending}>
        People who use this signature will get the next one that applies to them, or none. Messages already sent are not changed.
      </ConfirmDialog>
    </div>
  );
}

const toBody = (s: Draft) => ({
  name: s.name,
  html: s.html,
  enabled: s.enabled,
  audience: s.audience,
  groupIds: s.groupIds,
  useForNew: s.useForNew,
  useForReplies: s.useForReplies,
  applyToApps: s.applyToApps,
});

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

/** Highlights {{variables}} so they stand out from fixed text. */
const VariableHighlight = Extension.create({
  name: 'variableHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations(state) {
            const decos: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (!node.isText || !node.text) return;
              for (const m of node.text.matchAll(/\{\{\s*\w+\s*\}\}/g)) decos.push(Decoration.inline(pos + m.index, pos + m.index + m[0].length, { class: 'forge-var' }));
            });
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});

export function SignatureEditorPage() {
  const { id } = useParams();
  const isNew = id === 'new';
  const list = useQuery({ queryKey: ['admin', 'signatures'], queryFn: () => api<{ items: SignatureRow[]; variables: Variable[] }>('/api/v1/admin/signatures') });
  if (list.isLoading) return <PageSpinner />;
  const existing = list.data?.items.find((s) => s.id === id);
  if (!isNew && !existing) return <EmptyState title="Signature not found" />;
  return <SignatureEditor key={id} existing={existing ?? null} variables={list.data?.variables ?? []} />;
}

function SignatureEditor({ existing, variables }: { existing: SignatureRow | null; variables: Variable[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const canManage = useCan('org:manage');
  const [f, setF] = useState<Draft>(existing ? toBody(existing) : { ...EMPTY, name: '' });
  const [error, setError] = useState<string | null>(null);
  const [imageOpen, setImageOpen] = useState(false);
  const [previewUser, setPreviewUser] = useState<{ id: string; displayName: string } | null>(null);
  const groups = useQuery({ queryKey: ['admin', 'groups', 'all'], queryFn: () => api<{ items: Group[] }>('/api/v1/admin/groups') });

  const editor = useEditor({
    extensions: [...richTextExtensions('Design the signature…', { resizableImages: true }), VariableHighlight],
    content: f.html,
    editable: canManage,
    editorProps: { attributes: { class: 'forge-editor min-h-48 px-4 py-3 text-sm focus:outline-none' } },
    onUpdate: ({ editor: e }) => setF((x) => ({ ...x, html: e.getHTML() })),
  });

  const html = useDebounced(f.html, 400);
  const preview = useQuery({
    queryKey: ['admin', 'signature-preview', html, previewUser?.id],
    queryFn: () => api<{ html: string; text: string }>('/api/v1/admin/signatures/preview', { body: { html, userId: previewUser?.id } }),
    placeholderData: (prev) => prev,
  });

  const save = useMutation({
    mutationFn: () => (existing ? api(`/api/v1/admin/signatures/${existing.id}`, { method: 'PUT', body: toBody(f) }) : api('/api/v1/admin/signatures', { body: toBody(f) })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'signatures'] });
      void qc.invalidateQueries({ queryKey: ['mail', 'signature'] });
      toast.success('Signature saved');
      navigate('/admin/signatures');
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const toggleGroup = (gid: string) => setF((x) => ({ ...x, groupIds: x.groupIds.includes(gid) ? x.groupIds.filter((g) => g !== gid) : [...x.groupIds, gid] }));

  return (
    <div className="space-y-6">
      <Link to="/admin/signatures" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
        <ArrowLeft className="size-4" /> Email signatures
      </Link>
      <PageHeader
        title={existing ? existing.name : 'New signature'}
        actions={
          canManage && (
            <Button variant="primary" loading={save.isPending} disabled={!f.name.trim()} onClick={() => save.mutate()}>
              Save signature
            </Button>
          )
        }
      />
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader
              title="Design"
              description="Type fixed text, and insert variables for each person's details. Lines whose variables are all empty for someone (say, no mobile number) are left out of their signature."
              actions={
                canManage && (
                  <Select aria-label="Start from a template" className="h-8 w-48 py-0" value="" onChange={(e) => {
                    const t = TEMPLATES.find((x) => x.name === e.target.value);
                    if (t && editor && (editor.isEmpty || window.confirm('Replace the current design with this template?'))) editor.commands.setContent(t.html, { emitUpdate: true });
                  }}>
                    <option value="">Start from a template…</option>
                    {TEMPLATES.map((t) => (
                      <option key={t.name}>{t.name}</option>
                    ))}
                  </Select>
                )
              }
            />
            {canManage && <SignatureToolbar editor={editor} variables={variables} onImage={() => setImageOpen(true)} />}
            <div className="border-t border-zinc-200 dark:border-zinc-800">
              <EditorContent editor={editor} />
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Preview"
              description={previewUser ? `As ${previewUser.displayName} will see it.` : 'With sample details. Pick a person to see their real signature.'}
              actions={
                previewUser && (
                  <Button size="sm" variant="ghost" icon={<X className="size-4" />} onClick={() => setPreviewUser(null)}>
                    Use sample details
                  </Button>
                )
              }
            />
            <CardBody className="space-y-4">
              <div className="max-w-sm">
                <UserPicker onPick={(u) => setPreviewUser({ id: u.id, displayName: u.displayName })} />
              </div>
              <div className="rounded-lg border border-zinc-200 bg-white p-4 text-zinc-900 dark:border-zinc-800">
                <p className="mb-3 text-sm text-zinc-500">Hi Sam,</p>
                <p className="mb-4 text-sm text-zinc-500">Thanks for your time today. I've attached the notes.</p>
                {preview.data ? <div className="forge-signature-preview text-sm" dangerouslySetInnerHTML={{ __html: preview.data.html }} /> : <PageSpinner />}
              </div>
              {preview.data && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-zinc-500">Plain-text version</summary>
                  <pre className="mt-2 rounded-lg bg-zinc-100 p-3 text-xs whitespace-pre-wrap dark:bg-zinc-800">{preview.data.text}</pre>
                </details>
              )}
            </CardBody>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Settings" />
            <CardBody className="space-y-4">
              <Field label="Name" htmlFor="sig-name">
                <Input id="sig-name" value={f.name} disabled={!canManage} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Standard signature" />
              </Field>
              <Switch checked={f.enabled} disabled={!canManage} onChange={(v) => setF({ ...f, enabled: v })} label="On" />
              <Field label="Who gets it" htmlFor="sig-aud">
                <Select id="sig-aud" value={f.audience} disabled={!canManage} onChange={(e) => setF({ ...f, audience: e.target.value as Draft['audience'] })}>
                  <option value="all">Everyone</option>
                  <option value="groups">Members of chosen groups</option>
                </Select>
              </Field>
              {f.audience === 'groups' && (
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
                  {(groups.data?.items ?? []).map((g) => (
                    <label key={g.id} className="flex items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                      <input type="checkbox" className="rounded" checked={f.groupIds.includes(g.id)} disabled={!canManage} onChange={() => toggleGroup(g.id)} />
                      {g.name}
                    </label>
                  ))}
                  {!groups.data?.items.length && <p className="text-sm text-zinc-500">No groups yet.</p>}
                </div>
              )}
              <div className="space-y-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
                <p className="text-sm font-medium">Where it's added</p>
                <Switch checked={f.useForNew} disabled={!canManage} onChange={(v) => setF({ ...f, useForNew: v })} label="New messages in webmail" />
                <Switch checked={f.useForReplies} disabled={!canManage} onChange={(v) => setF({ ...f, useForReplies: v })} label="Replies and forwards in webmail" />
                <Switch
                  checked={f.applyToApps}
                  disabled={!canManage}
                  onChange={(v) => setF({ ...f, applyToApps: v })}
                  label="Mail sent from desktop and phone apps"
                  description="Added by the server to messages sent with Outlook, Apple Mail, Thunderbird and so on, unless the message already contains it."
                />
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Variables" description="Filled from each person's contact details (Admin → Users)." />
            <CardBody>
              <ul className="space-y-1 text-sm">
                {variables.map((v) => (
                  <li key={v.key} className="flex items-center justify-between gap-2">
                    <span className="text-zinc-600 dark:text-zinc-400">{v.label}</span>
                    <button type="button" disabled={!canManage} className="forge-var rounded px-1 font-mono text-xs hover:underline disabled:no-underline" onClick={() => editor?.chain().focus().insertContent(`{{${v.key}}}`).run()}>
                      {`{{${v.key}}}`}
                    </button>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </div>
      </div>
      {imageOpen && editor && <ImageDialog editor={editor} onClose={() => setImageOpen(false)} />}
    </div>
  );
}

function SignatureToolbar({ editor, variables, onImage }: { editor: Editor | null; variables: Variable[]; onImage: () => void }) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const rerender = () => force((n) => n + 1);
    editor.on('transaction', rerender);
    return () => void editor.off('transaction', rerender);
  }, [editor]);
  if (!editor) return null;
  const chain = () => editor.chain().focus();
  const btn = (active: boolean, label: string, onClick: () => void, Icon: typeof Bold, disabled = false) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn('rounded p-1.5 hover:bg-zinc-100 disabled:opacity-30 dark:hover:bg-zinc-800', active && 'bg-zinc-200 dark:bg-zinc-700')}
    >
      <Icon className="size-4" />
    </button>
  );
  const style = editor.getAttributes('textStyle') as { fontFamily?: string; fontSize?: string; color?: string };
  const sep = <span className="mx-1 h-5 w-px self-center bg-zinc-200 dark:bg-zinc-700" />;
  const inTable = editor.isActive('table');
  const image = editor.isActive('image') ? (editor.getAttributes('image') as { width?: number | string }) : null;

  const link = () => {
    if (editor.isActive('link')) return chain().unsetLink().run();
    const url = window.prompt('Link address. You can use a variable, e.g. {{website}}, mailto:{{email}} or tel:{{workPhone}}');
    if (!url) return;
    const href = /^(https?:|mailto:|tel:|\{\{)/i.test(url) ? url : `https://${url}`;
    if (editor.state.selection.empty) chain().insertContent(`<a href="${href.replace(/"/g, '&quot;')}">${url.replace(/</g, '&lt;')}</a>`).run();
    else chain().extendMarkRange('link').setLink({ href }).run();
  };

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-t border-zinc-200 px-2 py-1 dark:border-zinc-800">
      {btn(false, 'Undo', () => chain().undo().run(), Undo2, !editor.can().undo())}
      {btn(false, 'Redo', () => chain().redo().run(), Redo2, !editor.can().redo())}
      {sep}
      <select aria-label="Font" className="h-8 w-32 rounded border-zinc-200 bg-transparent py-0 text-xs dark:border-zinc-700" value={style.fontFamily ?? ''} onChange={(e) => (e.target.value ? chain().setFontFamily(e.target.value).run() : chain().unsetFontFamily().run())}>
        <option value="">Default font</option>
        {FONTS.map((f) => (
          <option key={f} value={f} style={{ fontFamily: f }}>
            {f}
          </option>
        ))}
      </select>
      <select aria-label="Size" className="h-8 w-20 rounded border-zinc-200 bg-transparent py-0 text-xs dark:border-zinc-700" value={style.fontSize ?? ''} onChange={(e) => (e.target.value ? chain().setFontSize(e.target.value).run() : chain().unsetFontSize().run())}>
        <option value="">Size</option>
        {SIZES.map((s) => (
          <option key={s} value={s}>
            {s.replace('px', '')}
          </option>
        ))}
      </select>
      {sep}
      {btn(editor.isActive('bold'), 'Bold', () => chain().toggleBold().run(), Bold)}
      {btn(editor.isActive('italic'), 'Italic', () => chain().toggleItalic().run(), Italic)}
      {btn(editor.isActive('underline'), 'Underline', () => chain().toggleUnderline().run(), Underline)}
      {btn(editor.isActive('strike'), 'Strikethrough', () => chain().toggleStrike().run(), Strikethrough)}
      <ColorPicker value={style.color} onChange={(c) => (c ? chain().setColor(c).run() : chain().unsetColor().run())} />
      {sep}
      {btn(editor.isActive({ textAlign: 'left' }), 'Align left', () => chain().setTextAlign('left').run(), AlignLeft)}
      {btn(editor.isActive({ textAlign: 'center' }), 'Centre', () => chain().setTextAlign('center').run(), AlignCenter)}
      {btn(editor.isActive({ textAlign: 'right' }), 'Align right', () => chain().setTextAlign('right').run(), AlignRight)}
      {sep}
      {btn(editor.isActive('link'), editor.isActive('link') ? 'Remove link' : 'Link', link, Link2)}
      {btn(false, 'Image or logo', onImage, ImagePlus)}
      {btn(inTable, 'Insert a table (for a logo beside text)', () => chain().insertTable({ rows: 1, cols: 2, withHeaderRow: false }).run(), Table2, inTable)}
      {btn(false, 'Divider line', () => chain().setHorizontalRule().run(), Minus)}
      {btn(false, 'Clear formatting', () => chain().unsetAllMarks().unsetTextAlign().run(), Eraser)}
      {sep}
      <label className="flex items-center gap-1">
        <Braces className="size-4 text-zinc-500" />
        <select
          aria-label="Insert variable"
          className="h-8 w-40 rounded border-zinc-200 bg-transparent py-0 text-xs dark:border-zinc-700"
          value=""
          onChange={(e) => e.target.value && chain().insertContent(`{{${e.target.value}}}`).run()}
        >
          <option value="">Insert variable…</option>
          {variables.map((v) => (
            <option key={v.key} value={v.key}>
              {v.label}
            </option>
          ))}
        </select>
      </label>
      {inTable && (
        <span className="ml-2 flex flex-wrap items-center gap-1 text-xs">
          <span className="text-zinc-500">Table:</span>
          <Button size="sm" variant="ghost" onClick={() => chain().addColumnAfter().run()}>
            + column
          </Button>
          <Button size="sm" variant="ghost" onClick={() => chain().addRowAfter().run()}>
            + row
          </Button>
          <Button size="sm" variant="ghost" onClick={() => chain().deleteColumn().run()}>
            − column
          </Button>
          <Button size="sm" variant="ghost" onClick={() => chain().deleteRow().run()}>
            − row
          </Button>
          <Button size="sm" variant="ghost" onClick={() => chain().deleteTable().run()}>
            Remove table
          </Button>
        </span>
      )}
      {image && (
        <span className="ml-2 flex items-center gap-1 text-xs">
          <span className="text-zinc-500">Image width</span>
          <Input
            aria-label="Image width in pixels"
            type="number"
            min={16}
            max={600}
            className="h-8 w-20"
            value={image.width ?? ''}
            onChange={(e) => chain().updateAttributes('image', { width: Number(e.target.value) || null, height: null }).run()}
          />
          <span className="text-zinc-500">px</span>
        </span>
      )}
    </div>
  );
}

function ColorPicker({ value, onChange }: { value?: string; onChange: (c: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button type="button" title="Text colour" aria-label="Text colour" onClick={() => setOpen((o) => !o)} className="flex size-8 flex-col items-center justify-center rounded hover:bg-zinc-100 dark:hover:bg-zinc-800">
        <span className="text-sm leading-none font-semibold">A</span>
        <span className="mt-0.5 h-1 w-4 rounded" style={{ background: value ?? '#18181b' }} />
      </button>
      {open && (
        <div className="absolute top-full left-0 z-20 mt-1 w-48 rounded-lg border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <div className="grid grid-cols-6 gap-1">
            {SWATCHES.map((c) => (
              <button key={c} type="button" aria-label={c} className="size-6 rounded ring-1 ring-black/10" style={{ background: c }} onClick={() => (onChange(c), setOpen(false))} />
            ))}
            <label className="relative size-6 cursor-pointer overflow-hidden rounded ring-1 ring-black/10" title="Custom colour" style={{ background: 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' }}>
              <input type="color" className="absolute inset-0 opacity-0" value={value ?? '#18181b'} onChange={(e) => onChange(e.target.value)} />
            </label>
          </div>
          <button type="button" className="mt-2 text-xs text-zinc-500 hover:underline" onClick={() => (onChange(null), setOpen(false))}>
            Default colour
          </button>
        </div>
      )}
    </div>
  );
}

function ImageDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState('');
  const [width, setWidth] = useState(120);
  const [error, setError] = useState<string | null>(null);
  const images = useQuery({ queryKey: ['admin', 'signature-images'], queryFn: () => api<{ items: { id: string; name: string; url: string }[] }>('/api/v1/admin/signatures/images') });
  const insert = (src: string) => {
    editor.chain().focus().setImage({ src, width }).run();
    onClose();
  };
  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > 512 * 1024) throw new Error('Images must be 512 KB or smaller');
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error('Could not read the file'));
        r.readAsDataURL(file);
      });
      return api<{ image: { url: string } }>('/api/v1/admin/signatures/images', { body: { dataUrl, name: file.name } });
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'signature-images'] });
      insert(r.image.url);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Dialog open onClose={onClose} size="lg" title="Add an image" description="Logos and icons are hosted by ForgeOffice so recipients' mail apps can show them. Use PNG or JPEG for the widest support.">
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      <div className="space-y-5">
        <Field label="Width (pixels)" htmlFor="img-w" hint="You can also drag the image's corner in the editor.">
          <Input id="img-w" type="number" min={16} max={600} className="w-28" value={width} onChange={(e) => setWidth(Number(e.target.value) || 120)} />
        </Field>
        <Field label="Upload" htmlFor="img-file">
          <input id="img-file" type="file" accept="image/png,image/jpeg,image/webp" className="block text-sm" disabled={upload.isPending} onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} />
        </Field>
        {!!images.data?.items.length && (
          <div>
            <p className="mb-2 text-sm font-medium">Or reuse an uploaded image</p>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {images.data.items.map((img) => (
                <button key={img.id} type="button" title={img.name} onClick={() => insert(img.url)} className="flex aspect-square items-center justify-center rounded-lg border border-zinc-200 bg-white p-2 hover:border-brand dark:border-zinc-700">
                  <img src={img.url} alt={img.name} className="max-h-full max-w-full object-contain" />
                </button>
              ))}
            </div>
          </div>
        )}
        <Field label="Or use an image address" htmlFor="img-url">
          <div className="flex gap-2">
            <Input id="img-url" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
            <Button disabled={!/^https:\/\//i.test(url)} onClick={() => insert(url)}>
              Insert
            </Button>
          </div>
        </Field>
      </div>
    </Dialog>
  );
}

