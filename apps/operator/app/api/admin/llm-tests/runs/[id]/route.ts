/**
 * GET /api/admin/llm-tests/runs/[id]
 *
 * Full run detail — transcript + findings + telemetry + judge.
 */

import { NextResponse } from 'next/server';
import postgres from 'postgres';

import { getHarnessAdminUrl } from '@/lib/embedded-pg-discovery';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

let pool: ReturnType<typeof postgres> | null = null;
function db() {
  if (!pool) pool = postgres(getHarnessAdminUrl(), { max: 4, prepare: false });
  return pool;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sql = db();
  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT id, scenario_id, scenario_version, scenario_target, scenario_hash,
           identity_hash, matrix_group_id, matrix_index,
           rubric_version, sut_model, judge_model,
           persona_id, persona_traits_json,
           workspace_mode, transport_mode,
           status, started_at, finished_at,
           cost_usd, cap_breaches,
           scores_json, findings_count,
           transcript_norm_json,
           telemetry_json, asserts_json, judge_json,
           metadata_json
    FROM harness_shared.llm_test_runs
    WHERE id = ${id}
  `;
  if (rows.length === 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const findings = await sql<Array<Record<string, unknown>>>`
    SELECT id, source, severity, axis, assert_kind, shape,
           evidence_turn_idx, claim, suggestion, copy_prompt,
           acknowledged, acknowledged_by, acknowledged_at
    FROM harness_shared.llm_test_findings
    WHERE run_id = ${id}
    ORDER BY severity, source, axis
  `;
  return NextResponse.json({ run: rows[0], findings });
}
