/**
 * PG persistence for llm_test_runs / llm_test_findings.
 *
 * Plan §7. Inserts one row per single SUT-vs-Sim run (matrix groups
 * share matrix_group_id), then one row per finding (assert violations
 * + judge findings + variance findings).
 *
 * Schema lives in libs/papercusp/libs/db/sql/073-llm-testing.sql.
 */

import postgres from 'postgres';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

import { getHarnessAdminUrl } from '../embedded-pg-discovery';

import type { RunReport, SingleRunReport } from '@papercusp/testing-shell/llm';

let pool: ReturnType<typeof postgres> | null = null;
function db() {
  if (!pool) {
    pool = postgres(getHarnessAdminUrl(), { max: 4, prepare: false });
  }
  return pool;
}

export async function persistRunReport(report: RunReport, rubricVersion: string, scenarioHash: string): Promise<void> {
  const sql = db();
  for (const run of report.runs) {
    await persistSingleRun(sql, run, report.matrixGroupId, rubricVersion, scenarioHash);
  }
}

async function persistSingleRun(
  sql: ReturnType<typeof postgres>,
  r: SingleRunReport,
  matrixGroupId: string | undefined,
  rubricVersion: string,
  scenarioHash: string,
): Promise<void> {
  const s = r.summary;

  const findingsCount = {
    error: r.violations.filter((v) => v.severity === 'error').length
      + r.judge.findings.filter((f) => f.severity === 'error').length,
    warn: r.violations.filter((v) => v.severity === 'warn').length
      + r.judge.findings.filter((f) => f.severity === 'warn').length,
    info: r.violations.filter((v) => v.severity === 'info').length
      + r.judge.findings.filter((f) => f.severity === 'info').length,
  };

  const transcriptRaw = JSON.stringify(s.turns.flatMap((t) => t.rawSseTape));
  const transcriptRawBytes = zstdCompressSync(Buffer.from(transcriptRaw, 'utf8'));

  await sql`
    INSERT INTO harness_shared.llm_test_runs (
      id, scenario_id, scenario_version, scenario_target, scenario_hash,
      identity_hash, matrix_group_id, matrix_index,
      rubric_version, sut_model, judge_model,
      persona_id, persona_traits_json,
      workspace_mode, transport_mode,
      status, started_at, finished_at,
      cost_usd, cap_breaches,
      scores_json, findings_count,
      transcript_raw_zstd, transcript_norm_json,
      telemetry_json, asserts_json, judge_json
    ) VALUES (
      ${s.runId}, ${s.scenarioId}, ${s.scenarioVersion}, 'operator', ${scenarioHash},
      ${s.identityHash}, ${matrixGroupId ?? null}, ${s.matrixIndex ?? null},
      ${rubricVersion}, ${s.sutModel}, ${s.judgeModel},
      ${s.personaId}, ${sql.json(s.personaTraits)},
      ${s.workspaceMode}, ${s.transportMode},
      ${r.status === 'passed' ? 'passed' : r.status === 'errored' ? 'errored' : 'failed'},
      ${s.startedAt}, ${s.finishedAt},
      ${s.totalCostUsd}, ${s.capBreaches},
      ${sql.json(r.judge.scores)}, ${sql.json(findingsCount)},
      ${transcriptRawBytes}, ${sql.json(normalizeTurns(s.turns))},
      ${sql.json({ toolInvocations: s.toolInvocations, continueChainRows: s.continueChainRows, ...(s.variantId ? { variantId: s.variantId } : {}) })},
      ${sql.json({ asserts: 'see-scenario', violations: r.violations })},
      ${sql.json({ scores: r.judge.scores, findings: r.judge.findings, notes: r.judge.notes, judgeOverruledAssert: r.judge.judgeOverruledAssert, costUsd: r.judge.costUsd })}
    )
  `;

  // Findings (one row each — assert violations + judge findings).
  for (const v of r.violations) {
    await sql`
      INSERT INTO harness_shared.llm_test_findings (
        run_id, source, severity, axis, assert_kind, shape,
        evidence_turn_idx, claim, suggestion, copy_prompt,
        promoted_from
      ) VALUES (
        ${s.runId}, 'assert', ${v.severity}, NULL, ${v.assertKind}, NULL,
        ${v.evidenceTurnIdx ?? null}, ${v.claim}, ${v.suggestion ?? null}, NULL,
        ${v.originatingFindingIds ?? []}
      )
    `;
  }
  for (const f of r.judge.findings) {
    await sql`
      INSERT INTO harness_shared.llm_test_findings (
        run_id, source, severity, axis, assert_kind, shape,
        evidence_turn_idx, claim, suggestion, copy_prompt
      ) VALUES (
        ${s.runId}, 'judge', ${f.severity}, ${f.axis}, NULL, ${f.shape},
        ${f.evidenceTurnIdx ?? null}, ${f.claim}, ${f.suggestion ?? null}, ${f.copyPrompt}
      )
    `;
  }
}

/** Decompress a transcript_raw_zstd bytea cell back to the raw SSE JSON array. */
export function decompressTranscript(bytes: Buffer | Uint8Array): unknown[] {
  const decompressed = zstdDecompressSync(Buffer.from(bytes));
  return JSON.parse(decompressed.toString('utf8')) as unknown[];
}

function normalizeTurns(turns: SingleRunReport['summary']['turns']): unknown {
  return turns.map((t, idx) => ({
    idx,
    assistantText: t.assistantText,
    toolCalls: t.toolCalls,
    cards: t.cards,
    controlTags: t.controlTags,
    finishReason: t.finishReason,
    costUsd: t.costUsd,
    latencyMs: t.latencyMs,
    error: t.error,
  }));
}
