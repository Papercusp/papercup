import { NextResponse, type NextRequest } from 'next/server';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Next 16 renamed `middleware.ts` → `proxy.ts` and the exported
 * `middleware` function → `proxy`. Keeping the old names triggers a
 * deprecation warning AND breaks `next build` page-data collection
 * (Cannot find module .next/server/middleware-manifest.json) because
 * Next 16 emits proxy-* manifests but its build pipeline still
 * looks up middleware-manifest.json by string.
 *
 * This single proxy handles three concerns:
 *  1. /api/* — exact-origin credentialed CORS for local desktop/mobile shells
 *     before Hono or standalone Next route handlers run.
 *  2. /internal/docs/* — loopback-only gate for the internal engineering
 *     docs (Starlight static output served from public/). Reachable on
 *     127.0.0.1 / localhost / the Tauri webview; denied for non-loopback
 *     Host headers (e.g. the api.papercupai.com tunnel) unless
 *     PAPERCUSP_INTERNAL_DOCS_BYPASS=1.
 *  3. /internal/docs/<slug>  — slug-to-html resolution. Astro emits
 *     <slug>.html under apps/operator/public/internal/docs/; the
 *     middleware rewrites bare slugs to the .html twin **only when the
 *     file exists**. Unknown slugs serve the Starlight-branded 404 with
 *     HTTP 404 (NOT 500 as the previous next.config.js afterFiles
 *     rewrite produced, since a rewrite to a missing public file is a
 *     dev-mode 500). Per-page `Accept: text/markdown` negotiation
 *     similarly resolves to the static <slug>.md twin emitted by
 *     apps/operator-docs/scripts/emit-md-twins.ts. Aggregate llms*.txt
 *     remain at the same paths.
 *
 *  proxy.ts runs on the Node.js runtime (see `export const config`
 *  below) because the docs-slug resolver does fs.existsSync — Edge
 *  has no filesystem access.
 */


const LOCAL_API_CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, if-match, last-event-id, x-requested-with',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Max-Age': '600',
  Vary: 'Origin, Access-Control-Request-Headers',
} as const;

const LOCAL_API_ORIGIN_HOSTS = new Set(['localhost', '127.0.0.1', '10.0.2.2', 'tauri.localhost']);
const LOCAL_API_ORIGIN_PROTOCOLS = new Set(['http:', 'https:', 'tauri:', 'capacitor:', 'ionic:']);

// Hostnames that count as loopback for the /internal/docs gate — the
// local-API host set plus the IPv6 loopback literal.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '10.0.2.2', 'tauri.localhost']);

// Root of the static Starlight docs the proxy resolves slugs against.
// process.cwd() is apps/operator in dev (next dev) and the operator
// app root in standalone builds (server.js cwd) — both have public/.
const PUBLIC_DOCS_ROOT = join(process.cwd(), 'public', 'internal', 'docs');

function allowedLocalApiOrigin(origin: string | null): string | null {
  if (!origin) return null;
  if (origin === 'null') return 'null';

  try {
    const url = new URL(origin);
    if (!LOCAL_API_ORIGIN_PROTOCOLS.has(url.protocol)) return null;
    if (LOCAL_API_ORIGIN_HOSTS.has(url.hostname)) return origin;
  } catch {
    return null;
  }

  return null;
}

/**
 * True when the request's Host header points at a loopback address.
 * Strips the port: `127.0.0.1:3070` → `127.0.0.1`, `[::1]:3070` → `::1`.
 */
function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  const lower = host.trim().toLowerCase();
  if (LOOPBACK_HOSTS.has(lower)) return true;
  let hostname = lower;
  if (hostname.startsWith('[')) {
    hostname = hostname.slice(1, hostname.indexOf(']'));
  } else if (hostname.includes(':')) {
    hostname = hostname.slice(0, hostname.indexOf(':'));
  }
  return LOOPBACK_HOSTS.has(hostname);
}

