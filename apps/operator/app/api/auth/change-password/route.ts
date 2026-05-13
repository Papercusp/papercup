import { NextResponse } from 'next/server';
import { cookies, headers } from 'next/headers';
import { getSessionUser, changePassword, login, SESSION_COOKIE } from '@/lib/auth';
import { recordAuthEvent } from '@/lib/auth-audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const h = await headers();
  const userAgent = h.get('user-agent') ?? undefined;
  const ip = h.get('x-forwarded-for') ?? '127.0.0.1';

  const user = await getSessionUser();
  if (!user) {
    void recordAuthEvent({
      kind: 'change_password_no_session', ip, userAgent, ok: false,
      errorCode: 'unauthenticated',
    });
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
    const session = await login(user.username, next, {
      user_agent: userAgent,
      remote_addr: ip,
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
    void recordAuthEvent({
      kind: 'change_password_ok',
      username: user.username, ip, userAgent, ok: true,
      sessionToken: session.token,
    });
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const code = (e as { code?: string }).code ?? 'failed';
    void recordAuthEvent({
      // bad_password is the "wrong current pw" case; everything else
      // (invalid next, password too short, etc.) is a generic failure.
      // Do NOT use change_password_no_session here — that's the
      // pre-auth-check branch only.
      kind: code === 'bad_password' ? 'change_password_bad_old' : 'change_password_failed',
      username: user.username, ip, userAgent, ok: false,
      errorCode: code,
    });
    return NextResponse.json({ error: code }, { status: 400 });
  }
}
