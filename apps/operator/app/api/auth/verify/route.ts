import { NextResponse } from 'next/server';
import { verifyMagicLink, setSessionCookie, uaFromHeaders, ipFromHeaders } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  if (!token) return NextResponse.json({ error: 'token required' }, { status: 400 });

  // Build the redirect origin from the *Host* header, not req.url's host.
  // Under `next dev -H 0.0.0.0`, req.url has host=0.0.0.0; redirecting there
  // would send the user away from whichever host they actually came in on
  // (e.g. localhost), and the Set-Cookie scoped to localhost wouldn't apply.
  const proto = req.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
  const host = req.headers.get('host') ?? url.host;
  const origin = `${proto}://${host}`;

  const ua = await uaFromHeaders();
  const ip = await ipFromHeaders();
  const result = await verifyMagicLink(token, ua, ip);
  if (!result.ok) {
    const back = new URL('/login', origin);
    back.searchParams.set('error', result.reason ?? 'unknown');
    return NextResponse.redirect(back);
  }

  await setSessionCookie(result.sessionId!);
  return NextResponse.redirect(new URL('/settings/profile', origin));
}
