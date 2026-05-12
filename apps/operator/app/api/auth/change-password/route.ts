import { NextResponse } from 'next/server';
import { getSessionUser, changePassword } from '@/lib/auth';

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
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const code = (e as { code?: string }).code ?? 'failed';
    return NextResponse.json({ error: code }, { status: 400 });
  }
}
