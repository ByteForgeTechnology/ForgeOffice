import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { cn } from './utils';

export type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'forge.theme';
const ThemeContext = createContext<{ preference: ThemePreference; resolved: 'light' | 'dark'; setPreference: (p: ThemePreference) => void } | null>(null);

function readPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPref] = useState<ThemePreference>(readPreference);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', listener);
    return () => mq.removeEventListener('change', listener);
  }, []);

  const resolved = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolved === 'dark');
    document.documentElement.style.colorScheme = resolved;
  }, [resolved]);

  const setPreference = useCallback((p: ThemePreference) => {
    setPref(p);
    try {
      localStorage.setItem(STORAGE_KEY, p);
    } catch {
      /* storage unavailable */
    }
  }, []);

  return <ThemeContext.Provider value={{ preference, resolved, setPreference }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
  return ctx;
}

const OPTIONS = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
] as const;

export function ThemeSwitcher({ className }: { className?: string }) {
  const { preference, setPreference } = useTheme();
  return (
    <div role="radiogroup" aria-label="Theme" className={cn('inline-flex rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800', className)}>
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={preference === value}
          title={label}
          onClick={() => setPreference(value)}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-zinc-600 transition dark:text-zinc-400',
            preference === value && 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-100',
          )}
        >
          <Icon className="size-3.5" aria-hidden />
          {label}
        </button>
      ))}
    </div>
  );
}
