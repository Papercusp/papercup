import { NextResponse } from 'next/server';
import { requestMagicLink, sendMagicLinkEmail, ipFromHeaders } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  if (!email) return NextResponse.json({ error: 'email required' }, { status: 400 });

  let token: string;
  try {
    const ip = await ipFromHeaders();
    const result = await requestMagicLink(email, ip);
    token = result.token;
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'failed' }, { status: 400 });
  }

  // Build the magic link URL using the *Host* header the browser sent
  // (e.g. "localhost:3055"), not the bind address from req.url
  // (which is "0.0.0.0:3055" under `next dev -H 0.0.0.0`). Cookies set on
  // 0.0.0.0 aren't sent when the user later browses via localhost, so the
  // session would silently fail to apply.
  const proto = req.headers.get('x-forwarded-proto') ?? new URL(req.url).protocol.replace(':', '');
  const host = req.headers.get('host') ?? new URL(req.url).host;
  const magicUrl = `${proto}://${host}/api/auth/verify?token=${token}`;
  await sendMagicLinkEmail(email.toLowerCase(), magicUrl);

  // In dev we also surface the link in the response so manual testing
  // doesn't require tailing the server log. Production builds should
  // strip this — return only `{ ok: true }`.
  const exposeLink = process.env.NODE_ENV !== 'production';
  return NextResponse.json({ ok: true, ...(exposeLink ? { devMagicUrl: magicUrl } : {}) });
}
