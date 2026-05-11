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
import { getOrgPg } from '@restart/db-org';
import { isLoopbackRequest, isValidSuperuserBearer } from '@/lib/superuser-token';
import { ensureSpawnSigVerificationFailuresTable } from '@/lib/ensure-schema';

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
  const { sql } = getOrgPg();

  const sinceTs = since ? new Date(since) : null;
  if (since && (!sinceTs || Number.isNaN(sinceTs.getTime()))) {
    return NextResponse.json({ error: 'invalid_since' }, { status: 400 });
  }

  const rows = await sql`
    SELECT id, ts, reason, claimed_role, claimed_harness, claimed_workspace,
           claimed_spawn, exp_claim, remote_addr, user_agent
    FROM harness_shared.spawn_sig_verification_failures
    WHERE ${sinceTs ? sql`ts > ${sinceTs}` : sql`true`}
      AND ${reason ? sql`reason = ${reason}` : sql`true`}
    ORDER BY ts DESC
    LIMIT ${limit}
  `;

  const summary = await sql<{ reason: string; count: string }[]>`
    SELECT reason, count(*)::text as count
    FROM harness_shared.spawn_sig_verification_failures
    WHERE ${sinceTs ? sql`ts > ${sinceTs}` : sql`ts > now() - interval '24 hours'`}
    GROUP BY reason
    ORDER BY 2 DESC
  `;

  return NextResponse.json({
    rows,
    summary: {
      byReason: Object.fromEntries(summary.map((r) => [r.reason, Number(r.count)])),
      window: sinceTs ? sinceTs.toISOString() : 'last 24h',
    },
  });
}
