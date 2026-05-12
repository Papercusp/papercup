/**
 * POST /api/admin/embed-backfill
 *
 * Loopback + superuser-bearer gated. Triggers a one-shot
 * `runBackfillSweep()`. Used when the operator has been running long
 * enough that the boot-time sweep already missed unembedded rows
 * (e.g. after a schema migration that added new rows, or after a
 * memoryEmbedderMode switch).
 *
 * Returns per-table BackfillStats[]; takes 0-minutes-to-tens-of-
 * seconds depending on how many rows are NULL.
 */

import { NextResponse } from 'next/server';
import { isLoopbackRequest, isValidSuperuserBearer } from '@/lib/superuser-token';
import { runBackfillSweep } from '@/lib/search/embed-backfill';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 600;

export async function POST(req: Request) {
  if (!isLoopbackRequest(req.headers)) {
    return NextResponse.json({ error: 'loopback_only' }, { status: 403 });
  }
  const auth = req.headers.get('authorization') ?? '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null;
  if (!isValidSuperuserBearer(bearer)) {
    return NextResponse.json({ error: 'invalid_superuser' }, { status: 401 });
  }
  try {
    const result = await runBackfillSweep();
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json(
      { error: 'sweep_failed', message: (err as Error).message },
      { status: 500 },
    );
  }
}
