/**
 * GET /api/admin/llm-tests/runs
 *
 * List recent llm_test_runs. Filter by `?target=&scenario=&status=`.
 * Returns a small projection — full transcript is fetched via the
 * run-detail route.
 */

import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

import { getHarnessAdminUrl } from '@/lib/embedded-pg-discovery';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

let pool: ReturnType<typeof postgres> | null = null;
function db() {
  if (!pool) pool = postgres(getHarnessAdminUrl(), { max: 4, prepare: false });
  return pool;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const target = url.searchParams.get('target') ?? undefined;
  const scenario = url.searchParams.get('scenario') ?? undefined;
  const status = url.searchParams.get('status') ?? undefined;
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));

  const sql = db();
  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT id, scenario_id, scenario_version, scenario_target, identity_hash,
           matrix_group_id, matrix_index,
           rubric_version, sut_model, judge_model,
           persona_id, status,
           started_at, finished_at, cost_usd,
           scores_json, findings_count, cap_breaches
    FROM harness_shared.llm_test_runs
    WHERE (${target ?? null}::text IS NULL OR scenario_target = ${target ?? null})
      AND (${scenario ?? null}::text IS NULL OR scenario_id = ${scenario ?? null})
      AND (${status ?? null}::text IS NULL OR status = ${status ?? null})
    ORDER BY started_at DESC
    LIMIT ${limit}
  `;

  return NextResponse.json({ runs: rows });
}
