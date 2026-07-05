import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import { resolve } from 'node:path';
import { isDesktopHmrEnabled, NO_VITE_CLIENT_BODY, shouldServeNoopViteClient } from './dev-mode';
import { devDistPrunePlugin, shouldRetainDistChunks } from './dev-dist-prune';
import { distWipeGuardPlugin } from './dist-wipe-guard';
import { watchHeartbeatPlugin } from './watch-heartbeat';

// Operator SPA — Vite dev server. Takes over :3055 (was `next dev`).
// The API + internal docs are served by the @hono/node-server host on
// :3070 (Phase C); in dev, Vite proxies to it. Single static proxy —
// the backend endpoint-route migration shipped, so there is no
// per-prefix split and no Next sidecar. See
// apps/operator/docs/plans/operator-vite-migration-2026-05-20.md.
const operatorRoot = resolve(import.meta.dirname, '../operator');

const enableHmr = isDesktopHmrEnabled(process.env);

// Every fleet edit rebuilds `dist/`. With Vite's default emptyOutDir each
// rebuild DELETES the prior hashed chunks, so a long-open Tauri webview 404s its
// lazy imports ("Importing a module script failed" → dead error screen). We
// therefore RETAIN old chunks (emptyOutDir:false) and prune them by age instead
// (devDistPrunePlugin) whenever we're in a retain regime:
//   - a `vite build --watch` (the classic dev shell), OR
//   - a ONE-SHOT build that opts in via PAPERCUSP_RETAIN_DIST_CHUNKS=1 — the
//     desktop dev bundle (:3270) is refreshed by a one-shot `npm run build`
//     timer, NOT a watcher, so the old --watch-only gate never fired for it and
//     each tick stranded the open webview (WI-1484). The timer now sets the env.
// A release/CI build sets neither → clean-empty + the dist-wipe guard. See plan
// `adv-build-churn-retain-chunks-2026-06-03` + WI-1484.
const retainDistChunks = shouldRetainDistChunks(process.argv, process.env);

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
      // node:module has NO browser polyfill (unlike path/url/fs/buffer/process), so Vite
      // externalizes it → `createRequire` is undefined. An eager
      // `const require = createRequire(import.meta.url)` at module scope in any
      // route-tree-reachable backend module (connection.ts, plugin-host-runtime, …) then
      // crashed the WHOLE desktop app at module-eval ("createRequire is not a function").
      // Shim node:module so createRequire EXISTS (no-op) in the browser; the require it
      // returns throws only if called, which never happens in the SPA.
      { find: /^node:module$/, replacement: resolve(import.meta.dirname, 'src/shims/node-module-browser.ts') },
      // Server-only test-infra native addons: testcontainers → dockerode /
      // ssh-remote-port-forward → ssh2 → cpu-features. ssh2 + cpu-features each
      // require() a native `.node` binary at module scope, which Rolldown
      // HARD-FAILS to resolve during its full-graph scan (even though the whole
      // subtree is tree-shaken out of the SPA) — this was failing the
      // operator-vite build and freezing every deploy at green-checkpoint.
      // Shim the two native packages; the pure-JS layers above them externalize
      // cleanly. The SPA never runs Docker/SSH test-container code.
      { find: /^(ssh2|cpu-features)(?:\/.*)?$/, replacement: resolve(import.meta.dirname, 'src/shims/testcontainers-native-browser.ts') },
      { find: '@', replacement: operatorRoot },
    ],
    // Operator components and the Vite shell must share ONE React
    // instance — two copies would break hooks ("invalid hook call").
    dedupe: ['react', 'react-dom'],
  },
  build: {
    // Retain old hashed chunks across a retain-regime rebuild so an open webview
    // never 404s a lazy import; a release/CI `build` (no --watch, no retain env)
    // still empties for a clean bundle. The prune plugin (below) caps growth.
    emptyOutDir: !retainDistChunks,
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
      // Automatic route code-splitting (perf: FCP). Without this, every route's
      // `component` (all 81 — admin, pi, gym, editors, dockview panes, …) is
      // statically imported into routeTree.gen.ts → the eager boot bundle
      // (~14MB raw across the entry + modulepreload graph), which is the ~2s
      // FCP. autoCodeSplitting moves each route's non-critical config
      // (component/errorComponent/notFoundComponent) into its own lazy chunk so
      // boot loads only the entry + the matched route; loaders stay critical so
      // data prefetch isn't delayed. See /internal/docs/performance + the E2E
      // perf sweep (2026-06-23). Measured: drops the eager src-* mega-chunks.
      autoCodeSplitting: true,
    }),
    react(),
    // Retain-regime builds retain+prune old chunks (emptyOutDir:false); a
    // clean-empty build (release/CI) instead gets the dist-wipe guard so it
    // can't wipe a LIVE watcher's :3170 dist out from under open webviews (the
    // 2026-06-29 blank-page incident). The guard only fires on a confirmed
    // same-dist live watcher and fails open otherwise, so it never wedges the
    // deploy pipeline. See dist-wipe-guard.ts.
    ...(retainDistChunks ? [devDistPrunePlugin()] : [distWipeGuardPlugin()]),
    // EI-5202: stamp a heartbeat (build time + git SHA) after every `--watch`
    // rebuild, so a health probe can detect a wedged-but-running watcher
    // instead of the only signal being a manual dist/index.html mtime check.
    // No-op for a one-shot production/CI build. See watch-heartbeat.ts.
    watchHeartbeatPlugin(),
  ],
});
