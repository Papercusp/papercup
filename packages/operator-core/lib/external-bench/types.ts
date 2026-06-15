/**
 * external-bench — the SHARED CONTRACT for the impartial benchmark suite
 * (plan `impartial-benchmark-suite-2026-06-15`). One normalized vocabulary every arm
 * (Papercusp full spine / Baseline A ablation / Baseline B native / Baseline C best-of-N)
 * and the official graders build to, so the comparison is fair by construction:
 *
 *   the GENERATION half is arm-specific  → each arm produces an {@link ArmAttempt}/{@link ArmSubmission}
 *   the GRADING half is byte-identical    → every arm hands its submission to the SAME {@link OfficialGrader}
 *
 * Two grader MODALITIES (feasibility spike D-008, dc09a, `external-bench-grader-feasibility-2026-06-15.md`):
 *   M1 offline diff-batch  — SWE-bench Pro etc.: arm → unified diff; grading is a separate, arm-agnostic
 *                            Docker batch over a predictions JSON. PILOT BACKBONE (P-009) — built first.
 *   M2 online in-container — Terminal-Bench/Harbor, Harness-Bench: no diff; agent mutates a benchmark
 *                            sandbox, grading runs in-sandbox. Built second.
 *
 * OWNERSHIP (this file = BRIEF 3 / P-005, su-ec8fe): the normalized types + port aliases live here so the
 * whole wave imports ONE source of truth. Implementations live in their owners' files:
 *   - clone/diff (Port 1)            → ./clone.ts                         (P-005, this brief)
 *   - OfficialGrader + M1 backend    → ./grader/*                         (P-005, this brief)
 *   - runArmGeneration / Papercusp   → ./arm-generation.ts               (P-005, this brief)
 *   - runSingleAgentAttempt (Port 2) → ./single-agent-attempt.ts          (P-006 / BRIEF 4, su-136a4)
 *   - instantiateBenchHarness        → ./run-loop.ts (or a sibling)       (P-019 / BRIEF 2, su-1226c)
 *   - run-result row / scoring       → BRIEF 7/8 (P-011/P-010) consume {@link ArmAttempt}+{@link GradeResult}
 */

/* -------------------------------------------------------------------------- */
/* Tasks                                                                       */
/* -------------------------------------------------------------------------- */

/** Which benchmark family a task belongs to (open string — new families add a literal). */
export type BenchmarkFamily = 'swe-bench-pro' | 'terminal-bench' | 'harness-bench' | (string & {});

/**
 * One benchmark task, normalized across families. The arm only ever sees the
 * `problemStatement` (the work_item brief) + the repo coordinates; everything the grader needs
 * is carried opaquely in {@link BenchTask.graderMeta} so a new family adds NO new arm-facing fields.
 */
export interface BenchTask {
  benchmark: BenchmarkFamily;
  /** e.g. "instance_astropy__astropy-12345" — the stable per-task id (matches across submission/grade). */
  instanceId: string;
  /** The brief fed to the harness as the work_item. NEVER the gold patch. */
  problemStatement: string;

  // ---- M1 (diff-batch) repo coordinates — present for SWE-bench-family tasks ----
  /** owner/name (M1). */
  repo?: string;
  /** Clone @ this SHA; the diff is taken against it (M1). */
  baseCommit?: string;
  /** Multi-language families (Pro is polyglot): the task's primary language. */
  language?: string;

