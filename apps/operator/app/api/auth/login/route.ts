import { NextResponse } from 'next/server';
import { cookies, headers } from 'next/headers';
import { login, SESSION_COOKIE, DEFAULT_SESSION_TTL_MS } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : null;
  const ttl_ms = typeof body?.ttl_ms === 'number' ? body.ttl_ms : DEFAULT_SESSION_TTL_MS;
  if (!username) {
    return NextResponse.json({ error: 'username required' }, { status: 400 });
  }

  const h = await headers();
  try {
    const result = await login(username, password, {
      user_agent: h.get('user-agent') ?? undefined,
      remote_addr: h.get('x-forwarded-for') ?? undefined,
      ttl_ms,
    });
    const jar = await cookies();
    jar.set({
      name: SESSION_COOKIE,
      value: result.token,
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      expires: result.expires_at,
    });
    return NextResponse.json({ ok: true, user: result.user });
  } catch (e: unknown) {
    const code = (e as { code?: string }).code ?? 'login_failed';
    const status = code === 'unknown_user' || code === 'bad_password' ? 401 : 400;
    return NextResponse.json({ error: code }, { status });
  }
}
