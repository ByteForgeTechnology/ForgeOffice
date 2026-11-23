import type { ReactNode } from 'react';
import { useBranding } from '../lib/hooks';

/** Centered, branded card used by sign-in, setup and other pre-auth screens. */
export function AuthCard({ title, subtitle, children, wide }: { title: ReactNode; subtitle?: ReactNode; children: ReactNode; wide?: boolean }) {
  const { data: branding } = useBranding();
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className={wide ? 'w-full max-w-2xl' : 'w-full max-w-md'}>
        <div className="mb-6 flex items-center gap-3">
          {branding?.logoUrl ? (
            <img src={branding.logoUrl} alt="" className="size-10 rounded-lg object-contain" />
          ) : (
            <span className="flex size-10 items-center justify-center rounded-lg bg-brand text-lg font-bold text-white">{(branding?.name ?? 'F').slice(0, 1)}</span>
          )}
          <span className="text-lg font-semibold">{branding?.name ?? 'ForgeOffice'}</span>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8 dark:border-zinc-800 dark:bg-zinc-900">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
        <p className="mt-6 text-center text-xs text-zinc-500">ForgeOffice · self-hosted</p>
      </div>
    </div>
  );
}

export function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <ul className="grid grid-cols-2 gap-2 rounded-lg bg-zinc-100 p-4 font-mono text-sm dark:bg-zinc-800">
      {codes.map((c) => (
        <li key={c}>{c}</li>
      ))}
    </ul>
  );
}
