import { forwardRef, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from 'lucide-react';
import { cn, initials } from './utils';

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md';

const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-white shadow-sm hover:brightness-110 disabled:hover:brightness-100',
  secondary:
    'bg-white text-zinc-900 ring-1 ring-inset ring-zinc-300 shadow-sm hover:bg-zinc-50 dark:bg-zinc-800 dark:text-zinc-100 dark:ring-zinc-700 dark:hover:bg-zinc-700',
  ghost: 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800',
  danger: 'bg-red-600 text-white shadow-sm hover:bg-red-500',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-3 text-sm' : 'h-10 px-4 text-sm',
        buttonVariants[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

const controlBase =
  'block w-full rounded-lg border-0 bg-white px-3 text-sm text-zinc-900 ring-1 ring-inset ring-zinc-300 placeholder:text-zinc-400 focus:ring-2 focus:ring-inset focus:ring-brand disabled:opacity-60 dark:bg-zinc-900 dark:text-zinc-100 dark:ring-zinc-700 dark:placeholder:text-zinc-500';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input(
  { className, invalid, ...rest },
  ref,
) {
  return <input ref={ref} className={cn(controlBase, 'h-10', invalid && 'ring-red-500 dark:ring-red-500', className)} aria-invalid={invalid || undefined} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(controlBase, 'min-h-20 py-2', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cn(controlBase, 'h-10 pr-8', className)} {...rest}>
      {children}
    </select>
  );
});

export function Field({
  label,
  hint,
  error,
  children,
  className,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
        {label}
      </label>
      {children}
      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : hint ? <p className="text-sm text-zinc-500 dark:text-zinc-400">{hint}</p> : null}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <label htmlFor={id} className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
          {label}
        </label>
        {description && <p className="text-sm text-zinc-500 dark:text-zinc-400">{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 rounded-full transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50',
          checked ? 'bg-brand' : 'bg-zinc-300 dark:bg-zinc-700',
        )}
      >
        <span className={cn('absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition', checked && 'translate-x-5')} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout & display
// ---------------------------------------------------------------------------

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cn('rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900', className)}>{children}</section>;
}

export function CardHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('px-5 py-4', className)}>{children}</div>;
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{title}</h1>
        {description && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'brand';

const toneClasses: Record<Tone, string> = {
  neutral: 'bg-zinc-100 text-zinc-700 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700',
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900',
  warning: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900',
  danger: 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-950 dark:text-red-300 dark:ring-red-900',
  info: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950 dark:text-sky-300 dark:ring-sky-900',
  brand: 'bg-brand/10 text-brand ring-brand/30',
};

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset', toneClasses[tone], className)}>{children}</span>;
}

const dotClasses: Record<Tone, string> = {
  neutral: 'bg-zinc-400',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
  info: 'bg-sky-500',
  brand: 'bg-brand',
};

export function StatusDot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return (
    <span className="relative inline-flex size-2.5">
      {pulse && <span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', dotClasses[tone])} />}
      <span className={cn('relative inline-flex size-2.5 rounded-full', dotClasses[tone])} />
    </span>
  );
}

const AVATAR_COLORS = ['bg-rose-500', 'bg-orange-500', 'bg-amber-500', 'bg-emerald-500', 'bg-teal-500', 'bg-sky-500', 'bg-indigo-500', 'bg-violet-500', 'bg-fuchsia-500'];

/** A person's picture, or their initials on a colour from their name (also when the picture can't load). */
export function Avatar({ name, size = 'md', className, src }: { name: string; size?: 'sm' | 'md' | 'lg' | 'xl'; className?: string; src?: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const box = size === 'sm' ? 'size-7 text-xs' : size === 'lg' ? 'size-14 text-lg' : size === 'xl' ? 'size-24 text-3xl' : 'size-9 text-sm';
  if (src && failed !== src)
    return <img src={src} alt="" aria-hidden onError={() => setFailed(src)} className={cn('inline-block shrink-0 rounded-full bg-zinc-200 object-cover dark:bg-zinc-700', box, className)} />;
  return (
    <span aria-hidden className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white', AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length], box, className)}>
      {initials(name)}
    </span>
  );
}

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <span role="status" className={cn('inline-flex items-center gap-2 text-sm text-zinc-500', className)}>
      <Loader2 className="size-4 animate-spin" aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function PageSpinner() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <Spinner className="[&_svg]:size-6" />
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {icon && <div className="mb-3 text-zinc-400 [&_svg]:size-8">{icon}</div>}
      <p className="font-medium text-zinc-900 dark:text-zinc-100">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

const alertIcons = { info: Info, success: CheckCircle2, warning: AlertTriangle, danger: XCircle } as const;

export function Alert({ tone = 'info', title, children, className }: { tone?: keyof typeof alertIcons; title?: ReactNode; children?: ReactNode; className?: string }) {
  const Icon = alertIcons[tone];
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cn('flex gap-3 rounded-lg p-3 text-sm ring-1 ring-inset', toneClasses[tone], className)}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className="opacity-90">{children}</div>}
      </div>
    </div>
  );
}

export function ProgressBar({ value, tone }: { value: number; tone?: Tone }) {
  const pct = Math.max(0, Math.min(100, value));
  const auto: Tone = tone ?? (pct > 90 ? 'danger' : pct > 75 ? 'warning' : 'brand');
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn('h-full rounded-full transition-all', dotClasses[auto])} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full min-w-full text-left text-sm">{children}</table>
    </div>
  );
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return <th className={cn('border-b border-zinc-200 px-4 py-2.5 text-xs font-medium tracking-wide text-zinc-500 uppercase dark:border-zinc-800 dark:text-zinc-400', className)}>{children}</th>;
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cn('border-b border-zinc-100 px-4 py-3 align-middle text-zinc-700 dark:border-zinc-800/70 dark:text-zinc-300', className)}>{children}</td>;
}

// ---------------------------------------------------------------------------
// Dialog (native <dialog> for focus trapping and Esc handling)
// ---------------------------------------------------------------------------

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={cn(
        'm-auto w-[calc(100%-2rem)] rounded-xl border border-zinc-200 bg-white p-0 text-zinc-900 shadow-xl backdrop:bg-zinc-950/50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100',
        size === 'sm' ? 'max-w-sm' : size === 'lg' ? 'max-w-2xl' : 'max-w-lg',
      )}
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <header className="flex items-start justify-between gap-4 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
            <div>
              <h2 className="text-base font-semibold">{title}</h2>
              {description && <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">{description}</p>}
            </div>
            <button type="button" onClick={onClose} className="rounded-md p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label="Close">
              <X className="size-4" />
            </button>
          </header>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}
