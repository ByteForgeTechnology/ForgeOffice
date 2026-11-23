import { Fragment, type ReactNode } from 'react';

/**
 * Markdown for chat messages, rendered straight to React elements (no HTML
 * strings, so nothing in a message can inject markup): code blocks, inline
 * code, **bold**, *italic*, ~~strike~~, [links](https://…), bare URLs,
 * > quotes, - and 1. lists, and mentions written as <@user-id>.
 */

export type MentionNames = Record<string, string>;

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

type Inline = { re: RegExp; render: (m: RegExpExecArray, key: string, names: MentionNames, me: string | null) => ReactNode };

const INLINE: Inline[] = [
  { re: /`([^`\n]+)`/, render: (m, k) => <code key={k} className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.85em] dark:bg-zinc-800">{m[1]}</code> },
  {
    re: /<@([0-9a-f-]{36})>/i,
    render: (m, k, names, me) => (
      <span key={k} className={m[1] === me ? 'rounded bg-amber-100 px-0.5 font-medium text-amber-900 dark:bg-amber-900/40 dark:text-amber-200' : 'font-medium text-brand'}>
        @{names[m[1]!.toLowerCase()] ?? 'someone'}
      </span>
    ),
  },
  {
    re: /\[([^\]\n]+)\]\(([^)\s]+)\)/,
    render: (m, k, names, me) =>
      SAFE_URL.test(m[2]!) ? (
        <a key={k} href={m[2]} target="_blank" rel="noopener noreferrer" className="text-brand underline">
          {inline(m[1]!, names, me, k)}
        </a>
      ) : (
        <Fragment key={k}>{m[0]}</Fragment>
      ),
  },
  {
    re: /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/,
    render: (m, k) => (
      <a key={k} href={m[1]} target="_blank" rel="noopener noreferrer" className="break-all text-brand underline">
        {m[1]}
      </a>
    ),
  },
  { re: /\*\*([^*\n]+)\*\*/, render: (m, k, n, me) => <strong key={k}>{inline(m[1]!, n, me, k)}</strong> },
  { re: /~~([^~\n]+)~~/, render: (m, k, n, me) => <s key={k}>{inline(m[1]!, n, me, k)}</s> },
  { re: /(?<![\w*])\*([^*\n]+)\*(?![\w*])/, render: (m, k, n, me) => <em key={k}>{inline(m[1]!, n, me, k)}</em> },
  { re: /(?<!\w)_([^_\n]+)_(?!\w)/, render: (m, k, n, me) => <em key={k}>{inline(m[1]!, n, me, k)}</em> },
];

/** Inline formatting: the earliest match wins, then the rest of the text. */
export function inline(text: string, names: MentionNames, me: string | null, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  while (rest) {
    let best: { m: RegExpExecArray; rule: Inline } | null = null;
    for (const rule of INLINE) {
      const m = rule.re.exec(rest);
      if (m && (!best || m.index < best.m.index)) best = { m, rule };
    }
    if (!best) {
      out.push(rest);
      break;
    }
    if (best.m.index > 0) out.push(rest.slice(0, best.m.index));
    out.push(best.rule.render(best.m, `${keyPrefix}.${n++}`, names, me));
    rest = rest.slice(best.m.index + best.m[0].length);
  }
  return out;
}

const withBreaks = (lines: string[], names: MentionNames, me: string | null, key: string) =>
  lines.flatMap((l, i) => [...(i ? [<br key={`${key}br${i}`} />] : []), ...inline(l, names, me, `${key}l${i}`)]);

export function Markdown({ text, names, me }: { text: string; names: MentionNames; me: string | null }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const key = `b${k++}`;
    const fence = /^```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) code.push(lines[i++]!);
      i++;
      blocks.push(
        <pre key={key} className="my-1 overflow-x-auto rounded-lg bg-zinc-900 p-3 font-mono text-xs leading-relaxed text-zinc-100" data-lang={fence[1] || undefined}>
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) quote.push(lines[i++]!.replace(/^>\s?/, ''));
      blocks.push(
        <blockquote key={key} className="my-1 border-l-4 border-zinc-300 pl-3 text-zinc-600 dark:border-zinc-600 dark:text-zinc-400">
          {withBreaks(quote, names, me, key)}
        </blockquote>,
      );
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      const re = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/;
      while (i < lines.length && re.test(lines[i]!)) items.push(lines[i++]!.replace(re, ''));
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(
        <Tag key={key} className={`my-1 pl-5 ${ordered ? 'list-decimal' : 'list-disc'}`}>
          {items.map((it, n) => (
            <li key={n}>{inline(it, names, me, `${key}.${n}`)}</li>
          ))}
        </Tag>,
      );
      continue;
    }
    // A paragraph: lines until a blank line or another block.
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && !/^```/.test(lines[i]!) && !/^>\s?/.test(lines[i]!) && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i]!)) para.push(lines[i++]!);
    if (para.length) blocks.push(<p key={key} className="my-0.5 whitespace-pre-wrap break-words">{withBreaks(para, names, me, key)}</p>);
    else i++;
  }
  return <div className="text-sm leading-relaxed">{blocks}</div>;
}

/** Plain text for notifications and previews: formatting and mentions spelled out. */
export function plainText(text: string, names: MentionNames) {
  return text
    .replace(/<@([0-9a-f-]{36})>/gi, (_, id: string) => `@${names[id.toLowerCase()] ?? 'someone'}`)
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/[*_~`>#]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
