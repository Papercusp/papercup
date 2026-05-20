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
import { harness } from './harness';
import { plugins } from './plugins';
import { registerPty } from './pty';
import { registerOperatorNotes } from './operator-notes';
import { registerAgentChats } from './agent-chats';
import { registerExperts } from './experts';
import { registerProjects } from './projects';
import { registerOracle } from './oracle';
import { registerCrossHarness } from './cross-harness';
import { registerMobile } from './mobile';
import { registerDockLayouts } from './dock-layouts';
import { installPluginApiDispatcher } from '../../../lib/plugin-api-mount';
import { registerAllRoutes } from '../../../lib/endpoint-route/register';

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

app.use('*', compress({ threshold: 1024 }));

registerPty(harness);
registerOperatorNotes(harness);
registerAgentChats(harness);
registerExperts(harness);
registerProjects(harness);
registerCrossHarness(harness);
app.route('/harness', harness);
registerOracle(app);
registerDockLayouts(app);

// Plugin apiRoutes — installPluginApiDispatcher mutates `plugins` to add a
// single catch-all that consults the in-memory apiRoutes registry per
// request. This is structural to the app instance (must happen before
// `app.route('/plugins', plugins)`), so it lives here rather than in
// bootstrap. The async mountPluginApiRoutes() call that *populates* the
// registry from disk lives in bootstrap.ts.
installPluginApiDispatcher(plugins);
app.route('/plugins', plugins);

// Mobile API (pair, push, voice, workspaces) — see _hono/mobile.ts
app.route('/mobile', registerMobile);

// defineRoute endpoints — the endpoint-system's second projection.
// Every `defineRoute` (lib/endpoint-route/routes/**) mounts here and is
// served by the [[...route]] catch-all, same as the routers above. As
// the route-migration (endpoint-route-migration-2026-05-20.md) proceeds,
// the per-endpoint Next route.ts files are deleted and their logic moves
// into lib/endpoint-route/routes/** — this one call grows to cover all
// 243 endpoints.
registerAllRoutes(app);

export { app };
