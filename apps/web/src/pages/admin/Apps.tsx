import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppWindow, ArrowLeft, Check, Copy, KeyRound, LogOut, Plus, Server, Smartphone, Trash2 } from 'lucide-react';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog, EmptyState, Field, Input, PageHeader, PageSpinner, Select, Switch, Table, Td, Textarea, Th, cn, formatDateTime, formatRelative, useToast } from '@forge/ui';
import { ConfirmDialog } from '../../components/admin';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/hooks';
import type { Group } from '../../lib/types';

interface OAuthApp {
  id: string;
  clientId: string;
  name: string;
  description: string;
  homepageUrl: string | null;
  type: 'confidential' | 'public';
  authMethod: 'client_secret_basic' | 'client_secret_post';
  hasSecret: boolean;
  secretHint: string | null;
  secretCreatedAt: string | null;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  scopes: string[];
  access: 'all' | 'groups';
  groupIds: string[];
  consent: 'user' | 'admin';
  enabled: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

interface Endpoints {
  issuer: string;
  discovery: string;
  authorization: string;
  token: string;
  userinfo: string;
  jwks: string;
  endSession: string;
  revocation: string;
  scopes: { scope: string; label: string; description: string; required?: boolean }[];
}

const lines = (s: string) => s.split(/\s+/).map((x) => x.trim()).filter(Boolean);

function CopyField({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-zinc-500">{label}</p>
      <div className="flex items-center gap-2">
        <code className={cn('min-w-0 flex-1 truncate rounded-lg bg-zinc-100 px-3 py-2 text-xs dark:bg-zinc-800', !mono && 'font-sans')} title={value}>
          {value}
        </code>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Copy ${label}`}
          onClick={() => {
            void navigator.clipboard?.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
        </Button>
      </div>
    </div>
  );
}

/** Shown once after creating an app or generating a new secret. */
function SecretDialog({ clientId, secret, onClose }: { clientId: string; secret: string; onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} title="Copy the client secret now" description="For security it won't be shown again. If it's lost, generate a new one." footer={<Button variant="primary" onClick={onClose}>I've copied it</Button>}>
      <div className="space-y-3">
        <CopyField label="Client ID" value={clientId} />
        <CopyField label="Client secret" value={secret} />
        <Alert tone="warning">Keep the secret on the app's server only. Never put it in a browser or mobile app.</Alert>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function AppsPage() {
  const navigate = useNavigate();
  const canManage = useCan('org:manage');
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ id: string; clientId: string; secret: string } | null>(null);
  const apps = useQuery({ queryKey: ['admin', 'apps'], queryFn: () => api<{ items: OAuthApp[] }>('/api/v1/admin/apps') });
  return (
    <div>
      <PageHeader
        title="App registrations"
        description="Let other applications sign people in with their ForgeOffice account, using OAuth 2.0 and OpenID Connect."
        actions={
          canManage && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              Register an app
            </Button>
          )
        }
      />
      <Card>
        {apps.isLoading ? (
          <PageSpinner />
        ) : !apps.data?.items.length ? (
          <EmptyState icon={<AppWindow />} title="No apps registered" description="Register a wiki, help desk, Grafana, GitLab or your own app so people can use “Sign in with ForgeOffice”." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>App</Th>
                <Th className="hidden md:table-cell">Who can sign in</Th>
                <Th className="hidden md:table-cell">Last used</Th>
              </tr>
            </thead>
            <tbody>
              {apps.data.items.map((a) => (
                <tr key={a.id} className={a.enabled ? '' : 'opacity-60'}>
                  <Td>
                    <Link to={`/admin/directory/apps/${a.id}`} className="font-medium text-zinc-900 hover:underline dark:text-zinc-100">
                      {a.name}
                    </Link>
                    <span className="mt-1 flex flex-wrap gap-1.5">
                      <Badge>{a.type === 'confidential' ? 'Web app' : 'SPA / mobile'}</Badge>
                      {!a.enabled && <Badge tone="warning">Off</Badge>}
                      {a.consent === 'admin' && <Badge tone="info">Approved for everyone</Badge>}
                    </span>
                  </Td>
                  <Td className="hidden md:table-cell">{a.access === 'all' ? 'Everyone' : `${a.groupIds.length} group${a.groupIds.length === 1 ? '' : 's'}`}</Td>
                  <Td className="hidden md:table-cell">{a.lastUsedAt ? formatRelative(a.lastUsedAt) : 'Never'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {creating && (
        <CreateAppDialog
          onClose={() => setCreating(false)}
          onCreated={(app, clientSecret) => {
            setCreating(false);
            if (clientSecret) setSecret({ id: app.id, clientId: app.clientId, secret: clientSecret });
            else navigate(`/admin/directory/apps/${app.id}`);
          }}
        />
      )}
      {secret && (
        <SecretDialog
          clientId={secret.clientId}
          secret={secret.secret}
          onClose={() => {
            const id = secret.id;
            setSecret(null);
            navigate(`/admin/directory/apps/${id}`);
          }}
        />
      )}
    </div>
  );
}

function CreateAppDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (app: OAuthApp, secret: string | null) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: '', type: 'confidential' as OAuthApp['type'], redirectUris: '', homepageUrl: '' });
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api<{ app: OAuthApp; clientSecret: string | null }>('/api/v1/admin/apps', { body: { name: f.name, type: f.type, redirectUris: lines(f.redirectUris), homepageUrl: f.homepageUrl || null } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'apps'] });
      onCreated(r.app, r.clientSecret);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const kinds = [
    { type: 'confidential' as const, icon: Server, title: 'Web app with a server', body: 'Runs on a server that can keep a secret: wikis, help desks, Grafana, GitLab, Nextcloud…' },
    { type: 'public' as const, icon: Smartphone, title: 'Single-page or mobile app', body: 'Runs in the browser or on a device, so it cannot keep a secret. Uses PKCE.' },
  ];
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Register an app"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} disabled={!f.name.trim() || !lines(f.redirectUris).length} onClick={() => create.mutate()}>
            Register
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      <div className="space-y-4">
        <Field label="Name" htmlFor="app-name" hint="People see this when they sign in.">
          <Input id="app-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Team Wiki" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          {kinds.map((k) => (
            <button
              key={k.type}
              type="button"
              aria-pressed={f.type === k.type}
              onClick={() => setF({ ...f, type: k.type })}
              className={cn('rounded-lg p-3 text-left ring-1 ring-zinc-200 dark:ring-zinc-700', f.type === k.type && 'bg-zinc-50 ring-2 ring-brand dark:bg-zinc-800/60')}
            >
              <k.icon className="mb-2 size-5 text-brand" />
              <p className="text-sm font-medium">{k.title}</p>
              <p className="mt-0.5 text-xs text-zinc-500">{k.body}</p>
            </button>
          ))}
        </div>
        <Field label="Redirect URIs" htmlFor="app-redirect" hint="Where ForgeOffice sends people back after signing in, one per line. Exact matches only; https, or http://localhost for development.">
          <Textarea id="app-redirect" rows={3} className="font-mono text-xs" value={f.redirectUris} onChange={(e) => setF({ ...f, redirectUris: e.target.value })} placeholder="https://wiki.example.com/oauth/callback" />
        </Field>
        <Field label="Homepage (optional)" htmlFor="app-home">
          <Input id="app-home" value={f.homepageUrl} onChange={(e) => setF({ ...f, homepageUrl: e.target.value })} placeholder="https://wiki.example.com" />
        </Field>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export function AppDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const canManage = useCan('org:manage');
  const app = useQuery({ queryKey: ['admin', 'apps', id], queryFn: () => api<{ app: OAuthApp }>(`/api/v1/admin/apps/${id}`) });
  const endpoints = useQuery({ queryKey: ['admin', 'apps', 'endpoints'], queryFn: () => api<Endpoints>('/api/v1/admin/apps/endpoints') });
  const groups = useQuery({ queryKey: ['admin', 'groups', 'all'], queryFn: () => api<{ items: Group[] }>('/api/v1/admin/groups') });
  const [f, setF] = useState<(Omit<OAuthApp, 'redirectUris' | 'postLogoutRedirectUris'> & { redirectUris: string; postLogoutRedirectUris: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'secret' | 'revoke' | 'delete' | null>(null);

  useEffect(() => {
    const a = app.data?.app;
    if (a) setF({ ...a, redirectUris: a.redirectUris.join('\n'), postLogoutRedirectUris: a.postLogoutRedirectUris.join('\n') });
  }, [app.data]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['admin', 'apps'] });
  };
  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/admin/apps/${id}`, {
        method: 'PUT',
        body: {
          name: f!.name,
          description: f!.description,
          homepageUrl: f!.homepageUrl || null,
          redirectUris: lines(f!.redirectUris),
          postLogoutRedirectUris: lines(f!.postLogoutRedirectUris),
          scopes: f!.scopes,
          access: f!.access,
          groupIds: f!.groupIds,
          consent: f!.consent,
          authMethod: f!.authMethod,
          enabled: f!.enabled,
        },
      }),
    onSuccess: () => {
      setError(null);
      toast.success('App saved');
      refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const action = useMutation({
    mutationFn: async (what: 'secret' | 'revoke' | 'delete') => {
      if (what === 'secret') return api<{ clientSecret: string }>(`/api/v1/admin/apps/${id}/secret`, { body: {} });
      if (what === 'revoke') return api(`/api/v1/admin/apps/${id}/revoke`, { body: {} });
      return api(`/api/v1/admin/apps/${id}`, { method: 'DELETE' });
    },
    onSuccess: (r, what) => {
      setConfirm(null);
      refresh();
      if (what === 'secret') setSecret((r as { clientSecret: string }).clientSecret);
      if (what === 'revoke') toast.success('Everyone has been signed out of this app');
      if (what === 'delete') navigate('/admin/directory/apps');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (app.isLoading || !f) return <PageSpinner />;
  if (!app.data) return <EmptyState title="App not found" />;
  const a = app.data.app;
  const toggleScope = (s: string) => setF({ ...f, scopes: f.scopes.includes(s) ? f.scopes.filter((x) => x !== s) : [...f.scopes, s] });
  const toggleGroup = (g: string) => setF({ ...f, groupIds: f.groupIds.includes(g) ? f.groupIds.filter((x) => x !== g) : [...f.groupIds, g] });

  return (
    <div className="space-y-6">
      <Link to="/admin/directory/apps" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
        <ArrowLeft className="size-4" /> App registrations
      </Link>
      <PageHeader
        title={a.name}
        description={`${a.type === 'confidential' ? 'Web app with a server' : 'Single-page or mobile app'} · registered ${formatDateTime(a.createdAt)} · ${a.lastUsedAt ? `last sign-in ${formatRelative(a.lastUsedAt)}` : 'not used yet'}`}
        actions={
          canManage && (
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
              Save changes
            </Button>
          )
        }
      />
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <fieldset disabled={!canManage} className="min-w-0 space-y-6">
          <Card>
            <CardHeader title="General" />
            <CardBody className="space-y-4">
              <Switch checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label="On" description="Turning an app off signs everyone out of it and blocks new sign-ins." />
              <Field label="Name" htmlFor="a-name">
                <Input id="a-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
              </Field>
              <Field label="Description" htmlFor="a-desc" hint="Shown on the consent screen.">
                <Input id="a-desc" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
              </Field>
              <Field label="Homepage" htmlFor="a-home">
                <Input id="a-home" value={f.homepageUrl ?? ''} onChange={(e) => setF({ ...f, homepageUrl: e.target.value })} placeholder="https://" />
              </Field>
              <Field label="Redirect URIs" htmlFor="a-redir" hint="One per line. Must match exactly what the app sends.">
                <Textarea id="a-redir" rows={3} className="font-mono text-xs" value={f.redirectUris} onChange={(e) => setF({ ...f, redirectUris: e.target.value })} />
              </Field>
              <Field label="Sign-out redirect URIs (optional)" htmlFor="a-logout" hint="Where the app may send people after signing out of ForgeOffice.">
                <Textarea id="a-logout" rows={2} className="font-mono text-xs" value={f.postLogoutRedirectUris} onChange={(e) => setF({ ...f, postLogoutRedirectUris: e.target.value })} />
              </Field>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="What the app can see" description="The app can only ask for these. People see them on the consent screen. Removing one signs everyone out of the app." />
            <CardBody className="space-y-2">
              {endpoints.data?.scopes.map((s) => (
                <label key={s.scope} className="flex items-start gap-3 rounded-lg px-1 py-1 text-sm">
                  <input type="checkbox" className="mt-0.5 rounded" checked={s.required || f.scopes.includes(s.scope)} disabled={s.required} onChange={() => toggleScope(s.scope)} />
                  <span>
                    <span className="font-medium">{s.label}</span> <code className="text-xs text-zinc-500">{s.scope}</code>
                    <span className="block text-xs text-zinc-500">{s.description}</span>
                  </span>
                </label>
              ))}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Who can sign in" />
            <CardBody className="space-y-4">
              <Field label="Access" htmlFor="a-access">
                <Select id="a-access" value={f.access} onChange={(e) => setF({ ...f, access: e.target.value as OAuthApp['access'] })}>
                  <option value="all">Everyone in the organisation</option>
                  <option value="groups">Only members of chosen groups</option>
                </Select>
              </Field>
              {f.access === 'groups' && (
                <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
                  {(groups.data?.items ?? []).map((g) => (
                    <label key={g.id} className="flex items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                      <input type="checkbox" className="rounded" checked={f.groupIds.includes(g.id)} onChange={() => toggleGroup(g.id)} />
                      {g.name}
                    </label>
                  ))}
                  {!groups.data?.items.length && <p className="text-sm text-zinc-500">No groups yet.</p>}
                </div>
              )}
              <p className="text-xs text-zinc-500">People removed from these groups lose access straight away, including apps that are already signed in.</p>
              <Field label="Consent" htmlFor="a-consent">
                <Select id="a-consent" value={f.consent} onChange={(e) => setF({ ...f, consent: e.target.value as OAuthApp['consent'] })}>
                  <option value="user">Ask each person the first time they sign in</option>
                  <option value="admin">Approve for everyone (no consent screen)</option>
                </Select>
              </Field>
            </CardBody>
          </Card>
        </fieldset>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Credentials" />
            <CardBody className="space-y-4">
              <CopyField label="Client ID" value={a.clientId} />
              {a.type === 'confidential' ? (
                <>
                  <div>
                    <p className="mb-1 text-xs font-medium text-zinc-500">Client secret</p>
                    <p className="text-sm">
                      <code className="text-xs">••••••••{a.secretHint}</code>
                      {a.secretCreatedAt && <span className="ml-2 text-xs text-zinc-500">created {formatRelative(a.secretCreatedAt)}</span>}
                    </p>
                    {canManage && (
                      <Button size="sm" className="mt-2" icon={<KeyRound className="size-4" />} onClick={() => setConfirm('secret')}>
                        New secret
                      </Button>
                    )}
                  </div>
                  <Field label="Sends the secret using" htmlFor="a-auth">
                    <Select id="a-auth" disabled={!canManage} value={f.authMethod} onChange={(e) => setF({ ...f, authMethod: e.target.value as OAuthApp['authMethod'] })}>
                      <option value="client_secret_basic">HTTP Basic (client_secret_basic)</option>
                      <option value="client_secret_post">Form fields (client_secret_post)</option>
                    </Select>
                  </Field>
                </>
              ) : (
                <p className="text-sm text-zinc-500">No secret: this app must use PKCE (S256).</p>
              )}
            </CardBody>
          </Card>

          {endpoints.data && (
            <Card>
              <CardHeader title="Connection details" description="Most apps only need the issuer or discovery URL, the client ID and secret." />
              <CardBody className="space-y-3">
                <CopyField label="Issuer" value={endpoints.data.issuer} />
                <CopyField label="Discovery (.well-known)" value={endpoints.data.discovery} />
                <CopyField label="Authorization endpoint" value={endpoints.data.authorization} />
                <CopyField label="Token endpoint" value={endpoints.data.token} />
                <CopyField label="Userinfo endpoint" value={endpoints.data.userinfo} />
                <CopyField label="JWKS" value={endpoints.data.jwks} />
                <CopyField label="Sign-out endpoint" value={endpoints.data.endSession} />
                <p className="text-xs text-zinc-500">
                  Scopes: <code>{f.scopes.join(' ')}</code>. Use the <code>sub</code> claim as the user's ID. Refresh tokens need the <code>offline_access</code> scope and <code>prompt=consent</code>.
                </p>
              </CardBody>
            </Card>
          )}

          {canManage && (
            <Card>
              <CardHeader title="Danger zone" />
              <CardBody className="flex flex-wrap gap-2">
                <Button icon={<LogOut className="size-4" />} onClick={() => setConfirm('revoke')}>
                  Sign everyone out
                </Button>
                <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={() => setConfirm('delete')}>
                  Delete app
                </Button>
              </CardBody>
            </Card>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm && action.mutate(confirm)}
        busy={action.isPending}
        danger={confirm !== 'secret'}
        title={confirm === 'secret' ? 'Generate a new client secret?' : confirm === 'revoke' ? `Sign everyone out of ${a.name}?` : `Delete ${a.name}?`}
        confirmLabel={confirm === 'secret' ? 'Generate secret' : confirm === 'revoke' ? 'Sign everyone out' : 'Delete app'}
      >
        {confirm === 'secret'
          ? 'The current secret stops working immediately. Update the app with the new one straight away.'
          : confirm === 'revoke'
            ? 'All its tokens and consents are removed. People will sign in (and consent) again next time.'
            : 'People will no longer be able to sign in to it with ForgeOffice. This cannot be undone.'}
      </ConfirmDialog>
      {secret && <SecretDialog clientId={a.clientId} secret={secret} onClose={() => setSecret(null)} />}
    </div>
  );
}
