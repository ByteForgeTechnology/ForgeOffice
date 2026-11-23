import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { Alert, Avatar, Badge, Button, Dialog, Input, type Tone } from '@forge/ui';
import { api } from '../lib/api';
import { useDebounced } from '../lib/hooks';
import type { DirectoryCard, UserStatus } from '../lib/types';

export function UserStatusBadge({ status, locked }: { status: UserStatus; locked?: boolean }) {
  if (locked && status === 'active') return <Badge tone="warning">Locked</Badge>;
  const tone: Record<UserStatus, Tone> = { active: 'success', suspended: 'warning', deleted: 'danger' };
  return <Badge tone={tone[status]}>{status[0]!.toUpperCase() + status.slice(1)}</Badge>;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel = 'Confirm',
  danger,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={title}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-zinc-600 dark:text-zinc-400">{children}</div>
    </Dialog>
  );
}

export function TemporaryPasswordDialog({ password, email, onClose }: { password: string | null; email?: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog
      open={!!password}
      onClose={onClose}
      title="Temporary password"
      description={email ? `Share this securely with ${email}. It is shown only once.` : 'Shown only once.'}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex items-center gap-2">
        <code className="flex-1 rounded-lg bg-zinc-100 px-3 py-2 font-mono text-lg tracking-wide dark:bg-zinc-800">{password}</code>
        <Button
          icon={<Copy className="size-4" />}
          onClick={() => {
            void navigator.clipboard?.writeText(password ?? '');
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <Alert tone="info" className="mt-4">
        The user must choose a new password at their next sign-in.
      </Alert>
    </Dialog>
  );
}

/** Type-ahead picker over the organisation directory. */
export function UserPicker({ onPick, exclude = [] }: { onPick: (user: DirectoryCard) => void; exclude?: string[] }) {
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 200);
  const { data } = useQuery({
    queryKey: ['picker', term],
    queryFn: () => api<{ people: DirectoryCard[] }>(`/api/v1/directory/search?q=${encodeURIComponent(term)}&limit=8`),
    enabled: term.length >= 1,
  });
  const people = data?.people.filter((p) => !exclude.includes(p.id)) ?? [];
  return (
    <div>
      <Input placeholder="Search by name or email" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      {term && (
        <ul className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          {people.length === 0 && <li className="px-3 py-2 text-sm text-zinc-500">No matching people</li>}
          {people.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(p);
                  setQ('');
                }}
                className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <Avatar name={p.displayName} src={p.avatarUrl} size="sm" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{p.displayName}</span>
                  <span className="block truncate text-xs text-zinc-500">{p.email}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const PERMISSION_GROUPS: { label: string; prefix: string }[] = [
  { label: 'Organisation', prefix: 'org:' },
  { label: 'Domains', prefix: 'domains:' },
  { label: 'Users', prefix: 'users:' },
  { label: 'Groups', prefix: 'groups:' },
  { label: 'Roles', prefix: 'roles:' },
  { label: 'Audit', prefix: 'audit:' },
  { label: 'System', prefix: 'system:' },
];
