import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import { resolve } from 'node:path';
import { isDesktopHmrEnabled, NO_VITE_CLIENT_BODY, shouldServeNoopViteClient } from './dev-mode';

// Operator SPA — Vite dev server. Takes over :3055 (was `next dev`).
// The API + internal docs are served by the @hono/node-server host on
// :3070 (Phase C); in dev, Vite proxies to it. Single static proxy —
// the backend endpoint-route migration shipped, so there is no
// per-prefix split and no Next sidecar. See
// apps/operator/docs/plans/operator-vite-migration-2026-05-20.md.
const operatorRoot = resolve(import.meta.dirname, '../operator');

const enableHmr = isDesktopHmrEnabled(process.env);

const noViteClientPlugin: Plugin = {
  name: 'papercusp-no-vite-client',
  configureServer(server) {
    if (enableHmr) return;
    server.middlewares.use((req, res, next) => {
      if (!shouldServeNoopViteClient(req.url, enableHmr)) {
        next();
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/javascript');
      res.end(NO_VITE_CLIENT_BODY);
    });
  },
};

// Dev-only: seed `window.__PAPERCUSP_FLAGS__` into the served index.html so
// the SPA paints with real flag state on first load instead of FLAG_DEFAULTS
// — the same flash the built desktop avoids by injecting the seed in the Hono
// SPA host (apps/operator/bin/host-spa.ts). In dev the Vite server (:3055) is
// a SEPARATE process from the Hono host (:3070) that owns the flag backend, so
// calling getAllFlags() here would see an uninitialized backend and always
// return defaults. Instead we fetch the exact payload the client would
// (/api/flags/bootstrap on :3070, the same endpoint the proxy forwards to) and
// inline it. Best-effort: if the host isn't up yet, inject nothing and let the
// client bootstrap flags asynchronously (the pre-existing dev behavior).
const flagsBootstrapPlugin: Plugin = {
  name: 'papercusp-flags-bootstrap',
  transformIndexHtml: {
    order: 'pre',
    async handler(html) {
      try {
        const res = await fetch('http://127.0.0.1:3070/api/flags/bootstrap');
        if (!res.ok) return html;
        const payload = await res.json();
        const seed = `<script>window.__PAPERCUSP_FLAGS__=${JSON.stringify(payload)};</script>`;
        return html.includes('<head>') ? html.replace('<head>', `<head>${seed}`) : seed + html;
      } catch {
        return html;
      }
    },
  },
};

export default defineConfig({
  // Static assets (wordmark.svg, mascot.svg, the Oracle/header icons,
  // onnx/wasm voice models, …) live in the operator's own `public/`.
  // operator-vite has no `public/` of its own, so point Vite's
  // publicDir there — otherwise `/wordmark.svg` & co. fall through to
  // the SPA-fallback index.html and render as broken images.
  publicDir: resolve(operatorRoot, 'public'),

  // During the migration the Vite app imports operator components
  // in place (Phase H physically relocates them). The operator's
  // `@/*` tsconfig path maps to `apps/operator/*`; mirror it here.
  //
  // `next/{navigation,link,dynamic}` shims (see `shims/`): shared
  // components under `apps/operator/app/` still `import { useRouter }
  // from 'next/navigation'`, but in the Vite bundle those resolve to
  // small TSR-backed wrappers. The live Next operator (still on
  // `next dev` during the migration window) resolves the same imports
  // via `node_modules/next/` and is unaffected. Decommission this
  // alias block + delete `shims/` when `apps/operator/app/` is removed
  // in Phase H. Exact-match (RegExp) so deep imports like
  // `next/navigation/types` aren't rewritten.
  resolve: {
    alias: [
      { find: '@', replacement: operatorRoot },
      {
        find: /^next\/navigation$/,
        replacement: resolve(import.meta.dirname, 'shims/next-navigation.tsx'),
      },
      {
        find: /^next\/link$/,
        replacement: resolve(import.meta.dirname, 'shims/next-link.tsx'),
      },
      {
        find: /^next\/dynamic$/,
        replacement: resolve(import.meta.dirname, 'shims/next-dynamic.tsx'),
      },
      // `@bprogress/next` (+ its `/app` subpath) — the top-of-page
      // progress bar. No-op shim until plan B6 ships the TSR-native
      // adapter; see `shims/bprogress.tsx`.
      {
        find: /^@bprogress\/next$/,
        replacement: resolve(import.meta.dirname, 'shims/bprogress.tsx'),
      },
      {
        find: /^@bprogress\/next\/app$/,
        replacement: resolve(import.meta.dirname, 'shims/bprogress.tsx'),
      },
    ],
    // Operator components and the Vite shell must share ONE React
    // instance — two copies would break hooks ("invalid hook call").
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 3055,
    host: process.env.PAPERCUSP_BIND_HOST ?? '127.0.0.1',
    // The Tauri shell is the product surface, and this checkout is edited by
    // multiple agents at once. Vite HMR/full-reload traffic makes the desktop
    // look like it is constantly refreshing while unrelated files are saved.
    // Default to manual refresh; opt in with PAPERCUSP_ENABLE_HMR=1 when an
    // engineer explicitly wants hot module replacement for a local UI tweak.
    hmr: enableHmr ? undefined : false,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3070', ws: true, changeOrigin: true },
      '/internal/docs': { target: 'http://127.0.0.1:3070', changeOrigin: true },
      '/docs': { target: 'http://127.0.0.1:3070', changeOrigin: true },
    },
  },
  plugins: [
    noViteClientPlugin,
    flagsBootstrapPlugin,
    // Route generation must run before the React plugin.
    tanstackRouter({
      target: 'react',
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
    }),
    react(),
  ],
});
