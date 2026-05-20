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
import { sweepOrphanSnapshots } from '@/lib/backup/orphan-cleanup';
import { PrincipalCheckError, requirePrincipal } from '@/lib/auth/require-principal';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request) {
  // Admin: require 'trusted' principal (superuser bearer / spawn URL /
  // process-internal). Loopback alone is rejected — pre-consolidation
  // behavior required *both* loopback AND the bearer, which the
  // 'trusted' allowlist preserves.
  try {
    await requirePrincipal(req.headers, { trust: ['trusted'] });
  } catch (err) {
    if (err instanceof PrincipalCheckError) {
      return NextResponse.json({ error: err.reason }, { status: err.status });
    }
    throw err;
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
