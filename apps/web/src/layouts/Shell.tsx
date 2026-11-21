import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { LogOut, Search, Settings2, ShieldCheck, UserCircle2, Users } from 'lucide-react';
import { AppLauncher, Avatar, ThemeSwitcher, cn } from '@forge/ui';
import { api } from '../lib/api';
import { launcherApps } from '../lib/apps';
import { useAuth } from '../lib/auth';
import { useBranding, useDebounced, useFeatures, useMe } from '../lib/hooks';
import { appForPath } from '../lib/web-app';
import { FeatureOff } from '../components/FeatureOff';
import { disconnectSocket } from '../lib/realtime';
import type { DirectoryCard, Group } from '../lib/types';

export function Shell() {
  const navigate = useNavigate();
  const { data: branding } = useBranding();
  const { data: me } = useMe();
  const isAdmin = (me?.permissions.length ?? 0) > 0;
  const features = useFeatures();
  const { pathname } = useLocation();
  // Mail and Calendar use the full viewport height with their own panes.
  const fullBleed = pathname === '/mail' || pathname === '/calendar' || pathname === '/tasks';

  return (
    <div className={cn('flex flex-col', fullBleed ? 'h-dvh overflow-hidden' : 'min-h-screen')}>
      <header className="sticky top-0 z-30 bg-brand text-white shadow-sm">
        <div className="mx-auto flex h-14 max-w-screen-2xl items-center gap-2 px-3 sm:gap-3 sm:px-4">
          <AppLauncher apps={launcherApps(isAdmin, features)} onNavigate={(href) => navigate(href)} />
          <Link to="/" className="flex min-w-0 items-center gap-2 font-semibold">
            {branding?.logoUrl ? (
              <img src={branding.logoUrl} alt="" className="size-7 rounded-md bg-white object-contain p-0.5" />
            ) : (
              <span className="flex size-7 items-center justify-center rounded-md bg-white/20 text-sm">{branding?.name.slice(0, 1) ?? 'F'}</span>
            )}
            <span className="hidden truncate sm:inline">{branding?.name ?? 'ForgeOffice'}</span>
          </Link>
          <GlobalSearch />
          {isAdmin && (
            <NavLink
              to="/admin"
              className={({ isActive }) => cn('hidden items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium hover:bg-white/15 md:flex', isActive && 'bg-white/15')}
            >
              <Settings2 className="size-4" /> Admin
            </NavLink>
          )}
          <UserMenu />
        </div>
      </header>
      {fullBleed ? (
        <main className="min-h-0 flex-1">
          <FeatureGate />
        </main>
      ) : (
        <main className="mx-auto w-full max-w-screen-2xl flex-1 px-4 py-6 sm:px-6">
          <FeatureGate />
        </main>
      )}
    </div>
  );
}

/** An app whose product an administrator has switched off shows a notice instead. */
function FeatureGate() {
  const { pathname } = useLocation();
  const features = useFeatures();
  const app = appForPath(pathname);
  const feature = app === 'contacts' ? 'contacts' : app === 'mail' || app === 'calendar' || app === 'tasks' ? app : null;
  if (feature && !features[feature]) return <FeatureOff feature={feature} />;
  return <Outlet />;
}

/** Federated search box. Phase 1 searches the directory (people & groups). */
function GlobalSearch() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [open, setOpen] = useState(false);
  const debounced = useDebounced(q.trim(), 200);
  const box = useRef<HTMLDivElement>(null);
  const { data } = useQuery({
    queryKey: ['search', 'quick', debounced],
    queryFn: () => api<{ people: DirectoryCard[]; groups: Group[] }>(`/api/v1/directory/search?q=${encodeURIComponent(debounced)}&limit=5`),
    enabled: debounced.length >= 2,
  });

  useEffect(() => {
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    setOpen(false);
    navigate(`/search?q=${encodeURIComponent(q.trim())}`);
  };

  const results = debounced.length >= 2 && data && (data.people.length > 0 || data.groups.length > 0);

  return (
    <div ref={box} className="relative mx-auto w-full max-w-xl min-w-0 flex-1">
      <form role="search" onSubmit={submit}>
        <label htmlFor="global-search" className="sr-only">
          Search
        </label>
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-white/70" aria-hidden />
        <input
          id="global-search"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Search people and groups"
          autoComplete="off"
          className="h-9 w-full rounded-lg border-0 bg-white/15 pr-3 pl-9 text-sm text-white placeholder:text-white/70 focus:bg-white focus:text-zinc-900 focus:ring-0 focus:placeholder:text-zinc-400"
        />
      </form>
      {open && results && (
        <div className="absolute inset-x-0 top-11 z-40 overflow-hidden rounded-xl border border-zinc-200 bg-white text-zinc-900 shadow-xl dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100">
          {data.people.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                setOpen(false);
                navigate(`/search?q=${encodeURIComponent(p.displayName)}`);
              }}
              className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <Avatar name={p.displayName} size="sm" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{p.displayName}</span>
                <span className="block truncate text-xs text-zinc-500">{p.jobTitle ?? p.email}</span>
              </span>
            </button>
          ))}
          {data.groups.map((g) => (
            <button
              key={g.id}
              onClick={() => {
                setOpen(false);
                navigate(`/search?q=${encodeURIComponent(g.name)}`);
              }}
              className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <span className="flex size-7 items-center justify-center rounded-full bg-zinc-200 dark:bg-zinc-700">
                <Users className="size-3.5" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{g.name}</span>
                <span className="block truncate text-xs text-zinc-500">{g.email ?? (g.type === 'security' ? 'Security group' : 'Distribution list')}</span>
              </span>
            </button>
          ))}
          <button onClick={submit} className="w-full border-t border-zinc-200 px-3 py-2 text-left text-sm text-brand hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800">
            See all results for “{q.trim()}”
          </button>
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { data: me } = useMe();
  const { signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const name = me?.user.displayName ?? '…';
  const isAdmin = (me?.permissions.length ?? 0) > 0;

  return (
    <div ref={ref} className="relative">
      <button type="button" aria-label="Account menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="rounded-full ring-2 ring-white/30 hover:ring-white/60">
        <Avatar name={name} size="sm" />
      </button>
      {open && (
        <div className="absolute top-11 right-0 z-40 w-72 rounded-xl border border-zinc-200 bg-white p-2 text-zinc-900 shadow-xl dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100">
          <div className="flex items-center gap-3 px-2 py-2">
            <Avatar name={name} />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{name}</p>
              <p className="truncate text-xs text-zinc-500">{me?.user.email}</p>
            </div>
          </div>
          <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
          <MenuLink to="/account" icon={<UserCircle2 className="size-4" />} onClick={() => setOpen(false)}>
            Account settings
          </MenuLink>
          <MenuLink to="/account#security" icon={<ShieldCheck className="size-4" />} onClick={() => setOpen(false)}>
            Security & sign-in
          </MenuLink>
          {isAdmin && (
            <MenuLink to="/admin" icon={<Settings2 className="size-4" />} onClick={() => setOpen(false)}>
              Admin center
            </MenuLink>
          )}
          <div className="px-2 py-2">
            <ThemeSwitcher />
          </div>
          <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
          <button
            onClick={() => {
              disconnectSocket();
              void signOut();
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <LogOut className="size-4" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function MenuLink({ to, icon, children, onClick }: { to: string; icon: React.ReactNode; children: React.ReactNode; onClick: () => void }) {
  return (
    <Link to={to} onClick={onClick} className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
      {icon}
      {children}
    </Link>
  );
}
