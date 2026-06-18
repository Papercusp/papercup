import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import { resolve } from 'node:path';
import { isDesktopHmrEnabled, NO_VITE_CLIENT_BODY, shouldServeNoopViteClient } from './dev-mode';
import { devDistPrunePlugin } from './dev-dist-prune';

// Operator SPA — Vite dev server. Takes over :3055 (was `next dev`).
// The API + internal docs are served by the @hono/node-server host on
// :3070 (Phase C); in dev, Vite proxies to it. Single static proxy —
// the backend endpoint-route migration shipped, so there is no
// per-prefix split and no Next sidecar. See
// apps/operator/docs/plans/operator-vite-migration-2026-05-20.md.
const operatorRoot = resolve(import.meta.dirname, '../operator');

const enableHmr = isDesktopHmrEnabled(process.env);

// `dev:nohmr` = `vite build --watch`: every fleet edit rebuilds `dist/`. With
// Vite's default emptyOutDir each rebuild DELETES the prior hashed chunks, so a
// long-open Tauri webview 404s its lazy imports (vditor etc. blank). In watch
// builds we therefore RETAIN old chunks (emptyOutDir:false) and prune them by
// age instead (devDistPrunePlugin). The production `build` (no --watch) keeps
// emptying for a clean desktop bundle. See plan
// `adv-build-churn-retain-chunks-2026-06-03`.
const isWatchBuild = process.argv.includes('--watch');

// Operator API host the dev server proxies to. Overridable so an e2e rig can
// target the staging operator (:3170) — see the proxy block below.
const apiTarget = process.env.PAPERCUSP_API_TARGET ?? 'http://127.0.0.1:3070';

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

  // The Vite app imports operator components from `apps/operator/app/**`
  // in place. The operator's `@/*` tsconfig path maps to `apps/operator/*`;
  // mirror it here. (The former `next/{navigation,link,dynamic}` +
  // `@bprogress/next` aliases are gone — those imports were rewritten to
  // `@/lib/router-compat/*` and `@bprogress/react`; see plan
  // `finish-next-removal-2026-06-01`.)
  resolve: {
    alias: [
      // operator-core (headless backend) — carved from apps/operator (SP1 C4).
      // Must precede the '@' alias (first match wins).
      { find: '@papercusp/operator-core', replacement: resolve(operatorRoot, '../../packages/operator-core') },
      // The browser bundle may import server modules through the generated
      // route tree; postgres-js touches Buffer at module eval and blanks the SPA.
      { find: /^postgres(?:\/.*)?$/, replacement: resolve(import.meta.dirname, 'src/shims/postgres-browser.ts') },
      // @dbos-inc/dbos-sdk is server-only; its telemetry CJS requires
      // winston-transport at module scope, which only resolves by accident on
      // hosts with a stray $HOME/node_modules (broke the macOS build VM).
      { find: /^@dbos-inc\/dbos-sdk(?:\/.*)?$/, replacement: resolve(import.meta.dirname, 'src/shims/dbos-browser.ts') },
      // Server-only P2P substrate networking (corestore/hyperswarm/hyperdht/
      // hyperbee/hypercore/udx-native → sodium-universal → the native
      // sodium-native addon). Reachable through the route-tree import graph via
      // operator-core backend modules (work-items, issues-engineer,
      // orchestrator/*, hive-*, sync/hyperbee/*) but tree-shaken out of the
      // browser bundle; Rolldown still hard-fails resolving the native deps
      // during its scan. Shim them out — the SPA never runs substrate code.
      // (compact-encoding/protomux/b4a are pure-JS browser-safe — NOT shimmed.)
      {
        find: /^(corestore|hyperswarm|hyperdht|hyperbee|hypercore|hypercore-crypto|sodium-universal|sodium-native|sodium-secretstream|udx-native|dht-rpc|blind-relay)(?:\/.*)?$/,
        replacement: resolve(import.meta.dirname, 'src/shims/substrate-browser.ts'),
      },
      { find: '@', replacement: operatorRoot },
    ],
    // Operator components and the Vite shell must share ONE React
    // instance — two copies would break hooks ("invalid hook call").
    dedupe: ['react', 'react-dom'],
  },
  build: {
    // Retain old hashed chunks across watch rebuilds so an open webview never
    // 404s a lazy import; a one-shot/production `build` still empties for a
    // clean bundle. The prune plugin (below) caps the resulting dist growth.
    emptyOutDir: !isWatchBuild,
  },
  server: {
    port: 3055,
    host: process.env.PAPERCUSP_BIND_HOST ?? '127.0.0.1',
    // CORS policy for /api belongs to the Hono host (:3070) — its middleware
    // allows `last-event-id` etc. and echoes the origin. Vite's own default
    // CORS middleware answers OPTIONS preflights BEFORE the proxy with a
    // conflicting policy (no allow-origin for non-localhost origins), so any
    // preflighted /api request (e.g. a fetch with a Last-Event-ID header from
    // a non-localhost origin) fails with TypeError while the same simple GET
    // proxies fine. Disable it; preflights then reach the API host that owns
    // the policy.
    cors: false,
    // The Tauri shell is the product surface, and this checkout is edited by
    // multiple agents at once. Vite HMR/full-reload traffic makes the desktop
    // look like it is constantly refreshing while unrelated files are saved.
    // Default to manual refresh; opt in with PAPERCUSP_ENABLE_HMR=1 when an
    // engineer explicitly wants hot module replacement for a local UI tweak.
    hmr: enableHmr ? undefined : false,
    proxy: {
      // PAPERCUSP_API_TARGET points the /api proxy at a different operator —
      // e.g. the staging host (:3170) when an e2e rig must exercise staging-tree
      // server code instead of the green :3070 deployment. Default unchanged.
      '/api': { target: apiTarget, ws: true, changeOrigin: true },
      '/internal/docs': { target: apiTarget, changeOrigin: true },
      '/docs': { target: apiTarget, changeOrigin: true },
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
    // Watch-build only: prune the chunks that emptyOutDir:false now retains.
    ...(isWatchBuild ? [devDistPrunePlugin()] : []),
  ],
});
