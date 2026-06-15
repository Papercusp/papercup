/**
 * Gym PG data-access (P-012/P-013 read+write) against the dedicated gym database.
 *
 * Thin typed helpers over the harness_gym tables — used by the loop's persist seam,
 * the trace collector (run refs/signals), and the comparison read API (P-013). JSONB
 * columns are written as `${JSON.stringify(x)}::jsonb` (NOT sql.json(), which throws
 * under postgres-js v3.4 on this stack — peer-confirmed 2026-06-02).
 */
import type { Sql } from 'postgres';
import type { VariantOverlay } from './variant-overlay';
import type { GymScore } from './judge';
import { assertGymTaskNotContaminated } from './report-set-firewall';

export interface VariantRow {
  variantId: string;
  parentId?: string | null;
  label: string;
  overlay: VariantOverlay;
  diffFromParent?: string | null;
  proposerRationale?: string | null;
  status?: string;
}

export async function insertVariant(sql: Sql, v: VariantRow): Promise<void> {
  await sql`
    INSERT INTO harness_gym.gym_variants (variant_id, parent_id, label, prompt_overrides, diff_from_parent, proposer_rationale, status)
    VALUES (${v.variantId}, ${v.parentId ?? null}, ${v.label}, ${JSON.stringify(v.overlay.promptOverrides)}::text::jsonb,
            ${v.diffFromParent ?? null}, ${v.proposerRationale ?? null}, ${v.status ?? 'candidate'})
    ON CONFLICT (variant_id) DO UPDATE SET status = EXCLUDED.status, diff_from_parent = EXCLUDED.diff_from_parent`;
}

export interface TaskRow {
  taskId: string;
  pool: string;
  repoUrl: string;
  repoCommit: string;
  spec: string;
  intent: string;
  plantedBug?: unknown;
  generatedBy?: string;
  /**
   * The declared source set this task came from (e.g. 'gym-synthetic'). Vetted by the
   * gym↔report-set firewall (P-012): a report-on benchmark set is refused here so the gym
   * can never tune on a set the impartial suite reports on. See report-set-firewall.ts.
   */
  sourceSet?: string;
}

export async function insertTask(sql: Sql, t: TaskRow): Promise<void> {
  // Firewall (P-012/D-005): refuse any task that originates from a report-on benchmark set
  // BEFORE it can enter the gym corpus — this is the single ingestion choke point.
  assertGymTaskNotContaminated({
    taskId: t.taskId,
    repoUrl: t.repoUrl,
    repoCommit: t.repoCommit,
    sourceSet: t.sourceSet,
    generatedBy: t.generatedBy,
  });
  await sql`
    INSERT INTO harness_gym.gym_tasks (task_id, pool, repo_url, repo_commit, spec, intent, planted_bug, generated_by)
    VALUES (${t.taskId}, ${t.pool}, ${t.repoUrl}, ${t.repoCommit}, ${t.spec}, ${t.intent},
            ${t.plantedBug ? JSON.stringify(t.plantedBug) : null}::text::jsonb, ${t.generatedBy ?? null})
    ON CONFLICT (task_id) DO NOTHING`;
}

export async function insertRun(
  sql: Sql,
  r: { runId: string; variantId: string; taskId: string; cycle: number; repeat?: number; harnessSlug?: string; workflowId?: string },
): Promise<void> {
  await sql`
    INSERT INTO harness_gym.gym_runs (run_id, variant_id, task_id, cycle, repeat, harness_slug, workflow_id)
    VALUES (${r.runId}, ${r.variantId}, ${r.taskId}, ${r.cycle}, ${r.repeat ?? 0}, ${r.harnessSlug ?? null}, ${r.workflowId ?? null})
    ON CONFLICT (run_id) DO NOTHING`;
}

export async function finishRun(
  sql: Sql,
  runId: string,
  fields: { terminalState: string; deterministicSignals: unknown; traceRef?: string; distilledRef?: string; elapsedMs?: number },
): Promise<void> {
  await sql`
    UPDATE harness_gym.gym_runs
       SET terminal_state = ${fields.terminalState},
           deterministic_signals = ${JSON.stringify(fields.deterministicSignals ?? {})}::text::jsonb,
           trace_ref = ${fields.traceRef ?? null},
           distilled_ref = ${fields.distilledRef ?? null},
           finished_at = now(),
           elapsed_ms = ${fields.elapsedMs ?? null}
     WHERE run_id = ${runId}`;
}

