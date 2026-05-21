import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import { resolve } from 'node:path';

// Operator SPA — Vite dev server. Takes over :3055 (was `next dev`).
// The API + internal docs are served by the @hono/node-server host on
// :3070 (Phase C); in dev, Vite proxies to it. Single static proxy —
// the backend endpoint-route migration shipped, so there is no
// per-prefix split and no Next sidecar. See
// apps/operator/docs/plans/operator-vite-migration-2026-05-20.md.
const operatorRoot = resolve(import.meta.dirname, '../operator');

export default defineConfig({
  // During the migration the Vite app imports operator components
  // in place (Phase H physically relocates them). The operator's
  // `@/*` tsconfig path maps to `apps/operator/*`; mirror it here.
  resolve: {
    alias: {
      '@': operatorRoot,
    },
    // Operator components and the Vite shell must share ONE React
    // instance — two copies would break hooks ("invalid hook call").
    dedupe: ['react', 'react-dom'],
  },
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
