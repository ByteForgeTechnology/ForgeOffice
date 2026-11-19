import { useEffect, useState } from 'react';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router';
import {
  Activity,
  Ban,
  Building2,
  ChevronDown,
  DoorOpen,
  FolderOpen,
  Globe,
  Inbox,
  KeyRound,
  Mail,
  MessagesSquare,
  Route,
  ScrollText,
  Settings2,
  ShieldCheck,
  Signature,
  Users,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import { EmptyState, cn } from '@forge/ui';
import { useMe } from '../lib/hooks';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  perm: string;
  end?: boolean;
}
interface NavSection {
  title: string | null;
  items: NavItem[];
  /** Products not built yet: listed, but not links. */
  comingSoon?: string;
}

/** Admin pages grouped by product, then organisation-wide settings. */
export const ADMIN_NAV: NavSection[] = [
  {
    title: null,
    items: [
      {
        to: '/admin',
        label: 'Overview',
        icon: Activity,
        end: true,
        perm: 'system:read',
      },
    ],
  },
  {
    title: 'ForgeDirectory',
    items: [
      {
        to: '/admin/directory/users',
        label: 'Users',
        icon: Users,
        perm: 'users:read',
      },
      {
        to: '/admin/directory/groups',
        label: 'Groups',
        icon: UsersRound,
        perm: 'groups:read',
      },
      {
        to: '/admin/directory/roles',
        label: 'Roles',
        icon: KeyRound,
        perm: 'users:read',
      },
      {
        to: '/admin/directory/security',
        label: 'Sign-in & security',
        icon: ShieldCheck,
        perm: 'org:read',
      },
    ],
  },
  {
    title: 'ForgeMail',
    items: [
      {
        to: '/admin/mail/shared-mailboxes',
        label: 'Shared mailboxes',
        icon: Inbox,
        perm: 'users:read',
      },
      {
        to: '/admin/mail/flow',
        label: 'Mail flow',
        icon: Mail,
        perm: 'system:read',
      },
      {
        to: '/admin/mail/transport-rules',
        label: 'Transport rules',
        icon: Route,
        perm: 'system:read',
      },
      {
        to: '/admin/mail/sender-lists',
        label: 'Blocked & allowed',
        icon: Ban,
        perm: 'system:read',
      },
      {
        to: '/admin/mail/signatures',
        label: 'Signatures',
        icon: Signature,
        perm: 'system:read',
      },
      {
        to: '/admin/mail/settings',
        label: 'Mail settings',
        icon: Settings2,
        perm: 'org:read',
      },
    ],
  },
  {
    title: 'ForgeCalendar',
    items: [
      {
        to: '/admin/calendar/rooms',
        label: 'Rooms & resources',
        icon: DoorOpen,
        perm: 'org:read',
      },
    ],
  },
  {
    title: 'ForgeDrive',
    items: [
      {
        to: '',
        label: 'Coming in phase 3',
        icon: FolderOpen,
        perm: 'system:read',
      },
    ],
    comingSoon: 'phase 3',
  },
  {
    title: 'ForgeTeam',
    items: [
      {
        to: '',
        label: 'Coming in phase 4',
        icon: MessagesSquare,
        perm: 'system:read',
      },
    ],
    comingSoon: 'phase 4',
  },
  {
    title: 'Organisation',
    items: [
      {
        to: '/admin/organisation/settings',
        label: 'Settings',
        icon: Building2,
        perm: 'org:read',
      },
      {
        to: '/admin/organisation/domains',
        label: 'Domains',
        icon: Globe,
        perm: 'org:read',
      },
      {
        to: '/admin/organisation/audit',
        label: 'Audit log',
        icon: ScrollText,
        perm: 'audit:read',
      },
    ],
  },
];

const linkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100',
    isActive && 'bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-50 dark:ring-zinc-800',
  );

const EXPANDED_KEY = 'forge.admin.expanded';

/** Open sections (all collapsed by default), remembered in this browser; storage may be unavailable. */
function useExpanded() {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const update = (next: Set<string>) => {
    setExpanded(next);
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
    } catch {
      /* not remembered */
    }
  };
  const toggle = (title: string) => {
    const next = new Set(expanded);
    if (!next.delete(title)) next.add(title);
    update(next);
  };
  const expand = (title: string) => !expanded.has(title) && update(new Set([...expanded, title]));
  return { expanded, toggle, expand };
}

export function AdminLayout() {
  const { data: me } = useMe();
  const { pathname } = useLocation();
  const can = (perm: string) => !!me?.permissions.includes(perm);
  const sections = ADMIN_NAV.map((s) => ({
    ...s,
    items: s.items.filter((i) => can(i.perm)),
  })).filter((s) => s.items.length);
  const links = sections.filter((s) => !s.comingSoon).flatMap((s) => s.items);
  const { expanded, toggle, expand } = useExpanded();
  // Always show the section of the page you are on (e.g. after following a link into it).
  const current = sections.find((s) => s.title && s.items.some((i) => i.to && (pathname === i.to || pathname.startsWith(`${i.to}/`))))?.title;
  useEffect(() => {
    if (current) expand(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);
  if (me && links.length === 0) {
    return <EmptyState title="No administrative access" description="Ask a global administrator to assign you a role." />;
  }
  // The overview needs system:read; send other administrators to their first section.
  if (me && pathname.replace(/\/$/, '') === '/admin' && !can('system:read') && links[0]) {
    return <Navigate to={links[0].to} replace />;
  }
  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <nav aria-label="Admin" className="-mx-4 overflow-x-auto px-4 lg:mx-0 lg:w-56 lg:shrink-0 lg:overflow-visible lg:px-0">
        <p className="mb-2 hidden px-3 text-xs font-semibold tracking-wide text-zinc-500 uppercase lg:block">Admin center</p>
        <div className="flex gap-4 lg:flex-col lg:gap-5">
          {sections.map((s) => {
            const open = !s.title || expanded.has(s.title);
            const id = `admin-nav-${(s.title ?? 'top').toLowerCase()}`;
            return (
              <div key={s.title ?? 'top'} role="group" aria-label={s.title ?? 'Overview'} className="flex shrink-0 items-center gap-1 lg:block">
                {s.title && (
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={id}
                    onClick={() => toggle(s.title!)}
                    className="group mb-1 flex w-full items-center gap-1 rounded-md px-3 py-0.5 text-left text-xs font-semibold whitespace-nowrap text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-300"
                  >
                    <span className="flex-1">{s.title}</span>
                    <ChevronDown className={cn('size-3.5 transition-transform', !open && '-rotate-90')} />
                  </button>
                )}
                <ul id={id} hidden={!open} className="flex gap-1 lg:flex-col">
                  {s.comingSoon ? (
                    <li className="flex items-center gap-2.5 px-3 py-1 text-xs whitespace-nowrap text-zinc-400 dark:text-zinc-600">Coming in {s.comingSoon}</li>
                  ) : (
                    s.items.map(({ to, label, icon: Icon, end }) => (
                      <li key={to}>
                        <NavLink to={to} end={end} className={linkClass}>
                          <Icon className="size-4" /> {label}
                        </NavLink>
                      </li>
                    ))
                  )}
                </ul>
              </div>
            );
          })}
        </div>
      </nav>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
