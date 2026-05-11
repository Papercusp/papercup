/**
 * GET /api/admin/spawn-signing/failures
 *
 * Read the spawn-URL verification audit table for on-call review.
 * Loopback + superuser-bearer gated, same envelope as `rotate`.
 *
 * Query params:
 *   - `limit` — max rows (default 100, max 1000)
 *   - `since` — ISO timestamp; only rows with ts > since
 *   - `reason` — filter by reason (e.g. `invalid_signature`, `expired`)
 *
 * Returns:
 *   {
 *     rows: [{ id, ts, reason, claimed_role, claimed_harness,
 *              claimed_workspace, claimed_spawn, exp_claim,
 *              remote_addr, user_agent }],
 *     summary: { byReason: { invalid_signature: 4, expired: 1, ... } }
 *   }
 */
import { NextResponse } from 'next/server';
import { getOrgPg, generated } from '@restart/db-org';
import { and, count, desc, eq, gt, sql as dsql } from 'drizzle-orm';
import { isLoopbackRequest, isValidSuperuserBearer } from '@/lib/superuser-token';
import { ensureSpawnSigVerificationFailuresTable } from '@/lib/ensure-schema';

const sf = generated.spawn_sig_verification_failuresInHarness_shared;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  if (!isLoopbackRequest(req.headers)) {
    return NextResponse.json({ error: 'loopback_required' }, { status: 403 });
  }
  const auth = req.headers.get('authorization') ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!isValidSuperuserBearer(bearer)) {
    return NextResponse.json({ error: 'invalid_bearer' }, { status: 401 });
  }

  const url = new URL(req.url);
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100));
  const since = url.searchParams.get('since');
  const reason = url.searchParams.get('reason');

  await ensureSpawnSigVerificationFailuresTable();
  const { db } = getOrgPg();

  const sinceTs = since ? new Date(since) : null;
  if (since && (!sinceTs || Number.isNaN(sinceTs.getTime()))) {
    return NextResponse.json({ error: 'invalid_since' }, { status: 400 });
  }

  const rowsWhere = and(
    sinceTs ? gt(sf.ts, sinceTs as any) : undefined,
    reason ? eq(sf.reason, reason) : undefined,
  );
  const rows = await db
    .select({
      id: sf.id,
      ts: sf.ts,
      reason: sf.reason,
      claimed_role: sf.claimed_role,
      claimed_harness: sf.claimed_harness,
      claimed_workspace: sf.claimed_workspace,
      claimed_spawn: sf.claimed_spawn,
      exp_claim: sf.exp_claim,
      remote_addr: sf.remote_addr,
      user_agent: sf.user_agent,
    })
    .from(sf)
    .where(rowsWhere)
    .orderBy(desc(sf.ts))
    .limit(limit);

  const summary = await db
    .select({ reason: sf.reason, count: count() })
    .from(sf)
    .where(sinceTs ? gt(sf.ts, sinceTs as any) : dsql`${sf.ts} > now() - interval '24 hours'`)
    .groupBy(sf.reason)
    .orderBy(desc(count()));

  return NextResponse.json({
    rows,
    summary: {
      byReason: Object.fromEntries(summary.map((r) => [r.reason, Number(r.count)])),
      window: sinceTs ? sinceTs.toISOString() : 'last 24h',
    },
  });
}
