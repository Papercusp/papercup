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
import { harness } from '../_hono/harness';
import { plugins } from '../_hono/plugins';
import { registerPty } from '../_hono/pty';
import { registerOperatorNotes } from '../_hono/operator-notes';
import { registerAgentChats } from '../_hono/agent-chats';
import { registerProjects } from '../_hono/projects';
import { registerOracle } from '../_hono/oracle';
import { mountPluginApiRoutes, installPluginApiDispatcher } from '../../../lib/plugin-api-mount';

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

app.use('/harness/*', adminPreviewCors);
app.use('/plugins/*', adminPreviewCors);

registerPty(harness);
registerOperatorNotes(harness);
registerAgentChats(harness);
registerProjects(harness);
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
