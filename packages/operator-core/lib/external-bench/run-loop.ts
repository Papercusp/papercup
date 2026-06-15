/**
 * `runExternalBench` — the SHARED external-bench generation+grading orchestration,
 * the single source of truth the `external-bench:run` deterministic blueprint step
 * runs (impartial-benchmark-suite-2026-06-15 P-019 / BRIEF 2; the SIBLING of
 * `iq-battery`/`hive-eval` gen-loops, inverted to PUBLIC tasks + the EXTERNAL grader,
 * D-005).
 *
 * Per the plan's "Mapping onto Papercusp machinery" + the BRIEF 1 feasibility spike
 * (apps/operator/docs/external-bench-grader-feasibility-2026-06-15.md), the per-task
 * loop is the adapter and stays INTERNAL to the op (Option A, like iq-battery's bee
 * spawn — NOT a `spawn-roles` step): for each task → clone the repo @ base_commit →
 * spin a THROWAWAY `coding` harness (one `feature` work_item = the issue) → run to DONE
 * under the iso-budget cap → extract the diff (M1) / finished sandbox (M2) → hand to the
 * benchmark's OFFICIAL grader (BRIEF 1 §1 `OfficialGrader`) → write a per-task run-result
 * row (the BRIEF 7/8 shared schema).
 *
 * ── OWNERSHIP (BRIEF 2 ↔ BRIEF 3) ────────────────────────────────────────────────
 * BRIEF 2 (P-019) owns this file's TYPED CONTRACT — `ExternalBenchRunInput`,
 * `ExternalBenchRunOutcome`, `ExternalBenchRunDeps`, `runExternalBench`'s budget gate —
 * and ships a DEFAULT that REFUSES until the adapter is bound (the hive-eval precedent:
 * "the op's default refuses until it is bound"). So `external-bench:run` is a registered
 * known op + the blueprint validates + the colocated test passes TODAY, before the
 * adapter lands.
 *
 * BRIEF 3 (P-005) owns the BODY: replace `defaultRunner`'s stub with a lazy import of the
 * real adapter (its grader/clone/spin/diff-extract modules as new siblings under
 * `lib/external-bench/`), exactly as iq-battery's `defaultRunBattery` lazy-imports the
 * gen-0 runner. The adapter writes the per-task run-result ROWS; this orchestration
 * returns only the RUN-LEVEL outcome + the `runId` pointer (so the row shape stays
 * single-owned by BRIEF 7/8).
 *
 * Deps are injectable PARAMETERS (the op's test seam passes a fake `runner` — no
 * PG/git/Docker/LLM), mirroring `IqBatteryGenDeps`.
 */

/** One generation+grading pass's run config — the op args, normalized. */
export interface ExternalBenchRunInput {
  workspaceId: string;
  installSlug: string;
  /** The benchmark family — 'swe-bench-pro' | 'terminal-bench' | 'harness-bench' | … */
  benchmark: string;
  /** Instance ids to run; omitted ⇒ the configured split. ONE id = the smoke path. */
  taskIds?: string[];
  /** The coding-harness arm: 'papercusp' (full spine) | 'ablation-a' (single worker, P-006).
   *  Baselines B/C are SEPARATE runners that emit the BRIEF 1 §1 submission directly. */
  arm?: string;
  /** The seed / submission `prefix` for the ≥3-seed pass@1 protocol (BRIEF 1 §2). */
  seed?: number;
  /** The iso-budget cap (USD, BRIEF 7). Absent ⇒ the run is REFUSED (unattended-spend guard). */
  budgetUsd?: number;
  /** Plumbing-only: generate + record, skip the paid grader / coding spend. */
  dryRun?: boolean;
}

/**
 * The RUN-LEVEL outcome (the discriminated cadence outcome, like `iq-battery:gen`) — NOT
 * the per-task run-result row. The per-task row (resolved + the BRIEF 1 §5 grader slice +
 * tokens in/out, $, wall-clock, turns, seed, arm id, trajectory ref, raw grader output)
 * is written by the adapter into the BRIEF 7/8 schema; this carries only the pointer.
 */
export interface ExternalBenchRunOutcome {
  action: 'refused' | 'skipped' | 'ran' | 'failed';
  /** The BRIEF 8 / P-010 pre-registered config id the run-result rows wrote under. */
  runId?: string;
  benchmark?: string;
  arm?: string;
  seed?: number;
  /** Per-task rows written this pass. */
  tasksGraded?: number;
  /** Convenience tally — rows with `resolved=true`. */
  resolvedCount?: number;
  /** The effective iso-budget cap applied (USD). */
  capUsd?: number;
  /** Why a refused/skipped run did not run. */
  reason?: string;
  /** Why a failed run failed (infra error — distinct from "not resolved"). */
  error?: string;
}

/**
 * The bound adapter runner (BRIEF 3 / P-005) — runs the real clone → spin coding harness
 * → extract → grade → record loop and writes the per-task rows. Returns the run-level
 * outcome. Injectable so the op's test seam passes a fake (no PG/git/Docker/LLM).
 */
export type ExternalBenchAdapter = (input: ExternalBenchRunInput) => Promise<ExternalBenchRunOutcome>;

export interface ExternalBenchRunDeps {
  /** The adapter runner. Default = `defaultRunner` (refuses until BRIEF 3 binds it). */
  runner?: ExternalBenchAdapter;
  log?: (msg: string) => void;
}

/**
 * Default adapter — REFUSES until BRIEF 3 (P-005) binds the real runner.
 *
 * BRIEF 3: replace the body with the lazy import of the adapter, e.g.
 *   const { runExternalBenchAdapter } = await import('./adapter.js');
 *   return runExternalBenchAdapter(input);
 * (lazily, so the routines boot path never loads the grader/Docker graph — the exact
 * shape of iq-battery's `defaultRunBattery`).
 */
const defaultRunner: ExternalBenchAdapter = async (input) => ({
  action: 'refused',
  benchmark: input.benchmark,
  reason: 'external-bench adapter not yet bound (P-005 / BRIEF 3) — set payload.dryRun aside; bind runExternalBenchAdapter',
});

/**
 * Run one external-bench generation+grading pass.
 *
 * Gate (the fairness rail, like iq-battery's budget gate): a real generation costs model
 * tokens, so REFUSE without an owner-set iso-budget `budgetUsd` (the unattended-spend
 * guard). With a budget, delegate to the bound adapter; the adapter owns the per-task
 * clone/spin/grade/record + the dedupe/pre-registration skip.
 */
export async function runExternalBench(
  input: ExternalBenchRunInput,
  deps: ExternalBenchRunDeps = {},
): Promise<ExternalBenchRunOutcome> {
  const log = deps.log ?? ((m: string) => console.log(m));

  if (input.budgetUsd == null) {
    return {
      action: 'refused',
      benchmark: input.benchmark,
      arm: input.arm,
      seed: input.seed,
      reason: 'no budgetUsd — refusing (iso-budget / unattended-spend guard; set payload.budgetUsd to run)',
    };
  }

  const runner = deps.runner ?? defaultRunner;
  const outcome = await runner(input);
  log(
    `external-bench:run benchmark=${input.benchmark} arm=${input.arm ?? 'papercusp'} ` +
      `seed=${input.seed ?? 0} tasks=${input.taskIds?.length ?? 'all'} → ${outcome.action}` +
      (outcome.runId ? ` runId=${outcome.runId}` : ''),
  );
  return outcome;
}