export function proxy(req: NextRequest) {
  const pathname = req.nextUrl.pathname;
  const origin = req.headers.get('origin');
  const corsOrigin = pathname.startsWith('/api/')
    ? allowedLocalApiOrigin(origin)
    : null;
  if (corsOrigin) {
    const headers = {
      'Access-Control-Allow-Origin': corsOrigin,
      ...LOCAL_API_CORS_HEADERS,
    };
    if (req.method === 'OPTIONS') {
      return new NextResponse(null, { status: 204, headers });
    }
    const response = NextResponse.next();
    for (const [key, value] of Object.entries(headers)) {
      response.headers.set(key, value);
    }
    return response;
  }

  // /internal/docs/* — loopback-only gate. The internal engineering docs
  // (Starlight static output) are readable from 127.0.0.1 / localhost /
  // the Tauri webview, but not over a non-loopback Host (the
  // api.papercupai.com tunnel). PAPERCUSP_INTERNAL_DOCS_BYPASS=1 forces
  // them open.
  if (pathname.startsWith('/internal/docs')) {
    const loopback = isLoopbackHost(req.headers.get('host'));
    if (!(loopback || process.env.PAPERCUSP_INTERNAL_DOCS_BYPASS === '1')) {
      return new NextResponse(
        'Internal engineering docs are loopback-only. Reach them on 127.0.0.1 / localhost, or set PAPERCUSP_INTERNAL_DOCS_BYPASS=1 to expose them.',
        { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } },
      );
    }
    // Per-page Accept: text/markdown — serve the .md twin. The twins live
    // next to the .html files in public/internal/docs/ (emitted by
    // apps/operator-docs/scripts/emit-md-twins.ts). Twin must exist —
    // unknown slugs fall through to the .html resolver below (which
    // serves 404). Static-asset extensions skip negotiation entirely.
    const accept = req.headers.get('accept') ?? '';
    if (
      accept.includes('text/markdown') &&
      !/\.(md|txt|html|xml|js|css|json|svg|png|jpe?g|webp|gif|woff2?)$/i.test(pathname)
    ) {
      const stem =
        pathname === '/internal/docs'
          ? '/internal/docs/index'
          : pathname.replace(/\/$/, '');
      if (existsSync(join(PUBLIC_DOCS_ROOT, `${stem.slice('/internal/docs/'.length)}.md`))) {
        return NextResponse.rewrite(new URL(`${stem}.md`, req.url));
      }
      // Unknown slug + Accept: text/markdown → 404 plain
      return new NextResponse('Not found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    // Bare slug / docs root → resolve to .html if it exists; otherwise
    // serve the Starlight-branded 404 page with HTTP 404. Skip resolution
    // for paths that already carry a static-asset extension (the file
    // either exists in public/ or doesn't; Next handles either way).
    const isExtless = pathname === '/internal/docs' || !/\.[a-z0-9]+$/i.test(pathname);
    if (isExtless) {
      const slug =
        pathname === '/internal/docs' || pathname === '/internal/docs/'
          ? 'index'
          : pathname.slice('/internal/docs/'.length).replace(/\/$/, '');
      if (existsSync(join(PUBLIC_DOCS_ROOT, `${slug}.html`))) {
        return NextResponse.rewrite(new URL(`/internal/docs/${slug}.html`, req.url));
      }
      // Unknown slug — serve the Starlight 404 body with proper status.
      const notFoundPath = join(PUBLIC_DOCS_ROOT, '404.html');
      if (existsSync(notFoundPath)) {
        return new NextResponse(readFileSync(notFoundPath, 'utf-8'), {
          status: 404,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      return new NextResponse('Not found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  // The matcher must include every path proxy() acts on:
  //   /api/*           — local credentialed API CORS
  //   /internal/docs/* — loopback-only docs gate + slug-to-html resolver
  matcher: ['/api/:path*', '/internal/docs/:path*'],
  // Node.js runtime is required because the /internal/docs slug-to-html
  // resolver uses fs.existsSync — Edge has no filesystem access.
  runtime: 'nodejs',
};
