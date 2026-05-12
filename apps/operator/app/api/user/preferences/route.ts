import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { loadUserPreferences, saveUserPreferences, clearUserPreferenceKey } from '@/lib/user-preferences';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const payload = await loadUserPreferences(user.id);
  return NextResponse.json({ payload });
}

export async function PATCH(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const payload = await saveUserPreferences(user.id, body as Record<string, unknown>);
  return NextResponse.json({ payload });
}

export async function DELETE(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  if (!key) return NextResponse.json({ error: 'key_required' }, { status: 400 });
  await clearUserPreferenceKey(user.id, key);
  return NextResponse.json({ ok: true });
}
