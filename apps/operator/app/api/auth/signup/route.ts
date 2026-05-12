import { NextResponse } from 'next/server';
import { cookies, headers } from 'next/headers';
import { signup, login, SESSION_COOKIE } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const username = typeof body?.username === 'string' ? body.username : '';
  const display_name = typeof body?.display_name === 'string' ? body.display_name : '';
  const password = typeof body?.password === 'string' ? body.password : null;
  const autoLogin = body?.auto_login !== false;
  if (!username || !display_name) {
    return NextResponse.json({ error: 'username + display_name required' }, { status: 400 });
  }

  try {
    const user = await signup(username, display_name, password);
    if (autoLogin) {
      const h = await headers();
      const session = await login(user.username, password, {
        user_agent: h.get('user-agent') ?? undefined,
        remote_addr: h.get('x-forwarded-for') ?? undefined,
      });
      const jar = await cookies();
      jar.set({
        name: SESSION_COOKIE,
        value: session.token,
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
        expires: session.expires_at,
      });
    }
    return NextResponse.json({ ok: true, user });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    const code = (e as { code?: string }).code;
    if (/duplicate|unique/i.test(msg)) {
      return NextResponse.json({ error: 'username_taken' }, { status: 409 });
    }
    return NextResponse.json({ error: code ?? 'signup_failed' }, { status: 400 });
  }
}