  /**
   * Opaque grader inputs threaded verbatim to the {@link OfficialGrader} backend — e.g. SWE-bench Pro's
   * `dockerhub_tag`, `FAIL_TO_PASS`, `PASS_TO_PASS`, `test_patch`, test commands; Harbor's image ref.
   * The arm MUST NOT read this (keeps generation grader-agnostic / un-gameable). The grader owns its keys.
   */
  graderMeta: Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* Generation — what an arm produces                                           */
/* -------------------------------------------------------------------------- */

/**
 * The iso-budget ceiling for ONE generation attempt. BRIEF 7 (P-011, su-4ac61) owns the canonical
 * type + the enforcement semantics; this is the minimal structural shape the generation side consumes.
 * Reconcile to BRIEF 7's exported type when it lands (alias or re-export — single source of truth).
 */
export interface GenerationBudget {
  /** Hard cap on total tokens (in+out, across every agent incl. coordination overhead). */
  maxTokens?: number;
  /** Hard cap on total $ for the attempt (coordination overhead counted — D fairness #2). */
  maxUsd?: number;
  /** Wall-clock ceiling for the attempt. */
  maxWallClockMs?: number;
}

/** Why a generation attempt stopped — separates a clean finish from a cap-hit from an infra failure. */
export type GenerationStopReason =
  | 'done' // the harness reached DONE
  | 'escalate' // the harness ESCALATEd (needs human / blocked)
  | 'budget-exhausted' // hit the iso-budget cap
  | 'max-turns'
  | 'error'; // infra failure during generation

/**
 * What ONE generation attempt produces — the SHARED generation unit across arms (Baseline A is exactly
 * one of these; Baseline C is N + a verifier + select; the full Papercusp arm is one with the full spine).
 * `arm` + `blueprintId` make spine-ON vs spine-OFF unambiguous on the row (D-002 causal isolation).
 */
export interface ArmAttempt {
  /** Arm id on the row — 'papercusp' | 'ablation-solo' | 'native' | 'best-of-n' (BRIEF 7/8 own the enum). */
  arm: string;
  /** The blueprint that produced it — 'external-bench' (full spine) | 'coding-solo' (single worker) | … */
  blueprintId: string;
  instanceId: string;
  /** Reproducibility seed; == {@link ArmSubmission.prefix} (one prefix per seed for the ≥3-seed pass@1). */
  seed: string;

  /** Unified diff base..HEAD, grader test-files excluded; "" when the arm produced no change (M1). */
  diff: string;

  // ---- cost accounting (coordination overhead INCLUDED — fairness #2) ----
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  turns: number;
  wallClockMs: number;

  /** BRIEF 8 (P-010) rollout-record handle for this attempt's full trajectory. */
  trajectoryRef: string;

