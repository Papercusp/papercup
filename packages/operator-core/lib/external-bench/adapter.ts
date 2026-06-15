/**
 * The grader adapter orchestration (P-005 / BRIEF 3, the headline deliverable): take one benchmark task →
 * generate (clone → coding harness → diff) → grade (official, arm-agnostic) → emit the run-result row.
 *
 * The persisted row + rollout card + pre-reg are owned by P-010/P-011 (`reproducibility/emit.ts`,
 * `@papercusp/bench-metrics`). This file produces the {@link ArmAttempt} + {@link GradeResult} slices and
 * maps them onto the LOCKED `emitRollout` input (66ad9's schema v1). The emit + grader are injected ports,
 * so the whole adapter is unit-testable with fakes and the real wiring is a single binding.
 *
 * SCORING CONTRACT honored here (66ad9): a row is SCOREABLE iff generation completed AND the grader returned
 * passed|failed. A generation that errored/timed-out/exhausted-budget is NOT graded → `grading.status =
 * 'skipped'`, `resolved = null` → excluded from accuracy (METR: an infra fail is not a capability fail).
 */
import { diffSubmission, type ArmAttempt, type BenchTask, type GradeResult, type OfficialGrader } from './types';

/* -------------------------------------------------------------------------- */
/* emitRollout input — the LOCKED v1 contract (66ad9, P-010).                  */
/* RECONCILE: import this type from reproducibility/emit.ts once that lands —  */
/* it is the single source of truth; this mirror exists only to unblock build. */
/* -------------------------------------------------------------------------- */

export type GenerationStatusWire = 'completed' | 'error' | 'timeout' | 'budget_exhausted';
export type GraderStatusWire = 'passed' | 'failed' | 'error' | 'timeout' | 'skipped';

export interface EmitRolloutInput {
  run_id: string;
  prereg_hash: string;
  suite: string;
  task_id: string;
  arm: string;
  seed: number;
  modality: 'diff' | 'in-container';
  generation: {
    status: GenerationStatusWire;
    error?: string;
    tokens_in: number;
    tokens_out: number;
    /** SUM over ALL roles/candidates (+ verifier for best-of-N) — coordination overhead counted. */
    tokens_total: number;
    tokens_cache_read?: number;
    tokens_cache_write?: number;
    wall_clock_ms: number;
    turns?: number;
    /** Iso-budget cap on GENERATION; omit = uncapped. */
    budget_tokens?: number;
    capped?: boolean;
    model_id: string;
    harness_version: string;
    arm_meta?: Record<string, unknown>;
    /** The exact diff (M1) / envRef (M2) graded. */
    submission?: string;
    trajectory_ref?: string;
    trajectory_kind?: string;
  };
  grading: {
    resolved: boolean | null;
    status: GraderStatusWire;
    family: string;
    version: string;
    error?: string;
    structured_output?: { failToPass?: GradeResult['failToPass']; passToPass?: GradeResult['passToPass'] };
    raw_output?: unknown;
  };
  provenance?: {
    config_snapshot?: unknown;
    model_version?: string;
    harness_git_sha?: string;
    env_fingerprint?: string;
  };
}

/** The injected emit port — the live binding is `emitRollout` from `reproducibility/emit.ts` (P-010). */
export type EmitRollout = (input: EmitRolloutInput) => Promise<{ rollout_id: string; run_id: string }>;

/** Stable per-seed prefix (the predictions-JSON `prefix`) from an integer seed index. */
export function seedPrefix(seedIndex: number): string {
  return `seed-${seedIndex}`;
}

/** Map an attempt's stop reason onto the wire generation status (raw stopReason preserved in arm_meta). */
export function generationStatus(attempt: ArmAttempt): GenerationStatusWire {
  switch (attempt.stopReason) {
    case 'budget-exhausted':
      return 'budget_exhausted';
    case 'error':
      return 'error';
    // done / escalate / max-turns are GENUINE terminations that produced a diff to grade.
    default:
      return 'completed';
  }
}

/** Fields a single emit needs that are common across a run. */
export interface EmitContext {
  runId: string;
  preregHash: string;
  /** == run_result.suite (REPORT_ON_SUITES vocab, P-012 firewall). e.g. 'swe-bench-pro'. */
  suite: string;
  seedIndex: number;
  modelId: string;
  harnessVersion: string;
  /** Grader family/version stamped on SKIPPED rows (where there is no GradeResult to read them from). */
  graderFamily: string;
  graderVersion: string;
  /** Iso-budget token cap recorded on the row (omit = uncapped). */
  budgetTokens?: number;
  provenance?: EmitRolloutInput['provenance'];
}

function gradingBlock(grade: GradeResult | undefined, generationOk: boolean, ctx: EmitContext): EmitRolloutInput['grading'] {
  if (!generationOk || !grade) {
    return { resolved: null, status: 'skipped', family: ctx.graderFamily, version: ctx.graderVersion };
  }
  if (grade.graderError) {
    return {
      resolved: null,
      status: 'error',
      family: grade.graderFamily,
      version: grade.graderVersion,
      error: grade.graderError,
      raw_output: grade.rawGraderOutput,
    };
  }
  return {
    resolved: grade.resolved,
    status: grade.resolved ? 'passed' : 'failed',
    family: grade.graderFamily,
    version: grade.graderVersion,
    structured_output: { failToPass: grade.failToPass, passToPass: grade.passToPass },
    raw_output: grade.rawGraderOutput,
  };
}

