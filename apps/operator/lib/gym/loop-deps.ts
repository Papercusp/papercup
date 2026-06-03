/**
 * Real `LoopDeps` builder for the autonomous optimization loop (P-022 / D-020 runner service).
 *
 * `runOptimizationLoop` (loop.ts) is pure orchestration over injected effects; this binds those
 * effects to the SAME smoke-proven per-run engine the A/B uses (`buildAbDeps`), then layers the
 * loop-specific aggregation on top:
 *   evaluate(variantId, overlay) → run the variant over the task pools (train + dev-anchor + probe),
 *     collect + distill + judge each run, and roll the per-run composites up into a `VariantEval`
 *     (trainAgg/trainVector drive the frontier; devAnchorAgg gates; regressions/probe are the
 *     un-gameable signals) + the worst train traces (the proposer's reflection signal).
 *   propose(...) → the real reflective proposer (proposer.ts), prompts-only (D-015).
 *   promote/revert → optional gym-harness override writes (no-op in the human-gated product, D-020).
 *   persistCycle → gym_cycles (store.ts).
 *   recordProposal → the live control-plane recorder (makeLoopProposalRecorder), so each scored
 *     candidate surfaces in the gym UI's diff-review for human accept/reject.
 *
 * Everything is injected, so the aggregation + sequencing are unit-tested with fakes (zero LLM,
 * no operator, no real PG); `gym-loop-run.ts` passes the real adapters.
 */
import type { Sql } from 'postgres';
import { buildAbDeps } from './ab-runner-real';
import { judgeGymRun, type JudgeLlmCall } from './judge';
import { proposeCandidate, type WorstTrace } from './proposer';
import { insertCycle } from './store';
import { runWithRatePause } from './rate-pause';
import { GYM_JUDGE_RUBRIC_V1, type GymJudgeRubric } from './judge-scoring';
import type { GymRunnerPorts } from './gym-runner';
import type { LoopDeps, EvaluateResult, LoopProposalRecord } from './loop';
import type { VariantOverlay } from './variant-overlay';
import type { VariantEval } from './gate-engine';
import type { GymLlmCall, GymTaskPool } from './task-generator';
import type { AbTask, AbDeps } from './ab-runner';

/** A task the loop evaluates, tagged with the pool that decides how its composite is rolled up. */
export interface LoopTask extends Omit<AbTask, 'pool'> {
  pool: GymTaskPool;
}

