import { useEffect } from 'react';
import { createBrowserRouter, Navigate, useLocation, useParams, type RouteObject } from 'react-router';
import { PageSpinner } from '@forge/ui';
import { RequireAuth, Root } from './layouts/Root';
import { Shell } from './layouts/Shell';
import { NotFoundPage } from './pages/NotFound';
import { appForPath, servesPath, WEB_APP } from './lib/web-app';

/*
 * Each web app is its own bundle, served by its own container (see
 * docker-compose.yml): portal (home, account, sign-in), mail, calendar,
 * contacts, tasks and admin. __FORGE_APP__ is replaced at build time, so the
 * conditions below are constant and the other apps' pages are left out of
 * the bundle. Development and all-in-one builds ("all") include everything.
 */
declare const __FORGE_APP__: string;

/** Old admin URLs → their new home (":id" is carried over). */
const LEGACY_ADMIN_PATHS: Record<string, string> = {
  users: 'directory/users',
  'users/:id': 'directory/users/:id',
  groups: 'directory/groups',
  'groups/:id': 'directory/groups/:id',
  roles: 'directory/roles',
  mail: 'mail/flow',
  'shared-mailboxes': 'mail/shared-mailboxes',
  'transport-rules': 'mail/transport-rules',
  'sender-lists': 'mail/sender-lists',
  signatures: 'mail/signatures',
  'signatures/:id': 'mail/signatures/:id',
  resources: 'calendar/rooms',
  settings: 'organisation/settings',
  domains: 'organisation/domains',
  audit: 'organisation/audit',
};

function LegacyRedirect({ to }: { to: string }) {
  const { id } = useParams();
  const { search } = useLocation();
  return <Navigate to={`/admin/${to.replace(':id', id ?? '')}${search}`} replace />;
}

/** A path that belongs to another app: load that app (its own container) through the gateway. */
function OtherAppOrNotFound() {
  const { pathname, search, hash } = useLocation();
  const elsewhere = !servesPath(pathname);
  useEffect(() => {
    if (elsewhere) window.location.assign(pathname + search + hash);
  }, [elsewhere, pathname, search, hash]);
  return elsewhere ? <PageSpinner /> : <NotFoundPage />;
}

/** Lazy page: `page(() => import('./pages/x'), 'XPage')`. */
const page =
  <M extends Record<string, unknown>>(load: () => Promise<M>, name: keyof M): RouteObject['lazy'] =>
  async () => ({ Component: (await load())[name] as React.ComponentType });

// Pages outside the signed-in shell (sign-in, setup) belong to the portal.
const publicRoutes: RouteObject[] =
  __FORGE_APP__ === 'all' || __FORGE_APP__ === 'portal'
    ? [
        { path: '/setup', lazy: page(() => import('./pages/Setup'), 'SetupPage') },
        { path: '/interaction/:uid', lazy: page(() => import('./pages/SignIn'), 'SignInPage') },
        { path: '/auth/callback', lazy: page(() => import('./pages/Callback'), 'CallbackPage') },
        { path: '/signed-out', lazy: page(() => import('./pages/SignedOut'), 'SignedOutPage') },
      ]
    : [];

const portal: RouteObject[] =
  __FORGE_APP__ === 'all' || __FORGE_APP__ === 'portal'
    ? [
        { index: true, lazy: page(() => import('./pages/Home'), 'HomePage') },
        { path: 'search', lazy: page(() => import('./pages/Search'), 'SearchPage') },
        { path: 'account', lazy: page(() => import('./pages/Account'), 'AccountPage') },
        { path: 'apps/:app', lazy: page(() => import('./pages/ComingSoon'), 'ComingSoonPage') },
      ]
    : [];

const mail: RouteObject[] =
  __FORGE_APP__ === 'all' || __FORGE_APP__ === 'mail'
    ? [
        { path: 'mail', lazy: page(() => import('./pages/mail/Mail'), 'MailPage') },
        { path: 'mail/settings', lazy: page(() => import('./pages/mail/MailSettings'), 'MailSettingsPage') },
      ]
    : [];

const calendar: RouteObject[] = __FORGE_APP__ === 'all' || __FORGE_APP__ === 'calendar' ? [{ path: 'calendar', lazy: page(() => import('./pages/calendar/Calendar'), 'CalendarPage') }] : [];
const contacts: RouteObject[] = __FORGE_APP__ === 'all' || __FORGE_APP__ === 'contacts' ? [{ path: 'contacts', lazy: page(() => import('./pages/contacts/Contacts'), 'ContactsPage') }] : [];
const tasks: RouteObject[] = __FORGE_APP__ === 'all' || __FORGE_APP__ === 'tasks' ? [{ path: 'tasks', lazy: page(() => import('./pages/tasks/Tasks'), 'TasksPage') }] : [];

