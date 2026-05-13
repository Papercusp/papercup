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
  const sessionUser = await getSessionUser();
  const user = sessionUser ?? (await getSessionUserOrDefault());
  const available = await listUsers();
  return NextResponse.json({ user, autoLogin: sessionUser === null, available });
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
