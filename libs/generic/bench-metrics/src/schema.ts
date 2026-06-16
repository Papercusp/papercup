/**
 * THE canonical run-result schema for the impartial benchmark suite
 * (`impartial-benchmark-suite-2026-06-15`). Co-owned by P-011 (this lib —
 * cost/scoring) and P-010 (reproducibility harness). Every consumer imports
 * `TaskRunResult` from here so there is ONE shape across the wave:
 *   - P-005 (grader adapter) + the four arm runners (Baselines A/B/C + Papercusp)
 *     EMIT it; P-010's emission layer writes it to the PG `run_result` table.
 *   - P-010 wraps each row with a `rollout` (Rollout-Card repro artifact) + a
 *     `prereg` (pre-registered config) — those layers are P-010's, referenced
 *     here only by id/hash.
 *   - P-020 (Evaluation UI) + P-016 (methodology doc) READ the aggregates.
 *   - This lib's `aggregate.ts` folds `TaskRunResult[]` → per-arm reports.
 *
 * The row is the per-(task × arm × seed) scoreable unit. Reconciled from:
 *   P-010 v0 three-layer shape + P-011 deltas (cost DERIVED from raw tokens via
 *   a published price table; generation iso-budget fields; arm_meta; locked arm
 *   vocab; seed = attempt ordinal) + P-001 §5 grader slice + 2-modality finding
 *   (apps/operator/docs/external-bench-grader-feasibility-2026-06-15.md).
 *
 * FAIRNESS INVARIANTS encoded by the field semantics:
 *  - `tokensTotal` is SUMMED across every agent + turn (all spine roles +
 *    coordination for Papercusp; all N candidates + the verifier for best-of-N),
 *    so coordination overhead is counted in OUR own number.
 *  - The iso-budget cap (`budgetTokens`) bounds GENERATION only; grading is
 *    uncapped and byte-for-byte identical across arms (P-001 §5).
 *  - `costUsd` is DERIVED from raw tokens × ONE published price table
 *    (`priceTableVersion`), applied identically to every arm — never
 *    provider-reported $ for one arm and computed for another. Always
 *    recomputable by a third party from the stored tokens + the table.
 */

/** The four comparison arms — LOCKED vocabulary; the delta math keys on these. */
export type ArmId =
  | 'papercusp' //            the treatment: full multi-agent spine + coordination substrate
  | 'baseline-a-ablation' //  single-worker ablation (identical tools/model/infra/budget)
  | 'baseline-b-native' //    native harness (Claude Code on the same model) — the headline baseline
  | 'baseline-c-bestofn'; //  best-of-N + test-verifier at matched token budget

export const ARM_IDS: readonly ArmId[] = [
  'papercusp',
  'baseline-a-ablation',
  'baseline-b-native',
  'baseline-c-bestofn',
] as const;

/** Benchmark family. Open string union — new suites add a literal here. */
export type BenchSuite =
  | 'swe-bench-pro'
  | 'swe-bench-verified'
  | 'terminal-bench'
  | 'harness-bench'
  | 'swe-evo'
  | 'swe-rebench'
  | (string & {});

/** Grader modality (P-001 §1): offline diff-batch vs online in-container. */
export type GraderModality = 'diff' | 'in-container';

/**
 * Normalized grader outcome. `error`/`timeout` are INFRA failures, distinct
 * from a genuine `failed` — they are excluded from accuracy and surfaced
 * separately (METR elicitation discipline; P-001 §5).
 */
export type GraderStatus = 'passed' | 'failed' | 'error' | 'timeout';

/**
 * Outcome of the GENERATION half (parallel to GraderStatus, distinct surface —
 * P-006/P-008). `completed` = the arm produced a submission (graded normally,
 * even if it ran to the iso-budget cap — see `capped`). `error`/`timeout` =
 * generation itself failed (agent crashed, OOM, no submission produced) — an
 * INFRA failure excluded from accuracy and surfaced separately, NOT a genuine
 * `failed`. So a row is scored for accuracy only when BOTH generationStatus and
 * graderStatus are non-infra.
 */
