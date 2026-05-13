import { NextResponse } from 'next/server';
import { cookies, headers } from 'next/headers';
import { logout, SESSION_COOKIE, getSessionUser } from '@/lib/auth';
import { recordAuthEvent } from '@/lib/auth-audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const h = await headers();
  // Resolve username pre-delete so the audit row has it.
  const user = await getSessionUser().catch(() => null);
  if (token) {
    await logout(token).catch(() => { /* best-effort */ });
  }
  jar.delete(SESSION_COOKIE);
  void recordAuthEvent({
    kind: 'logout',
    username: user?.username,
    ip: h.get('x-forwarded-for') ?? '127.0.0.1',
    userAgent: h.get('user-agent') ?? undefined,
    ok: true,
    sessionToken: token,
  });
  return NextResponse.json({ ok: true });
}
