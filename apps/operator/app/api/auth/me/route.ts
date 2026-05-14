import { NextResponse } from 'next/server';
import { getSessionUser, getSessionUserOrDefault, listUsers, updateDisplayName } from '@/lib/auth';

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
  // Each PG-touching call is wrapped — if embedded-pg is unreachable
  // (no discovery file, port mid-restart, fresh-install racing the
  // bootstrap migration), return a synthetic auto-login user so chrome
  // UI (UserPicker, AutoLoginWelcomeToast) still renders. The
  // alternative — letting the route 500 — silently hides the entire
  // user-controls cluster from the navbar with no on-screen hint that
  // anything's wrong (round-14 + this turn's bug).
  let sessionUser: Awaited<ReturnType<typeof getSessionUser>> = null;
  try {
    sessionUser = await getSessionUser();
  } catch {
    // Cookie lookup needs PG; on failure, treat as no session.
  }

  if (sessionUser) {
    let available: Awaited<ReturnType<typeof listUsers>> = [];
    try {
      available = await listUsers();
    } catch {
      /* available list is a UI nicety; safe to omit */
    }
    return NextResponse.json({ user: sessionUser, autoLogin: false, available });
  }

  try {
    const user = await getSessionUserOrDefault();
    let available: Awaited<ReturnType<typeof listUsers>> = [];
    try {
      available = await listUsers();
    } catch {
      /* same as above */
    }
    return NextResponse.json({ user, autoLogin: true, available });
  } catch {
    // PG fully unreachable. Synthesize the default user so chrome UI
    // still mounts. has_password=false matches the seeded default-user
    // contract (no password). pgUnavailable signals the degraded mode
    // to clients that want to surface it.
    return NextResponse.json({
      user: {
        id: '00000000-0000-0000-0000-000000000001',
        username: 'default',
        display_name: 'User',
        has_password: false,
      },
      autoLogin: true,
      available: [],
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
