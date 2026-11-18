import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API = process.env.FORGE_API_URL ?? 'http://localhost:8080';

// In development the browser talks only to Vite (http://localhost:5173), which
// proxies the API, OIDC provider and Socket.IO so everything is same-origin.
// Run the API with FORGE_PUBLIC_URL=http://localhost:5173.
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
  build: { sourcemap: true, chunkSizeWarningLimit: 900 },
});