const admin: RouteObject[] =
  __FORGE_APP__ === 'all' || __FORGE_APP__ === 'admin'
    ? [
        {
          path: 'admin',
          lazy: page(() => import('./layouts/AdminLayout'), 'AdminLayout'),
          children: [
            { index: true, lazy: page(() => import('./pages/admin/Dashboard'), 'DashboardPage') },
            { path: 'queues/:name', lazy: page(() => import('./pages/admin/Queue'), 'QueuePage') },
            // ForgeDirectory
            { path: 'directory/users', lazy: page(() => import('./pages/admin/Users'), 'UsersPage') },
            { path: 'directory/users/:id', lazy: page(() => import('./pages/admin/UserDetail'), 'UserDetailPage') },
            { path: 'directory/groups', lazy: page(() => import('./pages/admin/Groups'), 'GroupsPage') },
            { path: 'directory/groups/:id', lazy: page(() => import('./pages/admin/GroupDetail'), 'GroupDetailPage') },
            { path: 'directory/roles', lazy: page(() => import('./pages/admin/Roles'), 'RolesPage') },
            { path: 'directory/security', lazy: page(() => import('./pages/admin/Settings'), 'DirectorySecurityPage') },
            { path: 'directory/apps', lazy: page(() => import('./pages/admin/Apps'), 'AppsPage') },
            { path: 'directory/apps/:id', lazy: page(() => import('./pages/admin/Apps'), 'AppDetailPage') },
            // ForgeMail
            { path: 'mail/shared-mailboxes', lazy: page(() => import('./pages/admin/SharedMailboxes'), 'SharedMailboxesPage') },
            { path: 'mail/flow', lazy: page(() => import('./pages/admin/MailAdmin'), 'MailAdminPage') },
            { path: 'mail/transport-rules', lazy: page(() => import('./pages/admin/TransportRules'), 'TransportRulesPage') },
            { path: 'mail/sender-lists', lazy: page(() => import('./pages/admin/SenderLists'), 'SenderListsPage') },
            { path: 'mail/signatures', lazy: page(() => import('./pages/admin/Signatures'), 'SignaturesPage') },
            { path: 'mail/signatures/:id', lazy: page(() => import('./pages/admin/Signatures'), 'SignatureEditorPage') },
            { path: 'mail/settings', lazy: page(() => import('./pages/admin/Settings'), 'MailOrgSettingsPage') },
            // ForgeCalendar
            { path: 'calendar/rooms', lazy: page(() => import('./pages/admin/Resources'), 'ResourcesPage') },
            // Organisation
            { path: 'organisation/settings', lazy: page(() => import('./pages/admin/Settings'), 'SettingsPage') },
            { path: 'organisation/features', lazy: page(() => import('./pages/admin/Settings'), 'FeaturesPage') },
            { path: 'organisation/domains', lazy: page(() => import('./pages/admin/Domains'), 'DomainsPage') },
            { path: 'organisation/audit', lazy: page(() => import('./pages/admin/Audit'), 'AuditPage') },
            // Addresses from before the admin center was grouped by product.
            ...Object.entries(LEGACY_ADMIN_PATHS).map(([from, to]) => ({ path: from, element: <LegacyRedirect to={to} /> })),
          ],
        },
      ]
    : [];

/** Paths outside the shell that this bundle doesn't serve (e.g. /signed-out in the mail app). */
const elsewhere: RouteObject[] = WEB_APP === 'all' || WEB_APP === 'portal' ? [] : [{ path: '/setup' }, { path: '/interaction/:uid' }, { path: '/auth/callback' }, { path: '/signed-out' }].map((r) => ({ ...r, element: <OtherAppOrNotFound /> }));

export const router = createBrowserRouter([
  {
    element: <Root />,
    hydrateFallbackElement: <PageSpinner />,
    children: [
      ...publicRoutes,
      ...elsewhere,
      {
        element: (
          <RequireAuth>
            <Shell />
          </RequireAuth>
        ),
        children: [
          ...portal,
          ...mail,
          ...calendar,
          ...contacts,
          ...tasks,
          ...admin,
          // The home page lives in the portal app.
          ...(WEB_APP !== 'all' && WEB_APP !== 'portal' ? [{ index: true, element: <OtherAppOrNotFound /> }] : []),
          { path: '*', element: <OtherAppOrNotFound /> },
        ],
      },
    ],
  },
]);

