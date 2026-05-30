import { NextResponse, type NextRequest } from 'next/server';

/*
 * Stub auth gate for /internal/docs/*.
 * Returns 401 unless PAPERCUP_INTERNAL_DOCS_BYPASS=1.
 * Replace with real auth before exposing internal docs.
 */
export function middleware(_req: NextRequest) {
  if (process.env.PAPERCUP_INTERNAL_DOCS_BYPASS === '1') {
    return NextResponse.next();
  }
  return new NextResponse(
    'Internal docs are gated. Set PAPERCUP_INTERNAL_DOCS_BYPASS=1 to bypass during development.',
    { status: 401, headers: { 'content-type': 'text/plain; charset=utf-8' } },
  );
}

export const config = {
  matcher: ['/internal/docs/:path*'],
};
