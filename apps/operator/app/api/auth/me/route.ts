import { NextResponse } from 'next/server';
import { getSessionUser, listUsers, updateDisplayName } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/auth/me — returns the current session user + the list of
 * available users (for the login page's username dropdown).
 *
 * Single endpoint by design: the login page needs both, and the navbar
 * user picker uses the `available` array.
 */
export async function GET() {
  const user = await getSessionUser();
  const available = await listUsers();
  return NextResponse.json({ user, available });
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
