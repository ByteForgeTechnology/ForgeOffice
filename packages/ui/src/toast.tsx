import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CheckCircle2, X, XCircle } from 'lucide-react';
import { cn } from './utils';

interface Toast {
  id: number;
  tone: 'success' | 'error';
  message: ReactNode;
}

const ToastContext = createContext<{ success: (m: ReactNode) => void; error: (m: ReactNode) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (tone: Toast['tone'], message: ReactNode) => {
      const id = Date.now() + Math.random();
      setToasts((t) => [...t.slice(-3), { id, tone, message }]);
      setTimeout(() => dismiss(id), tone === 'error' ? 8000 : 4000);
    },
    [dismiss],
  );
  const api = { success: (m: ReactNode) => push('success', m), error: (m: ReactNode) => push('error', m) };
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-2 sm:inset-x-auto sm:right-4">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border bg-white p-3 text-sm shadow-lg dark:bg-zinc-900',
              t.tone === 'success' ? 'border-emerald-200 dark:border-emerald-900' : 'border-red-200 dark:border-red-900',
            )}
          >
            {t.tone === 'success' ? <CheckCircle2 className="size-4 shrink-0 text-emerald-600" /> : <XCircle className="size-4 shrink-0 text-red-600" />}
            <div className="min-w-0 flex-1 text-zinc-800 dark:text-zinc-200">{t.message}</div>
            <button onClick={() => dismiss(t.id)} className="text-zinc-400 hover:text-zinc-600" aria-label="Dismiss">
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}
