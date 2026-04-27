import { NextResponse, type NextRequest } from 'next/server';

/*
 * Stub auth gate for /internal/docs/*.
 * Returns 401 unconditionally unless PAPERCUSP_INTERNAL_DOCS_BYPASS=1.
 * Replace with real auth (cookie session, Better Auth role, VPN, etc.)
 * before exposing internal docs to anyone.
 */
export function middleware(req: NextRequest) {
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
