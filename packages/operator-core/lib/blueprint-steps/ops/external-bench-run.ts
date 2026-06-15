/**
 * `external-bench:run` — the impartial third-party benchmark runner as a deterministic
 * blueprint step (impartial-benchmark-suite-2026-06-15 P-019 / BRIEF 2). The SIBLING of
 * `iq-battery:gen` / `hive-eval:gen`, inverted to PUBLIC tasks + the EXTERNAL grader
 * (D-005): we neither author the tasks nor grade the results.
 *
 * Per pass: for each benchmark task → clone the repo @ base_commit → spin a THROWAWAY
 * `coding` harness (one `feature` work_item = the issue) → run to DONE under the
 * iso-budget cap → extract the diff (M1) / finished sandbox (M2) → hand to the
 * benchmark's OFFICIAL grader → write a per-task run-result row. This op WRAPS the shared
 * `runExternalBench` orchestration; the per-task clone/spin/grade/record loop is the
 * adapter (BRIEF 3 / P-005), bound inside `runExternalBench` and INTERNAL to the op (like
 * iq-battery's bee spawn — NOT a `spawn-roles` step: a benchmark task is a coding
 * work_item brief, not a harness role/persona).
 *
 * NOT a flag/governor loop — the gate is the owner-set `budgetUsd` (the iso-budget /
 * unattended-spend guard, the gym's precedent), so the result is the run-level outcome
 * (refused / skipped / ran / failed), not a flag/governor skip. The adapter is the
 * genuinely new component (BRIEF 3); the op's default REFUSES until it is bound.
 */
import { z } from 'zod';
import type { CoordOp } from '../../coord-ops/types.js';
import { registerCoordOp } from '../../coord-ops/registry.js';
import { runExternalBench, type ExternalBenchRunDeps } from '../../external-bench/run-loop.js';

/** Declared input I/O — the run config (the firing `system:blueprint-run` payload).
 *  `budgetUsd` is REQUIRED to run (absent ⇒ a `refused` outcome — never a defaulted spend). */
const args = z.object({
  /** The benchmark family — the run-result + grader backend is keyed on it. REQUIRED. */
  benchmark: z.string().min(1),
  /** Instance ids to run; omitted ⇒ the configured split. ONE id = the smoke path. */
  taskIds: z.array(z.string()).optional(),
  /** The coding-harness arm: 'papercusp' (full spine) | 'ablation-a' (single worker, P-006).
   *  Default 'papercusp'. Baselines B/C are separate runners, not this op. */
  arm: z.string().optional(),
  /** The seed / submission `prefix` for the ≥3-seed pass@1 protocol. Default 0. */
  seed: z.number().int().nonnegative().optional(),
  /** The iso-budget cap (USD). Absent ⇒ the run is REFUSED (unattended-spend guard). */
  budgetUsd: z.number().positive().optional(),
  /** Plumbing-only mode: generate + record, skip the paid grader / coding spend. */
  dryRun: z.boolean().optional(),
});

/** Declared output I/O — the RUN-LEVEL outcome (discriminated `action` + its fields).
 *  NOT the per-task run-result row (that is the BRIEF 7/8 schema, written by the adapter). */
const result = z.object({
  action: z.enum(['refused', 'skipped', 'ran', 'failed']),
  runId: z.string().optional(),
  benchmark: z.string().optional(),
  arm: z.string().optional(),
  seed: z.number().optional(),
  tasksGraded: z.number().optional(),
  resolvedCount: z.number().optional(),
  capUsd: z.number().optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
});

/** Test seam — inject a fake adapter `runner` / `log` (no PG/git/Docker/LLM). */
let _deps: ExternalBenchRunDeps | null = null;
export function setExternalBenchRunDeps(deps: ExternalBenchRunDeps | null): void {
  _deps = deps;
}

export const externalBenchRunOp: CoordOp<z.infer<typeof args>, z.infer<typeof result>> = {
  name: 'external-bench:run',
  description:
    'Deterministic step: run ONE owner-budget-capped external-bench generation+grading pass — public benchmark tasks each run as a throwaway `coding` work_item, graded by the benchmark\'s OWN external harness (the impartial third-party runner; we neither author nor grade).',
  argsSchema: args,
  resultSchema: result,
  async run(a, ctx) {
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) throw new Error('external-bench:run requires ctx.workspaceId');
    const installSlug = ctx.harnessSlug ?? 'op';

    const outcome = await runExternalBench(
      {
        workspaceId,
        installSlug,
        benchmark: a.benchmark,
        taskIds: a.taskIds,
        arm: a.arm,
        seed: a.seed,
        budgetUsd: a.budgetUsd,
        dryRun: a.dryRun,
      },
      _deps ?? { log: (m) => ctx.log?.(m) },
    );
    ctx.log?.(
      `external-bench:run action=${outcome.action} benchmark=${a.benchmark}` +
        (outcome.runId ? ` runId=${outcome.runId}` : '') +
        (outcome.action === 'ran' ? ` graded=${outcome.tasksGraded ?? 0} resolved=${outcome.resolvedCount ?? 0}` : ''),
    );
    return outcome;
  },
};

registerCoordOp(externalBenchRunOp);
