import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logout, SESSION_COOKIE } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await logout(token).catch(() => { /* best-effort */ });
  }
  jar.delete(SESSION_COOKIE);
  return NextResponse.json({ ok: true });
}
