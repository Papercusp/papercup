/**
 * Papercusp API entrypoint. Mounts the framework's Hono routers:
 *   /api/harness/*  — harness CRUD (project picker, features, audit, proposals…)
 *   /api/plugins/*  — installed-plugin metadata
 *
 * Plus the static credentials/profile/auth/marketplace routes which live as
 * regular Next.js route handlers in app/api/{credentials,profile,auth,marketplace,installed}/.
 */
import { Hono } from 'hono';
import { handle } from 'hono/vercel';
import { compress } from 'hono/compress';
import { harness } from '../_hono/harness';
import { plugins } from '../_hono/plugins';
import { registerPty } from '../_hono/pty';
import { registerOperatorNotes } from '../_hono/operator-notes';
import { registerAgentChats } from '../_hono/agent-chats';
import { registerExperts } from '../_hono/experts';
import { registerProjects } from '../_hono/projects';
import { registerOracle } from '../_hono/oracle';
import { registerCrossHarness } from '../_hono/cross-harness';
import { registerMobile } from '../_hono/mobile';
import { mountPluginApiRoutes, installPluginApiDispatcher } from '../../../lib/plugin-api-mount';
import { startAutoLoopOnce } from '../../../lib/autoloop';
import { ensureHarnessFsWatcher } from '../../../lib/harness-fs-watcher';
import { ensureHarnessStatusSweep } from '../../../lib/harness-status-sweep';
import { registerAllExpirables } from '../../../lib/expirable-registrations';
import { startMobileVoiceWs } from '../../../lib/mobile-voice-ws';
import { startPushCredentialRefresher } from '../../../lib/mobile-push-credentials';
import { startMobileInterventionWatcher } from '../../../lib/mobile-intervention-watcher';

export const dynamic = 'force-dynamic';

const app = new Hono().basePath('/api');

// CORS — preview origins (admin tooling). Tightens on production.
const adminPreviewCors = async (c: any, next: any) => {
  const origin = c.req.header('origin');
  if (origin) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'content-type, x-actor');
  }
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  await next();
};

// Compress JSON bodies. Next 16 with output:'standalone' skips its built-in
// gzip even when running via `next start`, so the operator's API responses
// were going out uncompressed. agentRunsSheets.all is 85 KB raw vs 12 KB
// gzipped (7.3x), and Zero polls it every 3 s — enabling compression here
// saves ~1.4 MB/min of bandwidth on a typical dashboard session.
// `threshold: 1024` skips small responses where gzip overhead exceeds the
// payload (e.g. /api/auth/status at 151 B).
app.use('*', compress({ threshold: 1024 }));

app.use('/harness/*', adminPreviewCors);
app.use('/plugins/*', adminPreviewCors);

registerPty(harness);
registerOperatorNotes(harness);
registerAgentChats(harness);
registerExperts(harness);
registerProjects(harness);
registerCrossHarness(harness);
app.route('/harness', harness);
registerOracle(app);

// Phase 6b item 2 — discover plugin apiRoutes and dispatch them through
// the `plugins` sub-app. We register a single catch-all route on
// `plugins` (via installPluginApiDispatcher) that consults the in-memory
// apiRoutes registry per request, so hot-reload + post-boot symlinks
// work without the Hono-route-snapshot footgun.
//
// KNOWN LIMITATION: Next.js's runtime cannot dynamic-import `.ts` plugin
// files (works under tsx but not Next's bundler). Plugins must ship a
// pre-compiled `.js` entry point to be reachable in-process.
installPluginApiDispatcher(plugins);
mountPluginApiRoutes(plugins)
  .then((r) => {
    // eslint-disable-next-line no-console
    console.log(`[plugin-mount] mounted=${r.mounted} skipped=${r.skipped} errors=${r.errors.length}`);
    for (const e of r.errors) {
      // eslint-disable-next-line no-console
      console.warn(`[plugin-mount] error: ${e}`);
    }
  })
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.warn('[plugin-mount] unexpected rejection:', e);
  });

app.route('/plugins', plugins);

// Mobile API (pair, push, voice, workspaces) — see _hono/mobile.ts
app.route('/mobile', registerMobile);

// AutoLoop ticker — periodic fires of harnesses with autoLoop=true. Idempotent.
startAutoLoopOnce();
startMobileVoiceWs();
startPushCredentialRefresher();
startMobileInterventionWatcher();

// Harness FS watcher — mirrors .harness/{summary.md,pending-reviews,proposals}
// to PG so panels can read via Zero push instead of polling. Idempotent;
// pinned to globalThis to survive Next dev module re-evaluation.
try {
  ensureHarnessFsWatcher();
} catch (e) {
  console.warn('[api] harness-fs-watcher failed to start:', (e as Error)?.message ?? e);
}

// Identity files: now written at producer time by bash run.sh's
// `_post_curator_outputs` after `invoke curator` finishes. The
// chokidar watcher (lib/identity-files-watcher.ts) is retired.

// Phase 3: harness_status / harness_lanes sweeper. PID-liveness based —
// clears stale `agent_runs.running` and `harness_lanes` rows whose
// recorded PID is gone. (TTL-based sweeps for status/scan-locks/claims/
// auth live in the expirable registry below.) Idempotent.
try {
  ensureHarnessStatusSweep();
} catch (e) {
  console.warn('[api] harness-status-sweep failed to start:', (e as Error)?.message ?? e);
}

// TTL-based row expiry. Replaces ad-hoc lazy-deletes scattered across
// operator-scan-lock, operator-claims, harness_status stalled-detection,
// auth.magic_links, auth.sessions. One sweep loop, registered tables.
try {
  registerAllExpirables();
} catch (e) {
  console.warn('[api] expirable-registry failed to start:', (e as Error)?.message ?? e);
}

// Opt-in dev-mode hot-reload — watches ~/.papercusp/global-plugins/ and
// resets the in-process runtime cache whenever a manifest or entry file
// changes. Production hosts should leave this off (default).
if (process.env.PAPERCUSP_DEV_PLUGIN_WATCH === '1') {
  // Lazy import so the watcher's fs.watch handle isn't held in tests
  // that don't import this module's bootstrap code.
  import('../../../lib/plugin-host-runtime')
    .then(({ watchPluginsForReload }) => watchPluginsForReload())
    .catch((e) => console.warn('[plugin-host-watch] failed to arm:', e));
}

export const GET = handle(app);
export const POST = handle(app);
export const PUT = handle(app);
export const PATCH = handle(app);
export const DELETE = handle(app);
export const OPTIONS = handle(app);
