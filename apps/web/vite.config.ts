import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API = process.env.FORGE_API_URL ?? 'http://localhost:8080';

// In development the browser talks only to Vite (http://localhost:5173), which
// proxies the API, OIDC provider and Socket.IO so everything is same-origin.
// Run the API with FORGE_PUBLIC_URL=http://localhost:5173.
/**
 * FORGE_WEB_APP selects which web app to build: one bundle per container in
 * production (portal, mail, calendar, contacts, tasks, admin), or "all" for
 * development and all-in-one installs. Each app is served under its own path,
 * so its assets live under that path too (/mail/assets/…).
 */
const WEB_APP = process.env.FORGE_WEB_APP ?? 'all';
const base = WEB_APP === 'all' || WEB_APP === 'portal' ? '/' : `/${WEB_APP}/`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base,
  define: { __FORGE_APP__: JSON.stringify(WEB_APP) },
  server: {
    port: 5173,
    proxy: {
      '/api': API,
      '/oidc': API,
      '/socket.io': { target: API, ws: true },
      '/interaction': {
        target: API,
        // The sign-in page itself is rendered by the SPA; its JSON endpoints go to the API.
        bypass: (req) => (req.method === 'GET' && /^\/interaction\/[^/]+(\?.*)?$/.test(req.url ?? '') ? '/index.html' : undefined),
      },
    },
  },
  build: { sourcemap: true, chunkSizeWarningLimit: 900, outDir: `dist/${WEB_APP}`, emptyOutDir: true },
});
