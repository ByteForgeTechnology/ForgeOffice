import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { Grip } from 'lucide-react';
import { cn } from './utils';

export interface LauncherApp {
  id: string;
  name: string;
  description: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
  /** Tailwind background class for the tile. */
  color: string;
  available: boolean;
  badge?: ReactNode;
}

/** The "waffle" menu: a grid of every ForgeOffice app. */
export function AppLauncher({ apps, onNavigate }: { apps: LauncherApp[]; onNavigate: (href: string) => void }) {
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

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="App launcher"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex size-9 items-center justify-center rounded-lg text-white/90 hover:bg-white/15"
      >
        <Grip className="size-5" />
      </button>
      {open && (
        <div className="absolute top-11 left-0 z-40 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-zinc-200 bg-white p-3 shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
          <p className="px-2 pb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Apps</p>
          <div className="grid grid-cols-3 gap-1">
            {apps.map((app) => (
              <button
                key={app.id}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onNavigate(app.href);
                }}
                className="group flex flex-col items-center gap-1.5 rounded-lg p-2 text-center hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <span className={cn('flex size-11 items-center justify-center rounded-xl text-white', app.color, !app.available && 'opacity-60')}>
                  <app.icon className="size-5" />
                </span>
                <span className="text-xs font-medium text-zinc-800 dark:text-zinc-200">{app.name}</span>
                {app.badge}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
