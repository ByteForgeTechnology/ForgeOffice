import { Monitor, Smartphone } from 'lucide-react';
import { Badge, Button, formatDateTime, formatRelative } from '@forge/ui';

export interface DeviceSession {
  id: string;
  current?: boolean;
  browser: string;
  os: string;
  mobile: boolean;
  ip: string | null;
  signedInAt: string;
  lastActiveAt: string;
  expiresAt: string;
  apps: string[];
}

/** A list of signed-in browsers/devices, with an optional "Sign out" per device. */
export function DeviceList({ items, onSignOut, busyId }: { items: DeviceSession[]; onSignOut?: (s: DeviceSession) => void; busyId?: string | null }) {
  if (!items.length) return <p className="text-sm text-zinc-500">Not signed in anywhere.</p>;
  return (
    <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
      {items.map((s) => (
        <li key={s.id} className="flex items-start gap-3 py-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 dark:bg-zinc-800">
            {s.mobile ? <Smartphone className="size-4" /> : <Monitor className="size-4" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
              {s.browser} on {s.os} {s.current && <Badge tone="success">This device</Badge>}
            </p>
            <p className="text-xs text-zinc-500">
              {[s.ip, s.current ? 'Active now' : `Last active ${formatRelative(s.lastActiveAt)}`, `signed in ${formatDateTime(s.signedInAt)}`].filter(Boolean).join(' · ')}
            </p>
            <p className="text-xs text-zinc-500">
              {s.apps.join(', ')} · must sign in again by {formatDateTime(s.expiresAt)}
            </p>
          </div>
          {onSignOut && (
            <Button size="sm" variant="ghost" loading={busyId === s.id} onClick={() => onSignOut(s)}>
              Sign out
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
