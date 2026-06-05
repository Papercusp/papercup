/**
 * SPA static fallback for the operator Hono host — Phase G3 of the
 * operator-vite migration.
 *
 * Serves the built Vite SPA (`apps/operator-vite/dist/`) for every request
 * that the API / docs / page-namespace routes didn't claim:
 *
 *   - Path WITH a file extension (`/assets/index-abc.js`, `/favicon.ico`)
 *     → serve that file from `dist/`; a miss is a real 404 (never shell a
 *     missing `.js`/`.css` — that produces confusing MIME errors).
 *   - Path WITHOUT an extension (`/`, `/login`, `/settings/voice`,
 *     `/nonexistent`) → serve `dist/index.html` with 200. The TSR client
 *     router owns routing, including its own not-found component — so even
 *     an unknown client path returns the 200 shell (plan G acceptance).
 *
 * `dist/` is resolved from `__dirname` (NOT `process.cwd()`) — same
 * audit-3-safe pattern as `host-docs.ts`. `bin/` is `apps/operator/bin/`;
 * the Vite dist is the sibling `apps/operator-vite/dist/`.
 *
 * Final home (Phase H): when `apps/operator/` is removed, the host moves
 * under `apps/operator-vite/server/` and this resolve() shortens.
 */
import { Hono } from 'hono';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { getAllFlags, isBackendConfigured } from '@papercusp/flags/server';
import { activeWorkspaceId } from '@papercusp/operator-core/lib/workspace-registry';
import { readProfile } from '@papercusp/operator-core/lib/session';
import { resolveDistinctId } from '@papercusp/operator-core/lib/flag-distinct-id';
import { reinitFlagBackend } from '@papercusp/operator-core/lib/flag-bus';
import { isTestingFeaturesEnabled } from '@papercusp/operator-core/lib/posthog-config';

/**
 * Vite SPA `dist/` root. In dev (host run via `tsx` from source) this
 * resolves `__dirname`-relative — `bin/` → sibling `apps/operator-vite/dist`.
 * In the packaged desktop the host is esbuild-bundled into a single file
 * whose `__dirname` is the sidecar root, so the build sets
 * `PAPERCUSP_SPA_DIST` to the bundled `dist/` location explicitly.
 */
const SPA_DIST_ROOT = process.env.PAPERCUSP_SPA_DIST
  ? resolve(process.env.PAPERCUSP_SPA_DIST)
  : resolve(__dirname, '..', '..', 'operator-vite', 'dist');

const EXT_CONTENT_TYPE: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const TEXT_EXTS = new Set([
  '.html', '.js', '.mjs', '.css', '.json', '.map', '.svg', '.txt', '.webmanifest',
]);

