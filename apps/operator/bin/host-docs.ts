/**
 * `/internal/docs/*` — the Starlight static site, served by the Hono host.
 *
 * Faithful port of `apps/operator/proxy.ts`'s docs concerns:
 *   1. Loopback-only gate (403 unless 127.0.0.1 / localhost / IPv6 ::1 /
 *      tauri.localhost OR `PAPERCUSP_INTERNAL_DOCS_BYPASS=1`).
 *   2. Per-page `Accept: text/markdown` → `<slug>.md` twin
 *      (emitted by apps/operator-docs/scripts/emit-md-twins.ts).
 *   3. Bare slug → `<slug>.html` resolution from `public/internal/docs/`.
 *   4. Unknown slug → serve `404.html` body with HTTP 404 (not 500).
 *   5. Extension'd paths (e.g. `_astro/foo.css`, `pagefind/*.wasm`) →
 *      serve the file directly with a sensible Content-Type.
 *
 * The docs root is resolved from `__dirname` (robust against cwd), unlike
 * `proxy.ts` which used `process.cwd()` — the audit-3 finding from the
 * `docs:*` MCP adapter.
 */
import { Hono } from 'hono';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { isLoopbackHost } from '@papercusp/operator-core/lib/endpoint-route/loopback-guard';

/**
 * Starlight docs root. `__dirname`-relative in dev (host run via `tsx`);
 * the packaged desktop esbuild-bundles the host into a single file, so the
 * build sets `PAPERCUSP_DOCS_ROOT` to the bundled docs location explicitly
 * (a bundled file's `__dirname` is the sidecar root, not `bin/`).
 */
const PUBLIC_DOCS_ROOT = process.env.PAPERCUSP_DOCS_ROOT
  ? resolve(process.env.PAPERCUSP_DOCS_ROOT)
  : resolve(__dirname, '..', 'public', 'internal', 'docs');

const EXT_CONTENT_TYPE: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
  // Pagefind index assets (WI-2648 docs-search). Pagefind ships its wasm as
  // `*.pagefind` (NOT `.wasm`) and its binary index/metadata/fragment chunks as
  // `.pf_meta` / `.pf_index` / `.pf_fragment`. Without these, the docs-search
  // palette loads its UI but every index fetch 404s → zero results (the exact
  // symptom that shipped). All fetched as ArrayBuffer, so octet-stream is safe;
  // the wasm is non-streaming-instantiated by Pagefind so it needn't be wasm-typed.
  '.pagefind': 'application/wasm',
  '.pf_meta': 'application/octet-stream',
  '.pf_index': 'application/octet-stream',
  '.pf_fragment': 'application/octet-stream',
};

const TEXT_EXTS = new Set([
  '.html', '.md', '.txt', '.xml', '.css', '.js', '.mjs', '.json', '.svg',
]);

const STATIC_ASSET_RE = /\.(md|txt|html|xml|js|mjs|css|json|svg|png|jpe?g|webp|gif|woff2?|wasm|ico|pagefind|pf_meta|pf_index|pf_fragment)$/i;
const EXT_RE = /\.[a-z0-9]+$/i;

function serveFile(absPath: string, status = 200): Response {
  const ext = extname(absPath).toLowerCase();
  const contentType = EXT_CONTENT_TYPE[ext] ?? 'application/octet-stream';
  // Decode text files; pass binaries through as Buffer.
  const body = TEXT_EXTS.has(ext)
    ? readFileSync(absPath, 'utf-8')
    : readFileSync(absPath);
  // Buffer → Response auto-promotes via Uint8Array view.
  return new Response(body, {
    status,
    headers: { 'content-type': contentType },
  });
}

export const docsRoutes = new Hono();

// Loopback gate. Runs before any docs route handler.
docsRoutes.use('/internal/docs/*', async (c, next) => {
  const ok = isLoopbackHost(c.req.header('host') ?? null)
    || process.env.PAPERCUSP_INTERNAL_DOCS_BYPASS === '1';
  if (!ok) {
    return new Response(
      'Internal engineering docs are loopback-only. Reach them on 127.0.0.1 / localhost, or set PAPERCUSP_INTERNAL_DOCS_BYPASS=1 to expose them.',
      { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }
  await next();
});

docsRoutes.get('/internal/docs/*', async (c) => {
  // Hono encodes the path; decode for fs lookup.
  const pathname = decodeURI(new URL(c.req.url).pathname);
  const rel = pathname.replace(/^\/internal\/docs\/?/, '');

  // (1) Extension'd path — serve the file directly. `_astro/*`, `pagefind/*`,
  // `*.html`, `*.md`, etc. Any extension we recognize as a static asset.
  if (rel && STATIC_ASSET_RE.test(rel)) {
    const abs = join(PUBLIC_DOCS_ROOT, rel);
    if (existsSync(abs)) return serveFile(abs, 200);
    // Asset not found — fall through to 404 below (HTML-shape).
  }

  // (2) Extensionless `+ Accept: text/markdown` → `.md` twin.
  const isExtless = !rel || !EXT_RE.test(rel);
  const accept = c.req.header('accept') ?? '';
  if (isExtless && accept.includes('text/markdown')) {
    const slug = rel === '' || rel === '/' ? 'index' : rel.replace(/\/$/, '');
    const abs = join(PUBLIC_DOCS_ROOT, `${slug}.md`);
    if (existsSync(abs)) return serveFile(abs, 200);
    return new Response('Not found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  // (3) Extensionless → `<slug>.html`.
  if (isExtless) {
    const slug = rel === '' || rel === '/' ? 'index' : rel.replace(/\/$/, '');
    const abs = join(PUBLIC_DOCS_ROOT, `${slug}.html`);
    if (existsSync(abs)) return serveFile(abs, 200);
  }

  // (4) Unknown slug — serve the Starlight 404 body with HTTP 404.
  const notFoundPath = join(PUBLIC_DOCS_ROOT, '404.html');
  if (existsSync(notFoundPath)) return serveFile(notFoundPath, 404);
  return new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
});