/** PURE mapper: an attempt + its grade (if any) → the LOCKED emitRollout input. Fully unit-testable. */
export function toEmitInput(attempt: ArmAttempt, grade: GradeResult | undefined, ctx: EmitContext): EmitRolloutInput {
  const status = generationStatus(attempt);
  const generationOk = status === 'completed';
  return {
    run_id: ctx.runId,
    prereg_hash: ctx.preregHash,
    suite: ctx.suite,
    task_id: attempt.instanceId,
    arm: attempt.arm,
    seed: ctx.seedIndex,
    modality: 'diff',
    generation: {
      status,
      error: attempt.generationError,
      tokens_in: attempt.tokensIn,
      tokens_out: attempt.tokensOut,
      tokens_total: attempt.tokensIn + attempt.tokensOut,
      tokens_cache_read: attempt.tokensCacheRead,
      tokens_cache_write: attempt.tokensCacheWrite,
      wall_clock_ms: attempt.wallClockMs,
      turns: attempt.turns,
      budget_tokens: ctx.budgetTokens,
      capped: attempt.stopReason === 'budget-exhausted',
      model_id: ctx.modelId,
      harness_version: ctx.harnessVersion,
      // Merge the arm's extra metadata; the canonical blueprintId + stopReason always win over it.
      arm_meta: { ...(attempt.armMeta ?? {}), blueprintId: attempt.blueprintId, stopReason: attempt.stopReason },
      submission: attempt.diff,
      trajectory_ref: attempt.trajectoryRef || undefined,
      trajectory_kind: attempt.trajectoryRef ? 'git-diff' : undefined,
    },
    grading: gradingBlock(grade, generationOk, ctx),
    provenance: ctx.provenance,
  };
}

/* -------------------------------------------------------------------------- */
/* Grade + emit                                                                */
/* -------------------------------------------------------------------------- */

export interface BatchEntry {
  attempt: ArmAttempt;
  task: BenchTask;
  seedIndex: number;
}

export interface BatchContext {
  runId: string;
  preregHash: string;
  suite: string;
  modelId: string;
  harnessVersion: string;
  budgetTokens?: number;
  provenance?: EmitRolloutInput['provenance'];
}

export interface AdapterRowResult {
  attempt: ArmAttempt;
  grade?: GradeResult;
  rollout: { rollout_id: string; run_id: string };
}

/**
 * Batch-grade the COMPLETED attempts in `entries` once (M1 grading is most efficient batched + arm-agnostic),
 * then emit every row (completed → graded; infra-failed → skipped/null). The run-loop (P-019) calls this
 * after generating across many (task, seed). Grader family/version are taken from the grader instance.
 */
export async function gradeAndEmitBatch(
  entries: BatchEntry[],
  grader: OfficialGrader,
  emit: EmitRollout,
  ctx: BatchContext,
): Promise<AdapterRowResult[]> {
  const toGrade = entries.filter((e) => generationStatus(e.attempt) === 'completed');
  const submissions = toGrade.map((e) => diffSubmission(e.attempt));
  const tasks = toGrade.map((e) => e.task);

  const grades = submissions.length > 0 ? await grader.grade(submissions, tasks) : [];
  const gradeByKey = new Map(grades.map((g) => [`${g.instanceId}__${g.prefix}`, g]));

  const results: AdapterRowResult[] = [];
  for (const { attempt, seedIndex } of entries) {
    const grade = gradeByKey.get(`${attempt.instanceId}__${attempt.seed}`);
    const emitCtx: EmitContext = {
      runId: ctx.runId,
      preregHash: ctx.preregHash,
      suite: ctx.suite,
      seedIndex,
      modelId: ctx.modelId,
      harnessVersion: ctx.harnessVersion,
      graderFamily: grader.family,
      graderVersion: grade?.graderVersion ?? ctx.suite,
      budgetTokens: ctx.budgetTokens,
      provenance: ctx.provenance,
    };
    const rollout = await emit(toEmitInput(attempt, grade, emitCtx));
    results.push({ attempt, grade, rollout });
  }
  return results;
}

/* -------------------------------------------------------------------------- */
/* One task, end-to-end (the brief's headline deliverable)                     */
/* -------------------------------------------------------------------------- */

export interface RunTaskInput {
  task: BenchTask;
  ctx: BatchContext & { seedIndex: number };
  /** Generate the attempt (e.g. `(t,seed,budget) => runPapercuspArm(t, seed, budget, ports)`). */
  generate: (task: BenchTask, seed: string) => Promise<ArmAttempt>;
  grader: OfficialGrader;
  emit: EmitRollout;
}

/**
 * Run ONE benchmark task all the way to a graded, costed, emitted result. Generates, grades the single
 * submission (M1 grader handles a batch of one), and emits the row. This is the unit the brief promises:
 * "an adapter that takes one task id and produces a graded, costed result."
 */
export async function runTaskThroughAdapter(input: RunTaskInput): Promise<AdapterRowResult> {
  const { task, ctx, generate, grader, emit } = input;
  const attempt = await generate(task, seedPrefix(ctx.seedIndex));
  const [result] = await gradeAndEmitBatch([{ attempt, task, seedIndex: ctx.seedIndex }], grader, emit, ctx);
  return result;
}
