/**
 * POST /api/admin/backup-orphan-cleanup
 *
 * Loopback + superuser-bearer gated. Triggers a one-shot
 * `sweepOrphanSnapshots()` — useful for emergency cleanups when the
 * 5-min periodic sweep is too slow (e.g. operators staring at a stuck
 * "running" row in the backups UI).
 *
 * Body (optional): { olderThanMs: number } — defaults to 60 min.
 *
 * Step D (Tier-1 follow-up arc).
 */

import { NextResponse } from 'next/server';
import { isLoopbackRequest, isValidSuperuserBearer } from '@/lib/superuser-token';
import { sweepOrphanSnapshots } from '@/lib/backup/orphan-cleanup';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!isLoopbackRequest(req.headers)) {
    return NextResponse.json({ error: 'loopback_only' }, { status: 403 });
  }
  const auth = req.headers.get('authorization') ?? '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null;
  if (!isValidSuperuserBearer(bearer)) {
    return NextResponse.json({ error: 'invalid_superuser' }, { status: 401 });
  }

  let olderThanMs: number | undefined;
  try {
    const body = await req.json();
    if (typeof body?.olderThanMs === 'number' && body.olderThanMs > 0) {
      olderThanMs = body.olderThanMs;
    }
  } catch {
    // No body or invalid JSON — accept defaults.
  }

  try {
    const result = await sweepOrphanSnapshots(olderThanMs ? { olderThanMs } : undefined);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json(
      { error: 'sweep_failed', message: (err as Error).message },
      { status: 500 },
    );
  }
}
