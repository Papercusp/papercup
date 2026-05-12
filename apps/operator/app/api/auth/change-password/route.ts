import { NextResponse } from 'next/server';
import { cookies, headers } from 'next/headers';
import { getSessionUser, changePassword, login, SESSION_COOKIE } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const current = typeof body?.current === 'string' ? body.current : null;
  const next = typeof body?.next === 'string' ? body.next : null;

  try {
    await changePassword(user.id, current, next);
    // changePassword invalidates all sessions for the user (including
    // the current cookie). Re-issue a session with the new password so
    // the user stays signed in — without this they'd silently fall to
    // an unauthenticated state on the next /api/auth/me poll.
    const h = await headers();
    const session = await login(user.username, next, {
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
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const code = (e as { code?: string }).code ?? 'failed';
    return NextResponse.json({ error: code }, { status: 400 });
  }
}
