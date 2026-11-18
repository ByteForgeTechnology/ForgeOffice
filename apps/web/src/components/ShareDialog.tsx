import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Trash2, Users } from 'lucide-react';
import { Alert, Avatar, Button, Dialog, Field, PageSpinner, Select, useToast } from '@forge/ui';
import { api, errorMessage } from '../lib/api';
import { UserPicker } from './admin';

export interface ShareGrant {
  principalType: 'user' | 'group';
  principalId: string;
  name: string;
  email: string | null;
  access: string;
}

export interface AccessLevel {
  value: string;
  label: string;
  description: string;
}

interface DirectoryGroup {
  id: string;
  name: string;
  type: string;
}

/**
 * Pick people or groups and an access level for each. Used for mail folders,
 * calendars and address books; the caller supplies how to load and save.
 */
export function ShareDialog({
  title,
  description,
  levels,
  load,
  save,
  onClose,
}: {
  title: string;
  description?: string;
  levels: AccessLevel[];
  load: () => Promise<ShareGrant[]>;
  save: (grants: ShareGrant[]) => Promise<unknown>;
  onClose: () => void;
}) {
  const toast = useToast();
  const [grants, setGrants] = useState<ShareGrant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Security groups from the directory (available to everyone, not only admins).
  const [groupQuery, setGroupQuery] = useState('');
  const groups = useQuery({
    queryKey: ['share', 'groups', groupQuery],
    queryFn: () => api<{ groups: DirectoryGroup[] }>(`/api/v1/directory/search?q=${encodeURIComponent(groupQuery || '%')}&limit=20`),
    enabled: groupQuery.length >= 1,
  });

  useEffect(() => {
    load()
      .then(setGrants)
      .catch((e) => setError(errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const add = (g: Omit<ShareGrant, 'access'>) => {
    if (grants?.some((x) => x.principalType === g.principalType && x.principalId === g.principalId)) return;
    setGrants((x) => [...(x ?? []), { ...g, access: levels[0]!.value }]);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await save(grants ?? []);
      toast.success('Sharing updated');
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={title}
      description={description}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!grants} onClick={() => void submit()}>
            Save
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      {!grants ? (
        <PageSpinner />
      ) : (
        <div className="space-y-5">
          {grants.length === 0 ? (
            <p className="text-sm text-zinc-500">Not shared with anyone.</p>
          ) : (
            <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
              {grants.map((g, i) => (
                <li key={`${g.principalType}-${g.principalId}`} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  {g.principalType === 'user' ? (
                    <Avatar name={g.name} size="sm" />
                  ) : (
                    <span className="flex size-7 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800">
                      <Users className="size-3.5" />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{g.name}</p>
                    <p className="truncate text-xs text-zinc-500">{g.principalType === 'group' ? 'Group' : g.email}</p>
                  </div>
                  <Select aria-label={`Access for ${g.name}`} value={g.access} onChange={(e) => setGrants((x) => x!.map((y, j) => (j === i ? { ...y, access: e.target.value } : y)))} className="h-8 w-40 py-0">
                    {levels.map((l) => (
                      <option key={l.value} value={l.value}>
                        {l.label}
                      </option>
                    ))}
                  </Select>
                  <Button size="sm" variant="ghost" aria-label={`Stop sharing with ${g.name}`} onClick={() => setGrants((x) => x!.filter((_, j) => j !== i))}>
                    <Trash2 className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <dl className="grid gap-x-4 gap-y-0.5 text-xs text-zinc-500 sm:grid-cols-[auto_1fr]">
            {levels.map((l) => (
              <div key={l.value} className="contents">
                <dt className="font-medium">{l.label}</dt>
                <dd>{l.description}</dd>
              </div>
            ))}
          </dl>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Add a person">
              <UserPicker exclude={grants.filter((g) => g.principalType === 'user').map((g) => g.principalId)} onPick={(u) => add({ principalType: 'user', principalId: u.id, name: u.displayName, email: u.email })} />
            </Field>
            <Field label="Add a group" hint="Type to search security groups.">
              <input
                className="block h-10 w-full rounded-lg border-0 bg-white px-3 text-sm ring-1 ring-zinc-300 ring-inset focus:ring-2 focus:ring-brand dark:bg-zinc-900 dark:ring-zinc-700"
                placeholder="Group name"
                value={groupQuery}
                onChange={(e) => setGroupQuery(e.target.value)}
              />
              {groupQuery && (
                <ul className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
                  {(groups.data?.groups ?? [])
                    .filter((g) => g.type === 'security')
                    .map((g) => (
                      <li key={g.id}>
                        <button
                          type="button"
                          className="w-full px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                          onClick={() => {
                            add({ principalType: 'group', principalId: g.id, name: g.name, email: null });
                            setGroupQuery('');
                          }}
                        >
                          {g.name}
                        </button>
                      </li>
                    ))}
                </ul>
              )}
            </Field>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Helpers to adapt each API's grant shape to ShareGrant. */
export const toGrants = (items: { principalType: 'user' | 'group'; principalId: string; name: string; email: string | null; access: string }[]): ShareGrant[] =>
  items.map(({ principalType, principalId, name, email, access }) => ({ principalType, principalId, name, email, access }));
