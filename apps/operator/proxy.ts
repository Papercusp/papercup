import { NextResponse, type NextRequest } from 'next/server';

/*
 * Next 16 renamed `middleware.ts` → `proxy.ts` and the exported
 * `middleware` function → `proxy`. Keeping the old names triggers a
 * deprecation warning AND breaks `next build` page-data collection
 * (Cannot find module .next/server/middleware-manifest.json) because
 * Next 16 emits proxy-* manifests but its build pipeline still
 * looks up middleware-manifest.json by string.
 *
 * This single proxy handles two concerns:
 *  1. /api/* — exact-origin credentialed CORS for local desktop/mobile shells
 *     before Hono or standalone Next route handlers run.
 *  2. /internal/docs/* — loopback-only gate for the internal engineering
 *     docs (Starlight static output served from public/). Reachable on
 *     127.0.0.1 / localhost / the Tauri webview; denied for non-loopback
 *     Host headers (e.g. the api.papercupai.com tunnel) unless
 *     PAPERCUSP_INTERNAL_DOCS_BYPASS=1.
 *
 *  Per-page `Accept: text/markdown` negotiation rewrites to the static
 *  <slug>.md twin emitted by apps/operator-docs/scripts/emit-md-twins.ts
 *  (sitting next to <slug>.html in apps/operator/public/internal/docs/).
 *  Restores the agent-readable per-page-markdown contract the old
 *  fumadocs setup provided via /llms.mdx/<slug>. Aggregate llms*.txt
 *  remain at the same paths.
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
    // apps/operator-docs/scripts/emit-md-twins.ts).
    const accept = req.headers.get('accept') ?? '';
    if (
      accept.includes('text/markdown') &&
      !/\.(md|txt|html|xml|js|css|json|svg|png|jpe?g|webp|gif|woff2?)$/i.test(pathname)
    ) {
      const stem =
        pathname === '/internal/docs'
          ? '/internal/docs/index'
          : pathname.replace(/\/$/, '');
      return NextResponse.rewrite(new URL(`${stem}.md`, req.url));
    }
    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  // The matcher must include every path proxy() acts on:
  //   /api/*           — local credentialed API CORS
  //   /internal/docs/* — loopback-only docs gate
  matcher: ['/api/:path*', '/internal/docs/:path*'],
};
