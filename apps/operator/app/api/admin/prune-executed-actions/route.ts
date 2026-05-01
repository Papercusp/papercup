/**
 * POST /api/admin/prune-executed-actions
 *
 * Deletes executed_actions rows older than `?days=30` (default) across
 * every per-harness schema. Idempotent. Auth: requires bearer token from
 * any registered harness (no privilege check beyond auth — this is
 * housekeeping, not a destructive op against another harness).
 *
 * The plan calls this out as a v1.5 deliverable since
 * `harness_<slug>.executed_actions` grows unbounded otherwise.
 */
import { NextResponse } from 'next/server';
import { getOrgPg } from '@restart/db-org';
import { deriveCallerFromBearer } from '@/lib/execute-action';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const auth = await deriveCallerFromBearer(req.headers.get('authorization'));
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error, detail: auth.detail }, { status: auth.status });
  }
  const url = new URL(req.url);
  const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days') ?? 30)));
  const dryRun = url.searchParams.get('dryRun') === '1';

  const { sql } = getOrgPg();
  const schemas = await sql<{ nspname: string }[]>`
    SELECT nspname FROM pg_namespace
    WHERE nspname LIKE 'harness\\_%' AND nspname <> 'harness_shared'
  `;

  let totalDeleted = 0;
  const perSchema: { schema: string; deleted: number }[] = [];
  for (const { nspname } of schemas) {
    const exists = await sql<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM information_schema.tables
                    WHERE table_schema = ${nspname} AND table_name = 'executed_actions') AS exists
    `;
    if (!exists[0]?.exists) continue;

    if (dryRun) {
      const r = await sql.unsafe(
        `SELECT count(*)::int AS n FROM ${nspname}.executed_actions WHERE executed_at < now() - interval '${days} days'`,
      );
      const n = (r as any)[0]?.n ?? 0;
      perSchema.push({ schema: nspname, deleted: n });
      totalDeleted += n;
    } else {
      const r = await sql.unsafe(
        `DELETE FROM ${nspname}.executed_actions WHERE executed_at < now() - interval '${days} days' RETURNING action_id`,
      );
      const n = (r as any).length ?? 0;
      perSchema.push({ schema: nspname, deleted: n });
      totalDeleted += n;
    }
  }

  return NextResponse.json({
    ok: true,
    days,
    dryRun,
    totalDeleted,
    perSchema,
  });
}
