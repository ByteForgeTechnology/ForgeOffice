import { createBrowserRouter } from 'react-router';
import { AdminLayout } from './layouts/AdminLayout';
import { RequireAuth, Root } from './layouts/Root';
import { Shell } from './layouts/Shell';
import { AccountPage } from './pages/Account';
import { CallbackPage } from './pages/Callback';
import { ComingSoonPage } from './pages/ComingSoon';
import { HomePage } from './pages/Home';
import { NotFoundPage } from './pages/NotFound';
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
import { SettingsPage } from './pages/admin/Settings';
import { UserDetailPage } from './pages/admin/UserDetail';
import { UsersPage } from './pages/admin/Users';

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
          {
            path: 'admin',
            element: <AdminLayout />,
            children: [
              { index: true, element: <DashboardPage /> },
              { path: 'users', element: <UsersPage /> },
              { path: 'users/:id', element: <UserDetailPage /> },
              { path: 'groups', element: <GroupsPage /> },
              { path: 'groups/:id', element: <GroupDetailPage /> },
              { path: 'domains', element: <DomainsPage /> },
              { path: 'roles', element: <RolesPage /> },
              { path: 'settings', element: <SettingsPage /> },
              { path: 'audit', element: <AuditPage /> },
              { path: 'queues/:name', element: <QueuePage /> },
            ],
          },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);
