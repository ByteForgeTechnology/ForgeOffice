import { Navigate, NavLink, Outlet, useLocation } from 'react-router';
import { Activity, Building2, Globe, KeyRound, ScrollText, Users, UsersRound } from 'lucide-react';
import { EmptyState, cn } from '@forge/ui';
import { useMe } from '../lib/hooks';

const NAV = [
  { to: '/admin', label: 'Overview', icon: Activity, end: true, perm: 'system:read' },
  { to: '/admin/users', label: 'Users', icon: Users, perm: 'users:read' },
  { to: '/admin/groups', label: 'Groups', icon: UsersRound, perm: 'groups:read' },
  { to: '/admin/domains', label: 'Domains', icon: Globe, perm: 'org:read' },
  { to: '/admin/roles', label: 'Roles', icon: KeyRound, perm: 'users:read' },
  { to: '/admin/audit', label: 'Audit log', icon: ScrollText, perm: 'audit:read' },
  { to: '/admin/settings', label: 'Organisation', icon: Building2, perm: 'org:read' },
];

export function AdminLayout() {
  const { data: me } = useMe();
  const { pathname } = useLocation();
  const items = NAV.filter((n) => me?.permissions.includes(n.perm));
  if (me && items.length === 0) {
    return <EmptyState title="No administrative access" description="Ask a global administrator to assign you a role." />;
  }
  // The overview needs system:read; send other administrators to their first section.
  if (me && pathname.replace(/\/$/, '') === '/admin' && !me.permissions.includes('system:read') && items[0]) {
    return <Navigate to={items[0].to} replace />;
  }
  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <nav aria-label="Admin" className="-mx-4 overflow-x-auto px-4 lg:mx-0 lg:w-56 lg:shrink-0 lg:overflow-visible lg:px-0">
        <p className="mb-2 hidden px-3 text-xs font-semibold tracking-wide text-zinc-500 uppercase lg:block">Admin center</p>
        <ul className="flex gap-1 lg:flex-col">
          {items.map(({ to, label, icon: Icon, end }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100',
                    isActive && 'bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-50 dark:ring-zinc-800',
                  )
                }
              >
                <Icon className="size-4" /> {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