  stopReason: GenerationStopReason;
  /** Infra failure during GENERATION — distinct from "not resolved" AND from the grader's graderError. */
  generationError?: string;
}

/**
 * What an arm hands to the grader. M1 → a unified diff (+ its seed as `prefix`); M2 → a mutated env handle.
 * BRIEF 5 (native) and BRIEF 6 (best-of-N) emit the SAME `{modality:'diff', …}` record as Papercusp so all
 * arms hit identical grading machinery — the fairness invariant (D-004/D-005).
 */
export type ArmSubmission =
  | {
      modality: 'diff'; // M1 (SWE-bench Pro etc.)
      instanceId: string;
      /** The unified diff to apply + grade. */
      patch: string;
      /** Seed/sample discriminator → the predictions-JSON `prefix` field. == {@link ArmAttempt.seed}. */
      prefix: string;
    }
  | {
      modality: 'in-container'; // M2 (Terminal-Bench/Harbor) — env left mutated for in-sandbox grading
      instanceId: string;
      envRef: string;
      prefix: string;
    };

/** Build the M1 predictions record for an attempt (the shape `swe_bench_pro_eval.py` ingests). */
export function diffSubmission(attempt: ArmAttempt): ArmSubmission {
  return { modality: 'diff', instanceId: attempt.instanceId, patch: attempt.diff, prefix: attempt.seed };
}

/* -------------------------------------------------------------------------- */
/* Grading — the official, arm-agnostic half                                   */
/* -------------------------------------------------------------------------- */

/** Per-test outcome for the SWE-bench FAIL_TO_PASS / PASS_TO_PASS split (M1 only). */
export interface TestOutcome {
  test: string;
  passed: boolean;
}

/**
 * Normalized grader output → the grader-emitted slice of the run-result row (feasibility doc §5).
 * `rawGraderOutput` is stored VERBATIM (Rollout-Cards reproducibility); `graderError` (an infra failure
 * such as an image-pull fail or timeout) is DISTINCT from `resolved:false` and is excluded from accuracy.
 */
export interface GradeResult {
  instanceId: string;
  /** Seed/sample this graded — matches {@link ArmSubmission} `prefix` (one grade per (instance, seed)). */
  prefix: string;
  /** The headline pass/fail. M1: all FAIL_TO_PASS pass AND all PASS_TO_PASS still pass; M2: verifier pass. */
  resolved: boolean;
  /** Per-test (M1 / SWE-bench semantics); undefined for M2 (all-or-nothing). */
  failToPass?: TestOutcome[];
  passToPass?: TestOutcome[];
  /** The benchmark's own report JSON, stored verbatim. */
  rawGraderOutput: unknown;
  /** Family + exact version pinned for pre-registration (P-010): image tag / harbor ver / clawbench commit. */
  graderFamily: string;
  graderVersion: string;
  /** Infra failure (NOT "not resolved"): image pull fail, grader timeout, apply error. Surfaced, not scored. */
  graderError?: string;
}

/**
 * The grader-interface BRIEF 3 implements two backends for (M1 diff-batch first, M2 in-container second).
 * `grade` is PURE w.r.t. the arm — it cannot tell which arm produced a submission, which is what makes the
 * comparison fair. The same instance + graderVersion grades every arm for a given (task, seed).
 */
export interface OfficialGrader {
  family: BenchmarkFamily;
  modality: 'diff' | 'in-container';
  /** Grade a batch. `tasks` carries each instance's {@link BenchTask.graderMeta}; matched by instanceId. */
  grade(submissions: ArmSubmission[], tasks: BenchTask[]): Promise<GradeResult[]>;
}

/* -------------------------------------------------------------------------- */
/* Port aliases — the seams arms inject (hive-eval live-ports pattern)         */
/* -------------------------------------------------------------------------- */

/** A clean checkout of a task repo @ its base commit. `cleanup` removes the scratch dir. */
export interface TaskCheckout {
  /** Absolute path to the clean worktree the arm edits. */
  dir: string;
  repo: string;
  baseCommit: string;
  cleanup(): Promise<void>;
}

export interface CloneOpts {
  /** Scratch root to clone under (default: an OS temp dir). */
  workRoot?: string;
}

/** Port 1a (P-005): clone a task repo @ base commit into a clean scratch worktree. */
export type CloneTaskRepo = (task: BenchTask, opts?: CloneOpts) => Promise<TaskCheckout>;

/**
 * Port 1b (P-005): extract the final unified diff from a checkout the arm has edited — `git diff` against
 * the base commit, EXCLUDING any test files the grader supplies (so the arm can't slip the hidden tests in).
 */
export type ExtractDiff = (checkout: TaskCheckout, task: BenchTask) => Promise<string>;

/** Telemetry a harness run reports back — the cost/stop accounting that flows into {@link ArmAttempt}. */
export interface GenerationTelemetry {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  turns: number;
  wallClockMs: number;
  trajectoryRef: string;
  stopReason: GenerationStopReason;
  generationError?: string;
}

/** What instantiating + running a throwaway bench harness to DONE yields. */
export interface BenchHarnessRun {
  /** The worktree the harness edited (diff is taken from here). Usually === checkout.dir. */
  worktreePath: string;
  telemetry: GenerationTelemetry;
}

/**
 * Port (P-019 / BRIEF 2, su-1226c owns the impl): spin a throwaway harness of `blueprintId` over the
 * checkout, feed `task.problemStatement` as the work_item, run to DONE under `budget`, return telemetry.
 * The FULL Papercusp arm passes 'external-bench' (full spine); Baseline A passes 'coding-solo' (one worker).
 * Everything else (clone, infra, cap, diff-extract, grader) is byte-identical → the only delta is the spine.
 */
export type InstantiateBenchHarness = (
  blueprintId: string,
  task: BenchTask,
  checkout: TaskCheckout,
  budget: GenerationBudget,
) => Promise<BenchHarnessRun>;

/** The injected port set a generation attempt needs (fakes in tests; live fns in production). */
export interface GenerationPorts {
  clone: CloneTaskRepo;
  extractDiff: ExtractDiff;
  instantiate: InstantiateBenchHarness;
}
