import { NextResponse } from 'next/server';
import { cookies, headers } from 'next/headers';
import {
  getSessionUser,
  getSessionUserOrDefault,
  listUsers,
  login,
  updateDisplayName,
  SESSION_COOKIE,
  DEFAULT_SESSION_TTL_MS,
} from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/auth/me — returns the current session user + the list of
 * available users (for the login page's username dropdown).
 *
 * Falls through to the seeded `default` user when no session cookie is
 * present. This matches the semantics every memory tool +
 * operator-converse uses via `getSessionUserOrDefault` — the UserPicker,
 * the welcome toast, and any code that asks "who is signed in?" all
 * get a consistent answer on auto-login installs.
 *
 * Returns `{ user, autoLogin }`. `autoLogin: true` means there was no
 * cookie and the response is from the default fallback; client code
 * uses this to suppress "Sign in" CTAs on routes that don't strictly
 * require explicit auth.
 */
export async function GET() {
  // Each PG-touching call is wrapped so a failure here doesn't 500 the
  // whole chrome UI — UserPicker silently bails on non-OK responses,
  // and that produced the "no top-right button" symptom we hit twice.
  //
  // 2026-05-14: errors are now LOGGED with `console.error` instead of
  // swallowed. The previous silent-catch round-15 fix masked real
  // misconfigurations (e.g. missing migration, wrong creds) as
  // "pgUnavailable" with no server-side hint at the actual cause.
  let sessionUser: Awaited<ReturnType<typeof getSessionUser>> = null;
  let getSessionUserError: unknown;
  try {
    sessionUser = await getSessionUser();
  } catch (err) {
    getSessionUserError = err;
    console.error('[auth/me] getSessionUser threw — will fall through to default user:', err);
  }

  if (sessionUser) {
    let available: Awaited<ReturnType<typeof listUsers>> = [];
    try {
      available = await listUsers();
    } catch (err) {
      console.error('[auth/me] listUsers threw (non-fatal):', err);
    }
    return NextResponse.json({ user: sessionUser, autoLogin: false, available });
  }

  try {
    const user = await getSessionUserOrDefault();
    let available: Awaited<ReturnType<typeof listUsers>> = [];
    try {
      available = await listUsers();
    } catch (err) {
      console.error('[auth/me] listUsers threw (non-fatal):', err);
    }
    // Auto-establish a real session for passwordless users so endpoints
    // that strictly require a session cookie (state-snapshot SSE etc.)
    // don't 401 on the chrome's first paint. Single-user / passwordless
    // installs are the common operator scenario; this is the same
    // user the UI is already rendering as.
    if (!user.has_password) {
      try {
        const h = await headers();
        const result = await login(user.username, null, {
          user_agent: h.get('user-agent') ?? undefined,
          remote_addr: h.get('x-forwarded-for') ?? '127.0.0.1',
        });
        const jar = await cookies();
        jar.set(SESSION_COOKIE, result.token, {
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          maxAge: Math.floor(DEFAULT_SESSION_TTL_MS / 1000),
        });
      } catch (err) {
        console.error('[auth/me] auto-session establish failed (non-fatal):', err);
      }
    }
    return NextResponse.json({ user, autoLogin: true, available });
  } catch (err) {
    // Fall back to a synthetic default user so the chrome UI still
    // renders. Surface what actually broke so the operator log shows
    // the root cause instead of the generic "pgUnavailable" lie.
    const reason = err instanceof Error ? err.message : String(err);
    console.error('[auth/me] getSessionUserOrDefault failed — returning synthetic default with reason:', reason, err);
    return NextResponse.json({
      user: {
        id: '00000000-0000-0000-0000-000000000001',
        username: 'default',
        display_name: 'User',
        has_password: false,
      },
      autoLogin: true,
      available: [],
      degraded: true,
      degradedReason: reason,
      // Deprecated alias kept for one cycle so any existing client
      // checks against `pgUnavailable` keep working.
      pgUnavailable: true,
    });
  }
}

/**
 * PATCH /api/auth/me — update display name. Only field editable today;
 * username is immutable, password has its own endpoint.
 */
export async function PATCH(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => null);
  const display_name = typeof body?.display_name === 'string' ? body.display_name.trim() : '';
  if (!display_name) {
    return NextResponse.json({ error: 'display_name_required' }, { status: 400 });
  }
  if (display_name.length > 80) {
    return NextResponse.json({ error: 'display_name_too_long' }, { status: 400 });
  }
  await updateDisplayName(user.id, display_name);
  return NextResponse.json({ ok: true });
}