export interface BuildLoopDepsConfig {
  /** A postgres-js client connected to the gym PG (execution data: runs/scores/variants/cycles). */
  gymSql: Sql;
  /** Real runner ports (clone/register/overlay/file/start/poll) — createGymRunnerPorts(...). */
  ports: GymRunnerPorts;
  /** The frozen Opus judge llm call (real meridian/claude-code call, or a fake in tests). */
  judgeCall: JudgeLlmCall;
  /** The proposer llm call (decorrelated from the judge model per D-015). */
  proposerCall: GymLlmCall;
  /** Proposer model id (should differ from the judge's). */
  proposerModel: string;
  /** The task pools the loop evaluates each variant over (train + dev-anchor [+ probe]). */
  tasks: LoopTask[];
  /** The frozen judge rubric (defaults to GYM_JUDGE_RUBRIC_V1). */
  rubric?: GymJudgeRubric;
  baseline: { variantId: string; overlay: VariantOverlay };
  harnessCommit: string;
  workspaceId: string;
  scratchRoot: string;
  timeoutMs: number;
  pollIntervalMs: number;
  maxDistillChars: number;
  /** How many worst train traces to feed the proposer (default 3). */
  worstK?: number;
  /** Override the per-run engine (defaults to buildAbDeps); injected in unit tests. */
  abDeps?: AbDeps;
  /** Promote a champion's overrides into the gym harness (P-020). Omit ⇒ human-gated (D-020). */
  promote?: (overlay: VariantOverlay) => Promise<void>;
  /** Auto-revert the harness overrides (circuit-breaker). Omit ⇒ no external write to undo. */
  revert?: () => Promise<void>;
  /** Live control-plane recorder (makeLoopProposalRecorder) — surfaces candidates for review. */
  recordProposal?: (rec: LoopProposalRecord) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function buildLoopDeps(cfg: BuildLoopDepsConfig): LoopDeps {
  const rubric = cfg.rubric ?? GYM_JUDGE_RUBRIC_V1;
  const now = cfg.now ?? (() => Date.now());
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const worstK = cfg.worstK ?? 3;

  // Reuse the smoke-proven per-run engine (runPipeline + collectAndDistill + gym-PG store).
  const ab =
    cfg.abDeps ??
    buildAbDeps({
      gymSql: cfg.gymSql,
      ports: cfg.ports,
      llmCall: cfg.judgeCall,
      timeoutMs: cfg.timeoutMs,
      pollIntervalMs: cfg.pollIntervalMs,
      scratchRoot: cfg.scratchRoot,
    });

  // Cycle metadata for gym_runs (the baseline is evaluated first → cycle 0).
  let evalSeq = 0;

  async function evaluate(variantId: string, overlay: VariantOverlay): Promise<EvaluateResult> {
    const cycle = evalSeq++;
    const variant = { variantId, label: variantId, overlay };
    await ab.store.upsertVariant(variant);

    interface PerRun {
      taskId: string;
      pool: GymTaskPool;
      composite: number;
      rationale: string;
      distilled: string;
      cost: number;
      regression: boolean;
      probeCaught: boolean | null;
    }
    const perRun: PerRun[] = [];

    for (const task of cfg.tasks) {
      await ab.store.upsertTask({ ...task, pool: task.pool });
      const runId = `${variantId}::${task.taskId}::c${cycle}`;
      const handle = await ab.runPipeline({
        variant,
        task: { ...task, pool: task.pool },
        repeat: 0,
        cycle,
        harnessCommit: cfg.harnessCommit,
        workspaceId: cfg.workspaceId,
        scratchRoot: cfg.scratchRoot,
      });
      await ab.store.startRun({
        runId,
        variantId,
        taskId: task.taskId,
        cycle,
        repeat: 0,
        harnessSlug: handle.harnessSlug,
        workflowId: handle.workflowID,
      });
      const { distilledTrace, traceRef, rawSignals } = await ab.collectAndDistill({
        handle,
        task: { ...task, pool: task.pool },
        maxChars: cfg.maxDistillChars,
      });
      await ab.store.finishRun(runId, { terminalState: handle.outcome, deterministicSignals: rawSignals, traceRef });
      const score = await runWithRatePause(
        () =>
          judgeGymRun(
            { intent: task.intent, projectContext: task.projectContext, distilledTrace, rubric },
            { llmCall: cfg.judgeCall },
          ),
        { now, sleep },
      );
      await ab.store.recordScore(runId, score);
      const sig = (rawSignals ?? {}) as Record<string, unknown>;
      perRun.push({
        taskId: task.taskId,
        pool: task.pool,
        composite: score.composite,
        rationale: score.rationale,
        distilled: distilledTrace,
        cost: handle.pipelineUsd + score.costUsd,
        regression: Boolean(sig.regressions),
        probeCaught: task.pool === 'probe' ? Boolean(sig.planted_bug_caught) : null,
      });
    }

    const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const train = perRun.filter((r) => r.pool === 'train');
    const devAnchor = perRun.filter((r) => r.pool === 'dev-anchor');
    const probes = perRun.filter((r) => r.pool === 'probe');
    const trainVector = train.map((r) => r.composite);

    const evalResult: VariantEval = {
      variantId,
      trainAgg: mean(trainVector),
      trainVector,
      devAnchorAgg: mean(devAnchor.map((r) => r.composite)),
      meanCost: mean(perRun.map((r) => r.cost)),
      anyNewRegression: perRun.some((r) => r.regression),
      // No probe tasks ⇒ the gate is vacuously satisfied (probe is a guardrail, not a target).
      allProbesCaught: probes.length === 0 ? true : probes.every((r) => r.probeCaught === true),
    };

    // The proposer reflects on the WORST train traces (lowest composite first).
    const worstTraces: WorstTrace[] = [...train]
      .sort((a, b) => a.composite - b.composite)
      .slice(0, worstK)
      .map((r) => ({ taskId: r.taskId, composite: r.composite, rationale: r.rationale, distilledTrace: r.distilled }));

    return { evalResult, worstTraces, costUsd: perRun.reduce((s, r) => s + r.cost, 0) };
  }

  return {
    baseline: cfg.baseline,
    evaluate,
    async propose(parentOverlay, worstTraces, changelog) {
      return proposeCandidate(
        { parentOverlay, worstTraces, changelog, proposerModel: cfg.proposerModel },
        { llmCall: cfg.proposerCall },
      );
    },
    async promote(overlay) {
      if (cfg.promote) await cfg.promote(overlay);
    },
    async revert() {
      if (cfg.revert) await cfg.revert();
    },
    async persistCycle(rec) {
      await insertCycle(cfg.gymSql, {
        cycleId: `cyc-${rec.cycle}`,
        cycle: rec.cycle,
        parentId: rec.parentId,
        candidateId: rec.candidateId,
        decision: rec.decision,
        gateResults: rec.gateResults,
      });
    },
    recordProposal: cfg.recordProposal,
    newVariantId: (cycle) => `cand-c${cycle}`,
    now,
    sleep,
  };
}
