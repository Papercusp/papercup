import { NextResponse, type NextRequest } from 'next/server';

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
 *  2. /internal/docs/* — stub auth gate (loopback-only docs).
 *  Note: per-page Accept-header markdown negotiation removed at the
 *  fumadocs->Starlight cutover. Agents use docs:* MCP tools or the
 *  /internal/docs/llms.txt + /llms-full.txt static surfaces.
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

  // 1. /internal/docs/* — auth gate. Order matters: gate before any
  //    other rewrite so the markdown negotiation can't bypass it.
  if (pathname.startsWith('/internal/docs')) {
    if (process.env.PAPERCUSP_INTERNAL_DOCS_BYPASS === '1') {
      return NextResponse.next();
    }
    return new NextResponse(
      'Internal docs are gated. Set PAPERCUSP_INTERNAL_DOCS_BYPASS=1 to bypass during development.',
      { status: 401, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }


  return NextResponse.next();
}

export const config = {
  // The matcher must include every path the proxy() function might
  // act on. Local API CORS + /internal/docs gating
  // negotiation.
  matcher: ['/api/:path*', '/internal/docs/:path*', '/docs/:path*'],
};