export async function insertScore(sql: Sql, runId: string, s: GymScore): Promise<void> {
  await sql`
    INSERT INTO harness_gym.gym_scores (run_id, judge_model, rubric_hash, judge_temp, weights, d1, d2, d3, composite, rationale)
    VALUES (${runId}, ${s.judgeModel}, ${s.rubricHash}, ${s.judgeTemp}, ${JSON.stringify(s.weights)}::text::jsonb,
            ${s.d1}, ${s.d2}, ${s.d3}, ${s.composite}, ${s.rationale})
    ON CONFLICT (run_id, rubric_hash) DO UPDATE
      SET d1 = EXCLUDED.d1, d2 = EXCLUDED.d2, d3 = EXCLUDED.d3, composite = EXCLUDED.composite, rationale = EXCLUDED.rationale`;
}

export async function insertRunParams(
  sql: Sql,
  runId: string,
  p: { harnessCommit: string; substrateCommit: string; mutableRoles?: unknown; judgeModel?: string; judgeTemp?: number; weights?: unknown; rubricHash?: string },
): Promise<void> {
  await sql`
    INSERT INTO harness_gym.gym_runs_params (run_id, harness_commit, substrate_commit, mutable_roles, judge_model, judge_temp, weights, rubric_hash)
    VALUES (${runId}, ${p.harnessCommit}, ${p.substrateCommit}, ${p.mutableRoles ? JSON.stringify(p.mutableRoles) : null}::text::jsonb,
            ${p.judgeModel ?? null}, ${p.judgeTemp ?? null}, ${p.weights ? JSON.stringify(p.weights) : null}::text::jsonb, ${p.rubricHash ?? null})
    ON CONFLICT (run_id) DO NOTHING`;
}

/**
 * Persist one optimization-loop cycle (P-022 audit trail → gym_cycles). The loop's
 * `deps.persistCycle` seam binds here. `cycleId` is deterministic per cycle so a retried
 * cycle is idempotent; `budgetSpentUsd` records the running spend at decision time.
 */
export async function insertCycle(
  sql: Sql,
  c: {
    cycleId: string;
    cycle: number;
    parentId: string;
    candidateId: string;
    decision: 'accept' | 'reject';
    gateResults: unknown;
    budgetSpentUsd?: number;
  },
): Promise<void> {
  await sql`
    INSERT INTO harness_gym.gym_cycles (cycle_id, cycle, parent_id, candidate_id, decision, gate_results, budget_spent_usd)
    VALUES (${c.cycleId}, ${c.cycle}, ${c.parentId}, ${c.candidateId}, ${c.decision},
            ${JSON.stringify(c.gateResults ?? {})}::text::jsonb, ${c.budgetSpentUsd ?? null})
    ON CONFLICT (cycle_id) DO UPDATE
      SET decision = EXCLUDED.decision, gate_results = EXCLUDED.gate_results, budget_spent_usd = EXCLUDED.budget_spent_usd`;
}

export interface VariantComparisonRow {
  taskId: string;
  aComposite: number | null;
  bComposite: number | null;
  delta: number | null;
}

/**
 * P-013 per-task A-vs-B: each task's composite for variant A and B (under one rubric)
 * + the signed delta (B − A). Tasks evaluated by either variant appear; missing side null.
 */
export async function compareVariants(
  sql: Sql,
  variantA: string,
  variantB: string,
  rubricHash: string,
): Promise<VariantComparisonRow[]> {
  const rows = await sql<{ task_id: string; a: number | null; b: number | null }[]>`
    WITH scored AS (
      SELECT r.task_id, r.variant_id, s.composite
        FROM harness_gym.gym_runs r
        JOIN harness_gym.gym_scores s ON s.run_id = r.run_id AND s.rubric_hash = ${rubricHash}
       WHERE r.variant_id IN (${variantA}, ${variantB})
    )
    SELECT task_id,
           MAX(composite) FILTER (WHERE variant_id = ${variantA}) AS a,
           MAX(composite) FILTER (WHERE variant_id = ${variantB}) AS b
      FROM scored
     GROUP BY task_id
     ORDER BY task_id`;
  return rows.map((r) => ({
    taskId: r.task_id,
    aComposite: r.a,
    bComposite: r.b,
    delta: r.a !== null && r.b !== null ? r.b - r.a : null,
  }));
}
