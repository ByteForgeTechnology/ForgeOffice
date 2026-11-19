import { createBrowserRouter, Navigate, useLocation, useParams } from 'react-router';
import { AdminLayout } from './layouts/AdminLayout';
import { RequireAuth, Root } from './layouts/Root';
import { Shell } from './layouts/Shell';
import { AccountPage } from './pages/Account';
import { CallbackPage } from './pages/Callback';
import { ComingSoonPage } from './pages/ComingSoon';
import { HomePage } from './pages/Home';
import { NotFoundPage } from './pages/NotFound';
import { MailPage } from './pages/mail/Mail';
import { MailSettingsPage } from './pages/mail/MailSettings';
import { CalendarPage } from './pages/calendar/Calendar';
import { ContactsPage } from './pages/contacts/Contacts';
import { TasksPage } from './pages/tasks/Tasks';
import { AppDetailPage, AppsPage } from './pages/admin/Apps';
import { MailAdminPage } from './pages/admin/MailAdmin';
import { ResourcesPage } from './pages/admin/Resources';
import { SharedMailboxesPage } from './pages/admin/SharedMailboxes';
import { TransportRulesPage } from './pages/admin/TransportRules';
import { SenderListsPage } from './pages/admin/SenderLists';
import { SignatureEditorPage, SignaturesPage } from './pages/admin/Signatures';
import { SearchPage } from './pages/Search';
import { SetupPage } from './pages/Setup';
import { SignedOutPage } from './pages/SignedOut';
import { SignInPage } from './pages/SignIn';
import { AuditPage } from './pages/admin/Audit';
import { DashboardPage } from './pages/admin/Dashboard';
import { DomainsPage } from './pages/admin/Domains';
import { GroupDetailPage } from './pages/admin/GroupDetail';
import { GroupsPage } from './pages/admin/Groups';
import { QueuePage } from './pages/admin/Queue';
import { RolesPage } from './pages/admin/Roles';
import { DirectorySecurityPage, MailOrgSettingsPage, SettingsPage } from './pages/admin/Settings';
import { UserDetailPage } from './pages/admin/UserDetail';
import { UsersPage } from './pages/admin/Users';


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

export const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      { path: '/setup', element: <SetupPage /> },
      { path: '/interaction/:uid', element: <SignInPage /> },
      { path: '/auth/callback', element: <CallbackPage /> },
      { path: '/signed-out', element: <SignedOutPage /> },
      {
        element: (
          <RequireAuth>
            <Shell />
          </RequireAuth>
        ),
        children: [
          { index: true, element: <HomePage /> },
          { path: 'search', element: <SearchPage /> },
          { path: 'account', element: <AccountPage /> },
          { path: 'apps/:app', element: <ComingSoonPage /> },
          { path: 'mail', element: <MailPage /> },
          { path: 'mail/settings', element: <MailSettingsPage /> },
          { path: 'calendar', element: <CalendarPage /> },
          { path: 'contacts', element: <ContactsPage /> },
          { path: 'tasks', element: <TasksPage /> },
          {
            path: 'admin',
            element: <AdminLayout />,
            children: [
              { index: true, element: <DashboardPage /> },
              { path: 'queues/:name', element: <QueuePage /> },
              // ForgeDirectory
              { path: 'directory/users', element: <UsersPage /> },
              { path: 'directory/users/:id', element: <UserDetailPage /> },
              { path: 'directory/groups', element: <GroupsPage /> },
              { path: 'directory/groups/:id', element: <GroupDetailPage /> },
              { path: 'directory/roles', element: <RolesPage /> },
              { path: 'directory/security', element: <DirectorySecurityPage /> },
              { path: 'directory/apps', element: <AppsPage /> },
              { path: 'directory/apps/:id', element: <AppDetailPage /> },
              // ForgeMail
              { path: 'mail/shared-mailboxes', element: <SharedMailboxesPage /> },
              { path: 'mail/flow', element: <MailAdminPage /> },
              { path: 'mail/transport-rules', element: <TransportRulesPage /> },
              { path: 'mail/sender-lists', element: <SenderListsPage /> },
              { path: 'mail/signatures', element: <SignaturesPage /> },
              { path: 'mail/signatures/:id', element: <SignatureEditorPage /> },
              { path: 'mail/settings', element: <MailOrgSettingsPage /> },
              // ForgeCalendar
              { path: 'calendar/rooms', element: <ResourcesPage /> },
              // Organisation
              { path: 'organisation/settings', element: <SettingsPage /> },
              { path: 'organisation/domains', element: <DomainsPage /> },
              { path: 'organisation/audit', element: <AuditPage /> },
              // Addresses from before the admin center was grouped by product.
              ...Object.entries(LEGACY_ADMIN_PATHS).map(([from, to]) => ({ path: from, element: <LegacyRedirect to={to} /> })),
            ],
          },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);
