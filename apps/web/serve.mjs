// Static server for one web app container (portal, mail, calendar, …).
//   FORGE_WEB_APP=mail PORT=8082 node serve.mjs
// Serves dist/<app> under the app's path (/mail/…), falls back to index.html
// for the app's pages, and answers /healthz. API calls never come here: the
// gateway sends them to the back-end services.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = process.env.FORGE_WEB_APP ?? 'portal';
const PORT = Number(process.env.PORT ?? 8081);
const ROOT = resolve(process.env.FORGE_WEB_DIST ?? fileURLToPath(new URL(`dist/${APP}`, import.meta.url)));
const BASE = APP === 'portal' || APP === 'all' ? '/' : `/${APP}/`;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// Same policy the API applied when it served the web client. FORGE_FRAME_SOURCES
// adds origins the app may embed and post to (the Office editor, Euro-Office).
const FRAMES = (process.env.FORGE_FRAME_SOURCES ?? '')
  .split(/\s+/)
  .filter(Boolean)
  .map((u) => new URL(u).origin)
  .join(' ');
const SECURITY_HEADERS = {
  'content-security-policy': `default-src 'self'; script-src 'self' ${FRAMES}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; frame-src 'self' blob: ${FRAMES}; connect-src 'self'; font-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self' ${FRAMES}; frame-ancestors 'none'`,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

const OTHER_APPS = ['mail', 'calendar', 'contacts', 'tasks', 'admin', 'drive', 'sites', 'team'];
function ownsPath(path) {
  const first = path.split('/')[1] ?? '';
  if (BASE === '/') return APP === 'all' || !OTHER_APPS.includes(first);
  return first === APP;
}

async function fileAt(urlPath) {
  const rel = urlPath.startsWith(BASE) ? urlPath.slice(BASE.length) : null;
  if (rel === null) return null;
  const full = normalize(join(ROOT, decodeURIComponent(rel)));
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null; // no path traversal
  try {
    const s = await stat(full);
    return s.isFile() ? { path: full, size: s.size } : null;
  } catch {
    return null;
  }
}

function send(res, status, headers, file) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  if (!file) return res.end();
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"status":"ok"}');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { allow: 'GET, HEAD' });
  const file = await fileAt(path);
  if (file && !file.path.endsWith('index.html')) {
    // Hashed build assets never change; everything else is revalidated.
    const immutable = /[\\/]assets[\\/]/.test(file.path);
    return send(res, 200, { 'content-type': TYPES[extname(file.path)] ?? 'application/octet-stream', 'content-length': file.size, 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300' }, req.method === 'HEAD' ? null : file.path);
  }
  // Only this app's pages: another app's path here means the gateway isn't in front (avoid a reload loop).
  if (!ownsPath(path)) return send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, null);
  // A page of this app (client-side routing): the app shell.
  if ((req.headers.accept ?? '').includes('text/html') || path === BASE || path === BASE.slice(0, -1)) {
    return send(res, 200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' }, req.method === 'HEAD' ? null : join(ROOT, 'index.html'));
  }
  return send(res, 404, { 'content-type': 'text/plain' }, null);
}).listen(PORT, process.env.HOST ?? '0.0.0.0', () => console.log(`ForgeOffice ${APP} web app on :${PORT} (${BASE})`));
