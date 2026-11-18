import type { FilterAction, FilterCondition, MailFilter } from '@forge/db';
import type { IndexedMessage } from './ingest';

function fieldText(c: FilterCondition, msg: IndexedMessage): string {
  const addr = (list: { name: string; address: string }[]) => list.map((a) => `${a.name} <${a.address}>`).join(', ');
  switch (c.field) {
    case 'from':
      return msg.from ? addr([msg.from]) : '';
    case 'to':
      return addr(msg.to);
    case 'cc':
      return addr(msg.cc);
    case 'subject':
      return msg.subject;
    case 'body':
      return msg.bodyText;
    case 'header':
      return (msg.headers.get((c.header ?? '').toLowerCase()) ?? []).join('\n');
    default:
      return '';
  }
}

export function conditionMatches(c: FilterCondition, msg: IndexedMessage, size: number): boolean {
  if (c.field === 'hasAttachment') return msg.attachments.some((a) => !a.inline);
  if (c.field === 'size') {
    const limit = Number(c.value ?? 0);
    return c.op === 'lessThan' ? size < limit : size > limit;
  }
  const hay = fieldText(c, msg).toLowerCase();
  const needle = (c.value ?? '').toLowerCase();
  switch (c.op) {
    case 'contains':
      return hay.includes(needle);
    case 'notContains':
      return !hay.includes(needle);
    case 'equals':
      return hay.trim() === needle.trim();
    case 'startsWith':
      return hay.startsWith(needle);
    case 'endsWith':
      return hay.trimEnd().endsWith(needle);
    case 'matches':
      try {
        return new RegExp(c.value ?? '', 'i').test(fieldText(c, msg));
      } catch {
        return false;
      }
    default:
      return false;
  }
}

/** Run the user's server-side rules in order and collect actions. */
export function evaluateFilters(filters: MailFilter[], msg: IndexedMessage, size: number): FilterAction[] {
  const actions: FilterAction[] = [];
  for (const f of [...filters].sort((a, b) => a.position - b.position)) {
    if (!f.enabled || !f.conditions.length) continue;
    const results = f.conditions.map((c) => conditionMatches(c, msg, size));
    const hit = f.match === 'any' ? results.some(Boolean) : results.every(Boolean);
    if (!hit) continue;
    actions.push(...f.actions.filter((a) => a.type !== 'stop'));
    if (f.actions.some((a) => a.type === 'stop')) break;
  }
  return actions;
}
