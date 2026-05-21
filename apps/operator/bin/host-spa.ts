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
spaRoutes.get('*', (c) => {
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
  if (existsSync(indexPath)) return serveFile(indexPath, 200);

  // dist/ not built — actionable 503 rather than a bare crash.
  return new Response(
    'operator-vite is not built. Run `npm --workspace @papercusp/operator-vite run build`.',
    { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } },
  );
});