export type GenerationStatus = 'completed' | 'error' | 'timeout';

/** Per-test result (SWE-bench FAIL_TO_PASS / PASS_TO_PASS; M1/diff only). */
export interface TestOutcome {
  test: string;
  passed: boolean;
}

/**
 * One graded, costed task run: the per-(task × arm × seed) row. Mirrors the PG
 * `run_result` table (P-010 owns the migration since P-010 emits). Field groups
 * are tagged by owner so consumers know which half they fill.
 */
export interface TaskRunResult {
  // ── identity ──────────────────────────────────────────────────────────────
  /** Groups one pilot execution (all tasks × arms × seeds). */
  runId: string;
  suite: BenchSuite;
  modality: GraderModality;
  /** Benchmark task identifier (e.g. SWE-bench Pro `instance_id`). */
  taskId: string;
  arm: ArmId;
  /** Independent-attempt ordinal — ≥3 distinct per (task × arm). SWE-bench Pro `prefix`. */
  seed: number;

  // ── grader slice (P-001 §5; emitted by the OfficialGrader, identical per arm)
  /** Headline pass/fail. M1: FAIL_TO_PASS ∧ PASS_TO_PASS; M2: verifier pass/fail.
   *  NULL when the row was never genuinely graded (generation or grader infra
   *  error) — null ≠ false; null rows are excluded from accuracy, not counted as
   *  fails (P-010 co-def + METR discipline). Scored rows carry a real boolean. */
  resolved: boolean | null;
  graderStatus: GraderStatus;
  graderFamily: string;
  /** Pinned exactly for pre-registration (image tag / `terminal-bench@2.0`+harbor ver / clawbench commit). */
  graderVersion: string;
  /** M1 only (null for M2): per-test breakdown. */
  failToPass?: TestOutcome[] | null;
  passToPass?: TestOutcome[] | null;

  // ── generation / cost slice (P-011 — this lib) ────────────────────────────
  /** SUMMED across every agent + turn (coordination overhead counted). */
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
  /** Prompt-cache tokens (nullable) — they move $ materially; counted in cost. */
  tokensCacheRead?: number | null;
  tokensCacheWrite?: number | null;
  /** DERIVED via priceRun(tokens, modelId, table). Recomputable from raw tokens. */
  costUsd: number;
  /** The price table version `costUsd` was computed under (e.g. 'price-table-v1'). */
  priceTableVersion: string;
  wallClockMs: number;
  /** Agent steps / turns. */
  turns: number;
  /** GENERATION iso-budget cap this run ran under (null = uncapped / native). */
  budgetTokens?: number | null;
  /** Did generation hit/terminate at the cap? (a capped run ≠ a genuine fail). */
  capped: boolean;
  /** Generation outcome (parallel to graderStatus). error/timeout = infra, excluded from accuracy. */
  generationStatus: GenerationStatus;
  /** Free-text generation failure detail (null unless generationStatus is error/timeout). */
  generationError?: string | null;
  /** Arm-specific detail; OPAQUE to scoring, published for reproducibility.
   *  Baseline C: { n, selectedCandidate, candidates:[{tokensIn,tokensOut,verifierPass,score}], verifierTokens }. */
  armMeta?: Record<string, unknown> | null;

