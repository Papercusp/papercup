import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';

// Operator SPA — Vite dev server. Takes over :3055 (was `next dev`).
// The API + internal docs are served by the @hono/node-server host on
// :3070 (Phase C); in dev, Vite proxies to it. Single static proxy —
// the backend endpoint-route migration shipped, so there is no
// per-prefix split and no Next sidecar. See
// apps/operator/docs/plans/operator-vite-migration-2026-05-20.md.
export default defineConfig({
  server: {
    port: 3055,
    host: process.env.PAPERCUSP_BIND_HOST ?? '127.0.0.1',
    proxy: {
      '/api': { target: 'http://127.0.0.1:3070', ws: true, changeOrigin: true },
      '/internal/docs': { target: 'http://127.0.0.1:3070', changeOrigin: true },
    },
  },
  plugins: [
    // Route generation must run before the React plugin.
    tanstackRouter({
      target: 'react',
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
    }),
    react(),
  ],
});
