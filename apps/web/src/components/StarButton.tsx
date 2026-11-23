import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Star } from 'lucide-react';
import { cn, useToast } from '@forge/ui';
import { api, errorMessage } from '../lib/api';

/**
 * Star (follow) a document, folder or list item. Changes other people make
 * to starred things are emailed to you.
 */
export function StarButton({ kind, id, starred, name, className, size = 'sm' }: { kind: 'drive_item' | 'list_item'; id: string; starred: boolean; name: string; className?: string; size?: 'sm' | 'md' }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [on, setOn] = useState(starred);
  const [busy, setBusy] = useState(false);
  useEffect(() => setOn(starred), [starred]);
  const toggle = async () => {
    const next = !on;
    setOn(next);
    setBusy(true);
    try {
      await api(`/api/v1/stars/${kind}/${id}`, { method: next ? 'PUT' : 'DELETE' });
      if (next) toast.success(`Starred. You’ll get an email when someone changes “${name}”.`);
      void qc.invalidateQueries({ queryKey: kind === 'drive_item' ? ['drive'] : ['sites', 'list'] });
      void qc.invalidateQueries({ queryKey: ['stars'] });
    } catch (e) {
      setOn(!next);
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? `Unstar ${name}` : `Star ${name}`}
      title={on ? 'Starred: you’ll be emailed about changes. Click to unstar.' : 'Star: get an email when someone changes this'}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        void toggle();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className={cn('shrink-0 rounded p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800', on ? 'text-amber-500' : 'text-zinc-400 hover:text-zinc-600', className)}
    >
      <Star className={cn(size === 'md' ? 'size-5' : 'size-4', on && 'fill-current')} />
    </button>
  );
}