  // ── reproducibility slice (P-010 — referenced here by id/hash/ref) ────────
  /** Exact model id, e.g. 'claude-opus-4-8[1m]'. */
  modelId: string;
  /** Blueprint version + git sha of the harness. */
  harnessVersion: string;
  /** The pre-registered config hash this ran under; every row must match a prereg. */
  preregHash: string;
  /** FK → P-010's `rollout` (the Rollout-Card published artifact). */
  rolloutId: string;
  /** Artifact pointer — the benchmark's own report JSON, stored verbatim. */
  rawGraderOutputRef?: string | null;
  /** Artifact pointer — M1: the exact diff graded, per seed. */
  submissionRef?: string | null;
  createdAt: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Report shapes — what `aggregate.ts` produces and the UI (P-020) + doc (P-016)
// read. These are the OUTPUT contract; TaskRunResult is the INPUT contract.
// ───────────────────────────────────────────────────────────────────────────

import type { Interval } from './intervals';

/** Token + dollar accounting for an arm (or arm × suite), all SUMMED. */
export interface CostAccount {
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  costUsd: number;
  /** Mean generation tokens per task-attempt (the iso-budget axis). */
  tokensPerRun: number;
  /** $ per resolved task — the "more resolved per dollar" headline denominator. */
  costPerResolved: number | null;
}

/** A pass@k point at one k, with the tasks it was estimated over. */
export interface PassAtKPoint {
  k: number;
  value: number;
  tasksUsed: number;
  skipped: number;
}

/** The aggregated result for ONE arm on ONE suite. */
export interface ArmReport {
  arm: ArmId;
  suite: BenchSuite;
  /** Distinct tasks and total scored attempts (excludes infra-error rows). */
  tasks: number;
  attempts: number;
  /** Attempts dropped because graderStatus was error/timeout (surfaced, not scored). */
  infraErrors: number;
  /** Of the GENERATION runs, how many hit the iso-budget cap. */
  cappedRuns: number;
  /** The iso-budget cap shared by these runs (null = uncapped, or mixed → see verifyIsoBudget). */
  budgetTokens: number | null;
  /** pass@1 = mean over tasks of (mean over seeds of resolved). The headline accuracy. */
  passAt1: number;
  /** Bootstrap CI over tasks for pass@1 (task heterogeneity is the dominant noise). */
  passAt1Ci: Interval;
  /** Wilson interval on the pooled task×seed Bernoulli resolved-rate (cross-check). */
  resolvedRateWilson: Interval;
  /** pass@k / pass^k at the protocol k's (same k for every arm). */
  passAtK: PassAtKPoint[];
  passHatK: PassAtKPoint[];
  cost: CostAccount;
}

/** Papercusp − baseline on the two headline axes (the system-value delta, D-001). */
export interface ArmDelta {
  suite: BenchSuite;
  treatment: ArmId; // 'papercusp'
  baseline: ArmId;
  /** passAt1(treatment) − passAt1(baseline). Positive = treatment resolves more. */
  accuracyDelta: number;
  /** costPerResolved ratio treatment/baseline (null if a denominator is 0). */
  costRatio: number | null;
  /** treatment cost as a fraction of baseline cost ("at Z% of the cost"). */
  costFraction: number | null;
  /** Is the treatment strictly Pareto-better (≥ accuracy AND ≤ cost, > on one)? */
  paretoDominates: boolean;
}

/** One point on the cost/accuracy frontier (per arm). */
export interface ParetoPoint {
  arm: ArmId;
  accuracy: number;
  /** Mean $ per task-attempt (the cost axis). */
  cost: number;
  costPerResolved: number | null;
  onFrontier: boolean;
}

/** The full per-suite report the Evaluation surface renders. */
export interface SuiteReport {
  runId: string;
  suite: BenchSuite;
  arms: ArmReport[];
  /** Cost/accuracy frontier across arms; `onFrontier` flags the non-dominated set. */
  frontier: ParetoPoint[];
  /** Papercusp vs each baseline on the headline axes. */
  deltas: ArmDelta[];
  /** Iso-budget invariant check across arms (all arms share the same cap?). */
  isoBudget: { ok: boolean; budgetTokens: number | null; violations: string[] };
  /** The k's the pass@k/pass^k protocol used (identical across arms). */
  protocolKs: number[];
}
