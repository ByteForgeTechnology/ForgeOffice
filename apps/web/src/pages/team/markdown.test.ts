import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { Markdown, plainText } from './markdown';

const id = '0b3c1f6e-9f7a-4a51-8a63-2b8f5a1c0d11';
const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text, names: { [id]: 'Alice' }, me: id }));

describe('chat markdown', () => {
  it('formats inline text, mentions and links', () => {
    expect(html(`Hi <@${id}>, **bold** *it* ~~old~~ \`x()\``)).toBe(
      '<div class="text-sm leading-relaxed"><p class="my-0.5 whitespace-pre-wrap break-words">Hi <span class="rounded bg-amber-100 px-0.5 font-medium text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">@Alice</span>, <strong>bold</strong> <em>it</em> <s>old</s> <code class="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.85em] dark:bg-zinc-800">x()</code></p></div>',
    );
    expect(html('see https://example.com/a.')).toContain('<a href="https://example.com/a" target="_blank" rel="noopener noreferrer"');
    expect(html('[docs](https://x.test)')).toContain('href="https://x.test"');
  });

  it('never makes markup or unsafe links out of a message', () => {
    expect(html('<img src=x onerror=alert(1)>')).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html('[click](javascript:alert(1))')).not.toContain('href');
  });

  it('blocks: code, quotes, lists', () => {
    const out = html('```js\nconst a = 1 < 2;\n```\n> quoted\n- one\n- two\n1. first');
    expect(out).toContain('<pre');
    expect(out).toContain('const a = 1 &lt; 2;');
    expect(out).toContain('<blockquote');
    expect(out).toContain('<ul class="my-1 pl-5 list-disc"><li>one</li><li>two</li></ul>');
    expect(out).toContain('<ol class="my-1 pl-5 list-decimal"><li>first</li></ol>');
  });

  it('plain text for previews', () => {
    expect(plainText(`**Hi** <@${id}> see [this](https://x)`, { [id]: 'Alice' })).toBe('Hi @Alice see this');
  });
});
