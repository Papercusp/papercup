import { NextResponse } from 'next/server';
import { getSessionUser, listUsers } from '@/lib/auth';

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
