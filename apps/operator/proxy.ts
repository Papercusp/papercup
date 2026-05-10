import { NextResponse, type NextRequest } from 'next/server';

/*
 * Stub auth gate for /internal/docs/*.
 * Returns 401 unconditionally unless PAPERCUSP_INTERNAL_DOCS_BYPASS=1.
 * Replace with real auth (cookie session, Better Auth role, VPN, etc.)
 * before exposing internal docs to anyone.
 *
 * Next 16 renamed `middleware.ts` → `proxy.ts` and the exported
 * `middleware` function → `proxy`. Keeping the old names triggers a
 * deprecation warning AND breaks `next build` page-data collection
 * (Cannot find module .next/server/middleware-manifest.json) because
 * Next 16 emits proxy-* manifests but its build pipeline still
 * looks up middleware-manifest.json by string.
 */
export function proxy(req: NextRequest) {
  if (process.env.PAPERCUSP_INTERNAL_DOCS_BYPASS === '1') {
    return NextResponse.next();
  }
  return new NextResponse(
    'Internal docs are gated. Set PAPERCUSP_INTERNAL_DOCS_BYPASS=1 to bypass during development.',
    { status: 401, headers: { 'content-type': 'text/plain; charset=utf-8' } },
  );
}

export const config = {
  matcher: ['/internal/docs/:path*'],
};
