import { randomBytes } from 'node:crypto';

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export interface PageOptions {
  title: string;
  body: string;
  brandColor?: string;
  nonce?: string;
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Minimal self-contained page for provider-rendered screens (no external assets). */
export function renderPage({ title, body, brandColor, nonce }: PageOptions): { html: string; csp: string } {
  const color = brandColor && COLOR_RE.test(brandColor) ? brandColor : '#4f46e5';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ForgeOffice</title>
<style>
  :root { color-scheme: light dark; --brand: ${color}; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #f4f4f5; color: #18181b; }
  .card { width: 100%; max-width: 400px; background: #fff; border: 1px solid #e4e4e7; border-radius: 12px; padding: 32px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0 0 16px; color: #52525b; }
  .mark { width: 36px; height: 36px; border-radius: 9px; background: var(--brand); margin-bottom: 20px; }
  a.btn, button { display: inline-block; width: 100%; text-align: center; padding: 10px 14px; border-radius: 8px; border: 0;
    background: var(--brand); color: #fff; font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
  pre { white-space: pre-wrap; word-break: break-word; font-size: 13px; background: #f4f4f5; padding: 10px; border-radius: 8px; }
  @media (prefers-color-scheme: dark) {
    body { background: #09090b; color: #fafafa; }
    .card { background: #18181b; border-color: #27272a; }
    p { color: #a1a1aa; }
    pre { background: #27272a; }
  }
</style>
</head>
<body><main class="card"><div class="mark" aria-hidden="true"></div>${body}</main></body>
</html>`;
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    nonce ? `script-src 'nonce-${nonce}'` : "script-src 'none'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  return { html, csp };
}

export function newNonce(): string {
  return randomBytes(16).toString('base64');
}
