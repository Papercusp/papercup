/**
 * Bounded A/B evaluation harness (P-014).
 *
 * The milestone-gate executor: for each (variant × task × repeat) it runs the real
 * pipeline → collects + distills the trace → scores it with the frozen Opus judge →
 * stores the run + score in the gym PG, then derives the three P-014 deliverables:
 *   1. per-(variant,task) judge-composite VARIANCE → ε/δ/min-repeats (variance.ts, D-013);
 *   2. COST: $/run + per-variant totals (cost.ts, P-027);
 *   3. the A-vs-B COMPARISON (read-api/store compareVariants, P-013).
 *
 * Pure orchestration with injected effects (`AbDeps`): the pipeline run, the
 * collect+distill, the judge LLM call, and the gym-PG store are all injected, so the
 * sequencing + analysis are unit-tested with fakes (zero LLM, no operator, no PG). The
 * REAL execution passes real adapters (createGymRunnerPorts + the real meridian `llmCall`
 * + a real AGENT_CMD); see `ab-runner-real.ts`. Bounded by construction — the caller sizes
 * `variants × tasks × repeats` (D-019 bounded spend).
 */
import { aggregateRepeats, deriveThresholds, type DeriveOpts, type DerivedThresholds } from './variance';
import { meanRunCostUsd, type RunCost } from './cost';
import { judgeGymRun, type GymScore, type JudgeLlmCall } from './judge';
import { rubricHash, type GymJudgeRubric } from './judge-scoring';
import type { VariantOverlay } from './variant-overlay';
import type { VariantComparisonRow } from './store';
import { rateLimitInfo } from '@papercusp/testing-shell/llm';
import { runWithRatePause } from './rate-pause';

export interface AbVariant {
  variantId: string;
  label: string;
  overlay: VariantOverlay;
}

export interface AbTask {
  taskId: string;
  pool: string;
  repoUrl: string;
  repoCommit: string;
  spec: string;
  intent: string;
  /** Repo summary the judge weighs spec-gaps against. */
  projectContext: string;
}

export interface AbConfig {
  variants: AbVariant[];
  tasks: AbTask[];
  /** Repeats per (variant × task) — the variance sample (D-013). */
  repeats: number;
  rubric: GymJudgeRubric;
  harnessCommit: string;
  workspaceId: string;
  scratchRoot: string;
  deriveOpts: DeriveOpts;
  maxDistillChars: number;
}

export interface AbRunInput {
  variant: AbVariant;
  task: AbTask;
  repeat: number;
  cycle: number;
  harnessCommit: string;
  workspaceId: string;
  scratchRoot: string;
}

export interface AbRunHandle {
  harnessSlug: string;
  clonePath: string;
  workflowID: string;
  /** terminal_state (observability, D-011). */
  outcome: string;
  /** Cost of the harness pipeline run (its agent spawns). */
  pipelineUsd: number;
}

export interface AbStore {
  upsertVariant(v: AbVariant): Promise<void>;
  upsertTask(t: AbTask): Promise<void>;
  startRun(r: {
    runId: string;
    variantId: string;
    taskId: string;
    cycle: number;
    repeat: number;
    harnessSlug: string;
    workflowId: string;
  }): Promise<void>;
  finishRun(runId: string, fields: { terminalState: string; deterministicSignals: unknown; traceRef?: string }): Promise<void>;
  recordScore(runId: string, score: GymScore): Promise<void>;
  comparison(variantA: string, variantB: string, rubricHash: string): Promise<VariantComparisonRow[]>;
}

export interface AbDeps {
  store: AbStore;
  runPipeline(input: AbRunInput): Promise<AbRunHandle>;
  collectAndDistill(input: {
    handle: AbRunHandle;
    task: AbTask;
    maxChars: number;
  }): Promise<{ distilledTrace: string; traceRef: string; rawSignals: unknown }>;
  llmCall: JudgeLlmCall;
  newRunId(variantId: string, taskId: string, repeat: number): string;
  now(): number;
  /** RB-006: injected for the rate-limit pause+resume wait (defaults to real setTimeout). */
  sleep?(ms: number): Promise<void>;
}

export interface AbRunOutcome {
  variantId: string;
  taskId: string;
  repeat: number;
  runId: string;
  harnessSlug: string;
  outcome: string;
  d1: number;
  d2: number;
  d3: number;
  composite: number;
  pipelineUsd: number;
  judgeUsd: number;
  /**
   * RB-006: disposition of this run's EVALUATION. `'scored'` (default/absent) = judged
   * normally; `'rate_limited'` = the judge turn stayed rate-limited past our bounded pause, so
   * the run is recorded (not scored) and the A/B continues instead of aborting; `'errored'` =
   * any other failure in the run/judge. Non-`'scored'` outcomes are EXCLUDED from variance.
   */
  status?: 'scored' | 'rate_limited' | 'errored';
  /** The failure message for a non-`'scored'` outcome (observability). */
  error?: string;
}

export interface PerTaskVariance extends DerivedThresholds {
  variantId: string;
  taskId: string;
  mean: number;
  sd: number;
  n: number;
}

export interface AbResult {
  outcomes: AbRunOutcome[];
  /** Per-(variant,task) judge-composite variance + the derived ε/δ/min-repeats (D-013). */
  perTaskVariance: PerTaskVariance[];
  cost: { totalUsd: number; meanRunUsd: number; perVariant: Record<string, number> };
  /** A-vs-B per-task composite + signed delta (variant[0] = A/baseline, variant[1] = B). */
  comparison: VariantComparisonRow[];
  rubricHash: string;
}