function serveFile(absPath: string, status = 200): Response {
  const ext = extname(absPath).toLowerCase();
  const contentType = EXT_CONTENT_TYPE[ext] ?? 'application/octet-stream';
  const body = TEXT_EXTS.has(ext)
    ? readFileSync(absPath, 'utf-8')
    : readFileSync(absPath);
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

/**
 * Serve the SPA shell with pre-hydration globals injected:
 *
 *   - `window.__PAPERCUSP_WS__` — the active workspace id. The browser
 *     namespaces per-workspace localStorage off this, so it must be set
 *     before the deferred module bundle runs — and independent of the URL,
 *     which doesn't reliably carry `?ws=` (workspace-localstorage-isolation-
 *     2026-05-27, D-001). The operator process is workspace-specific
 *     (HOME-remapped), so `activeWorkspaceId()` is the right source.
 *
 *   - `window.__PAPERCUSP_FLAGS__` — the resolved feature-flag payload. The
 *     flags client (`libs/flags` client `readInitialPayload`) seeds its
 *     snapshot from this global, so flag-gated UI paints with the real flag
 *     state on first render instead of FLAG_DEFAULTS. Without it, an enabled
 *     flag's surface renders hidden for one paint, then pops in once the
 *     async `/api/flags/bootstrap` fetch resolves — the flash this removes.
 *     This is data injection into a static shell, NOT server-side rendering:
 *     the client still renders 100% of the UI, and still revalidates via
 *     `loadFlags()` + the SSE flag stream. We compute it exactly as the
 *     `/flags/bootstrap` route does (same reinit guard + distinct-id), since
 *     this host owns the same in-process flag backend. Best-effort: a flag
 *     backend hiccup must never break the shell, so on any error we omit the
 *     seed and let the client fall back to its async bootstrap.
 */
async function serveIndexHtmlWithWorkspace(indexPath: string, req: Request): Promise<Response> {
  let html = readFileSync(indexPath, 'utf-8');
  let wsId = 'default';
  try {
    // Phase E (P-053): each window self-identifies via `?ws=<id>` in its URL
    // (the multi-window shell opens `/harness?ws=<id>`). The SPA index route is
    // NOT under the /api workspace middleware, so prefer the request's `?ws=`
    // here and fall back to the registry/global `activeWorkspaceId()` only for a
    // bare load. This makes `window.__PAPERCUSP_WS__` (→ getBrowserWorkspaceId)
    // match the window's workspace, so its fetch/EventSource stamping scopes to
    // the right workspace against the one shared sidecar.
    const reqWs = new URL(req.url).searchParams.get('ws');
    wsId = reqWs && reqWs.trim() ? reqWs.trim() : activeWorkspaceId();
  } catch {
    /* registry/url unreadable — fall back to 'default' */
  }
  const globals = [`window.__PAPERCUSP_WS__=${JSON.stringify(wsId)};`];
  // Pre-paint presentation preferences (theme, visual-effects). The boot
  // scripts in index.html read these synchronously BEFORE React mounts so the
  // page paints the user's saved theme + effects with no flash. PG is the
  // source of truth (the desktop webview's localStorage is unreliable across
  // reloads/restarts — see lib/profile-pref.ts), read here for the same
  // workspace the window self-identifies as. Best-effort: on any error the
  // boot scripts fall back to the localStorage cache + defaults.
  try {
    const profile = await readProfile(wsId);
    const prefs = {
      theme_id: typeof profile.theme_id === 'string' ? profile.theme_id : null,
      visual_effects_mode:
        typeof profile.visual_effects_mode === 'string' ? profile.visual_effects_mode : null,
    };
    globals.push(`window.__PAPERCUSP_PREFS__=${JSON.stringify(prefs)};`);
  } catch {
    /* profile unreadable — boot scripts fall back to localStorage + defaults */
  }
  try {
    if (isBackendConfigured() !== isTestingFeaturesEnabled()) {
      reinitFlagBackend();
    }
    const flags = await getAllFlags(resolveDistinctId(req));
    globals.push(`window.__PAPERCUSP_FLAGS__=${JSON.stringify(flags)};`);
  } catch {
    /* flag backend unavailable — client bootstraps flags asynchronously */
  }
  const inject = `<script>${globals.join('')}</script>`;
  // Insert right after <head> so it runs before the deferred module bundle.
  html = html.includes('<head>') ? html.replace('<head>', `<head>${inject}`) : inject + html;
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

/** Resolve `rel` under `dist/`, guarding against path traversal. */
function safeDistPath(rel: string): string | null {
  const abs = resolve(SPA_DIST_ROOT, rel);
  if (abs !== SPA_DIST_ROOT && !abs.startsWith(SPA_DIST_ROOT + sep)) return null;
  return abs;
}

export const spaRoutes = new Hono();

// Final fallback — registered last in `host-handler.ts`, so `/api/*`,
// `/internal/docs/*`, `/wiki`, `/drizzle-studio` and the cross-app proxies
// have all already terminated before a request reaches here.
spaRoutes.get('*', async (c) => {
  const pathname = decodeURI(new URL(c.req.url).pathname);
  const rel = pathname.replace(/^\/+/, '');

  // (1) Extension'd path → static asset from dist/. Miss = real 404.
  if (rel && extname(rel)) {
    const abs = safeDistPath(rel);
    if (abs && existsSync(abs) && statSync(abs).isFile()) {
      return serveFile(abs, 200);
    }
    return new Response('Not found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  // (2) Extensionless → SPA shell. Client router (TSR) owns the route,
  //     including its own not-found component, so this is always 200.
  const indexPath = join(SPA_DIST_ROOT, 'index.html');
  if (existsSync(indexPath)) return serveIndexHtmlWithWorkspace(indexPath, c.req.raw);

  // dist/ not built — actionable 503 rather than a bare crash.
  return new Response(
    'operator-vite is not built. Run `npm --workspace @papercusp/operator-vite run build`.',
    { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } },
  );
});
