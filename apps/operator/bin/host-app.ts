/**
 * Papercusp API entrypoint — pure Hono app construction, no side effects.
 *
 * Mounts every router and middleware. Importing this module is safe in any
 * context (operator-vite, tests, IPC bridge). Side effects (FS watchers,
 * background sweepers, plugin-route mounting, etc.) live in `./bootstrap.ts`
 * and run only when `runBootstrap()` is called.
 *
 *   /api/harness/*  — harness CRUD (project picker, features, audit, proposals…)
 *   /api/plugins/*  — installed-plugin metadata + plugin-supplied routes
 *
 * Plus the static credentials/profile/auth/marketplace routes which live as
 * regular Next.js route handlers in app/api/{credentials,profile,auth,marketplace,installed}/.
 */
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';
import { registerRouteLiterals, registerRouteCatchalls } from '@papercusp/operator-core/lib/endpoint-route/register';
import { installMethodNotAllowed } from '@papercusp/operator-core/lib/endpoint-route/method-not-allowed';
import { workspaceContextMiddleware } from '@papercusp/operator-core/lib/workspace-context-middleware';

const app = new Hono().basePath('/api');

// Credentialed CORS for the desktop/mobile shells that call the local
// operator API from a different WebView origin. Keep this on the Hono API
// entrypoint so it covers /api/harness, /api/plugins, /api/oracle and dock
// layout endpoints before any route handlers run.
//
// Do not re-add wildcard ACAO in next.config.js while this uses
// credentials:true: ACAO:* + ACAC:true is spec-invalid and WebKitGTK rejects
// the response with "Fetch API cannot load due to access control checks".
const tauriApiCors = cors({
  origin: [
    'http://localhost:1420',
    'http://tauri.localhost',
    'https://tauri.localhost',
  ],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: [
    'authorization',
    'content-type',
    'if-match',
    'last-event-id',
    'x-requested-with',
    // Per-window workspace context (per-window-workspace-context-2026-05-31).
    // Without this the browser/dev path's CORS preflight strips the custom
    // header before it reaches workspaceContextMiddleware.
    'x-papercusp-workspace',
  ],
  credentials: true,
  maxAge: 600,
});

// Compress JSON bodies. Next 16 with output:'standalone' skips its built-in
// gzip even when running via `next start`, so the operator's API responses
// were going out uncompressed. agentRunsSheets.all is 85 KB raw vs 12 KB
// gzipped (7.3x), and Zero polls it every 3 s — enabling compression here
// saves ~1.4 MB/min of bandwidth on a typical dashboard session.
// `threshold: 1024` skips small responses where gzip overhead exceeds the
// payload (e.g. /api/auth/me at 151 B).
app.use('/harness/*', tauriApiCors);
app.use('/plugins', tauriApiCors);
app.use('/plugins/*', tauriApiCors);
app.use('/oracle/*', tauriApiCors);
app.use('/dock-layouts/*', tauriApiCors);
app.use('/harness-phase-last-used/*', tauriApiCors);
app.use('/themes', tauriApiCors);
app.use('/themes/*', tauriApiCors);

app.use('*', compress({ threshold: 1024 }));

// Per-window workspace context: read `x-papercusp-workspace` and run the
// handler inside the workspace ALS so `activeWorkspaceId()` (and therefore
// harness resolution + PG row-scoping) follow the window that made the request,
// not the process-global `reg.current`. Must run before any route handler.
// (per-window-workspace-context-2026-05-31, P-011.)
app.use('*', workspaceContextMiddleware);

// experts, pty, agent-chats, operator-notes, projects, cross-harness,
// oracle, dock-layouts migrated to defineTool (endpoint-hono-elimination
// -2026-05-21 A1/A2) — they register via `registerRouteLiterals`.
// to `defineTool` (endpoint-hono-elimination-2026-05-21 Phase A1) — they
// register via `registerRouteLiterals` below.

// defineTool LITERALS — phase 1. MUST register before the sub-apps
// below (`app.route('/harness', …)`, `app.route('/plugins', …)`):
// Hono runs overlapping handlers in registration order, so a literal
// like `/plugins/enabled` must out-rank the `plugins` sub-app's
// parametric catch-all. The catch-all defineRoutes register in phase 2
// (registerRouteCatchalls) after the sub-apps. See register.ts.
registerRouteLiterals(app);

// Note: the legacy `app.route('/harness', harness)` mount dropped in A4
// batch 44 (endpoint-hono-elimination-2026-05-21) — `_hono/harness.ts`
// is now a stub awaiting A6 deletion; every harness route serves via
// `defineTool` modules under `lib/endpoint-route/routes/harness/`.

// /api/plugins/* — fully migrated to `defineTool` (endpoint-hono
// -elimination-2026-05-21 A3). Static metadata routes register via
// `registerRouteLiterals(app)` above; the `/plugins/*` catch-all
// (`routes/plugins/catchall.ts`) registers via `registerRouteCatchalls`
// below and handles both plugin-`apiRoutes` dispatch (registry-keyed,
// via `dispatchPluginApiRoute`) and projected-tool dispatch.

// Mobile API (pair, push, voice, workspaces) — migrated off the legacy
// `_hono/mobile.ts` Hono router to `defineTool` modules under
// `lib/endpoint-route/routes/device/` (endpoint-unification-2026-05-21
// Phase E4/E5). Those register via `registerRouteLiterals` above.

// /api/coord/* and /api/su-locks/* — migrated off their legacy Hono
// sub-apps onto `defineTool` modules (endpoint-unification-2026-05-21
// Phase E13). They register via `registerRouteLiterals` above.

// defineTool endpoints — the endpoint-system's second projection.
// Every `defineTool` (lib/endpoint-route/routes/**) mounts here and is
// served by the [[...route]] catch-all, same as the routers above.
//
// defineTool CATCH-ALLS — phase 2. `/plugins/*`, `/agent-tools/*`,
// `/plugin-runtime/.../*`, `/:transport`. Registered AFTER the sub-apps
// so a plugin's own apiRoutes (the `plugins` dispatcher) still gets
// first refusal before our projected-tool catch-all. Phase 1 literals
// registered above, before the sub-apps.
registerRouteCatchalls(app);

// 405 Method Not Allowed for known paths hit with the wrong verb. Runs via
// Hono's `notFound` hook (only when no route matched), so it can't affect any
// working route — it just upgrades "known path, wrong method" from 404 → 405.
// basePath is '/api' (see `new Hono().basePath('/api')` above).
installMethodNotAllowed(app, '/api');

export { app };