export async function runAbEvaluation(config: AbConfig, deps: AbDeps): Promise<AbResult> {
  const rh = rubricHash(config.rubric);
  const outcomes: AbRunOutcome[] = [];
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (const v of config.variants) await deps.store.upsertVariant(v);
  for (const t of config.tasks) await deps.store.upsertTask(t);

  // One row per (variant × task × repeat). Sequential by design: bounded spend + the
  // shared LLM session has a rate limit, so we don't fan out concurrently here. Each run is
  // wrapped so a single failed turn (a rate-limited judge, a pipeline error) is RECORDED and
  // the A/B continues — never aborting every remaining run (RB-006). A rate-limited judge is
  // first PAUSED+RESUMED (judgeWithPause); only a far-off reset falls through to a recorded
  // 'rate_limited' outcome.
  for (const variant of config.variants) {
    for (const task of config.tasks) {
      for (let repeat = 0; repeat < config.repeats; repeat++) {
        const runId = deps.newRunId(variant.variantId, task.taskId, repeat);
        let handle: AbRunHandle | undefined;
        try {
          handle = await deps.runPipeline({
            variant,
            task,
            repeat,
            cycle: 0,
            harnessCommit: config.harnessCommit,
            workspaceId: config.workspaceId,
            scratchRoot: config.scratchRoot,
          });
          await deps.store.startRun({
            runId,
            variantId: variant.variantId,
            taskId: task.taskId,
            cycle: 0,
            repeat,
            harnessSlug: handle.harnessSlug,
            workflowId: handle.workflowID,
          });
          const { distilledTrace, traceRef, rawSignals } = await deps.collectAndDistill({
            handle,
            task,
            maxChars: config.maxDistillChars,
          });
          await deps.store.finishRun(runId, { terminalState: handle.outcome, deterministicSignals: rawSignals, traceRef });
          const score = await runWithRatePause(
            () =>
              judgeGymRun(
                { intent: task.intent, projectContext: task.projectContext, distilledTrace, rubric: config.rubric },
                { llmCall: deps.llmCall },
              ),
            { now: deps.now, sleep },
          );
          await deps.store.recordScore(runId, score);
          outcomes.push({
            variantId: variant.variantId,
            taskId: task.taskId,
            repeat,
            runId,
            harnessSlug: handle.harnessSlug,
            outcome: handle.outcome,
            d1: score.d1,
            d2: score.d2,
            d3: score.d3,
            composite: score.composite,
            pipelineUsd: handle.pipelineUsd,
            judgeUsd: score.costUsd,
            status: 'scored',
          });
        } catch (err) {
          // Never abort the A/B on one run. A rate-limited turn (past the bounded pause) →
          // 'rate_limited'; anything else → 'errored'. Recorded + EXCLUDED from variance.
          // The structured outcome below IS the record (status + error); RB-009 surfaces
          // rate-limit events to telemetry/coord. No raw console logging in this hot path.
          const status: 'rate_limited' | 'errored' = rateLimitInfo(err) ? 'rate_limited' : 'errored';
          const message = err instanceof Error ? err.message : String(err);
          outcomes.push({
            variantId: variant.variantId,
            taskId: task.taskId,
            repeat,
            runId,
            harnessSlug: handle?.harnessSlug ?? '',
            outcome: handle?.outcome ?? status,
            d1: 0,
            d2: 0,
            d3: 0,
            composite: 0,
            pipelineUsd: handle?.pipelineUsd ?? 0,
            judgeUsd: 0,
            status,
            error: message,
          });
        }
      }
    }
  }

  // 1. Per-(variant,task) variance → ε/δ/min-repeats. Non-scored runs (rate_limited/errored)
  //    carry no real composite, so they are EXCLUDED from the variance sample (RB-006).
  const perTaskVariance: PerTaskVariance[] = [];
  for (const variant of config.variants) {
    for (const task of config.tasks) {
      const composites = outcomes
        .filter((o) => o.variantId === variant.variantId && o.taskId === task.taskId && (o.status ?? 'scored') === 'scored')
        .map((o) => o.composite);
      if (composites.length === 0) continue;
      const stats = aggregateRepeats(composites);
      const thr = deriveThresholds(stats.sd, config.deriveOpts);
      perTaskVariance.push({ variantId: variant.variantId, taskId: task.taskId, mean: stats.mean, sd: stats.sd, n: stats.n, ...thr });
    }
  }

  // 2. Cost.
  const runCosts: RunCost[] = outcomes.map((o) => ({ pipelineUsd: o.pipelineUsd, judgeUsd: o.judgeUsd }));
  const totalUsd = runCosts.reduce((s, c) => s + c.pipelineUsd + c.judgeUsd, 0);
  const perVariant: Record<string, number> = {};
  for (const o of outcomes) perVariant[o.variantId] = (perVariant[o.variantId] ?? 0) + o.pipelineUsd + o.judgeUsd;

  // 3. A-vs-B comparison (variant[0] = A/baseline, variant[1] = B/candidate when present).
  const a = config.variants[0]?.variantId;
  const b = config.variants[1]?.variantId ?? a;
  const comparison = a ? await deps.store.comparison(a, b, rh) : [];

  return {
    outcomes,
    perTaskVariance,
    cost: { totalUsd, meanRunUsd: meanRunCostUsd(runCosts), perVariant },
    comparison,
    rubricHash: rh,
  };
}
