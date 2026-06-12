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
import { ratePauseEventHooks } from './rate-pause-events';
import { GYM_JUDGE_RUBRIC_V1, type GymJudgeRubric } from './judge-scoring';
import type { GymRunnerPorts } from './gym-runner';
import type { LoopDeps, EvaluateResult, LoopProposalRecord } from './loop';
import type { ArchiveCandidateRecord } from './qd/niche';
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
  /**
   * P-032: triage-routed gym ideas (pre-formatted lines) handed to the proposer as
   * optional candidate directions every cycle. Empty/absent ⇒ unchanged proposer prompt.
   */
  candidateDirections?: string[];
  /**
   * P-030 (consume-edges B-09): recent champions' measured post-acceptance outcome
   * lines (gatherChampionOutcomeEntries) — primes the proposer with what its past
   * accepted changes did to LIVE runs. Empty/absent ⇒ unchanged proposer prompt.
   */
  championOutcomes?: string[];
  /**
   * P-025: repeats per (variant × task) — the per-task composite is the MEAN over repeats,
   * to average out the judge's per-run noise. Default 1; P-014 measured sd≤0.5 → minRepeats≈4,
   * so the loop driver should set this ≥4 for accept decisions to be trustworthy.
   */
  repeats?: number;
  /** Override the per-run engine (defaults to buildAbDeps); injected in unit tests. */
  abDeps?: AbDeps;
  /** Promote a champion's overrides into the gym harness (P-020). Omit ⇒ human-gated (D-020). */
  promote?: (overlay: VariantOverlay) => Promise<void>;
  /** Auto-revert the harness overrides (circuit-breaker). Omit ⇒ no external write to undo. */
  revert?: () => Promise<void>;
  /** Live control-plane recorder (makeLoopProposalRecorder) — surfaces candidates for review. */
  recordProposal?: (rec: LoopProposalRecord) => Promise<void>;
  /** Live QD-archive recorder (makeLoopArchiveRecorder) — feeds each variant to the MAP-Elites archive (P-010). */
  recordArchive?: (rec: ArchiveCandidateRecord) => Promise<void>;
  /**
   * Live QD novelty signal (P-011): a frontier member's distance-from-archive. Pair with
   * `config.qualityDiversity` to bias parent selection toward sparse niches (novelty search).
   * Build both this and `recordArchive` from one `makeLoopQdSeams(...)` so they share an archive.
   */
  noveltyForVariant?: (variantId: string) => Promise<number>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function buildLoopDeps(cfg: BuildLoopDepsConfig): LoopDeps {
  const rubric = cfg.rubric ?? GYM_JUDGE_RUBRIC_V1;
  const now = cfg.now ?? (() => Date.now());
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const worstK = cfg.worstK ?? 3;
  const repeats = Math.max(1, cfg.repeats ?? 1);

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

    const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

    /** One per (task), aggregated over `repeats` runs (P-025: average out judge noise). */
    interface PerTask {
      taskId: string;
      pool: GymTaskPool;
      composite: number; // mean over repeats
      rationale: string; // the worst repeat's rationale (most informative for the proposer)
      distilled: string; // the worst repeat's distilled trace
      cost: number; // SUM over repeats
      regression: boolean; // any repeat regressed
      probeCaught: boolean | null; // all repeats caught (probe pool only)
    }
    const perTask: PerTask[] = [];

    for (const task of cfg.tasks) {
      await ab.store.upsertTask({ ...task, pool: task.pool });
      const composites: number[] = [];
      let cost = 0;
      let regression = false;
      let probeCaughtAll = task.pool === 'probe' ? true : null;
      let worst: { composite: number; rationale: string; distilled: string } | null = null;

      for (let repeat = 0; repeat < repeats; repeat++) {
        const runId = `${variantId}::${task.taskId}::c${cycle}::r${repeat}`;
        const handle = await ab.runPipeline({
          variant,
          task: { ...task, pool: task.pool },
          repeat,
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
          repeat,
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
          // P-010 (await-event): pauses emit rate-limit:paused/reset:gym-judge —
          // awaitable + on the wake meter instead of an invisible in-process sleep.
          { now, sleep, ...ratePauseEventHooks('gym-judge') },
        );
        await ab.store.recordScore(runId, score);
        const sig = (rawSignals ?? {}) as Record<string, unknown>;
        composites.push(score.composite);
        cost += handle.pipelineUsd + score.costUsd;
        if (sig.regressions) regression = true;
        if (task.pool === 'probe' && !sig.planted_bug_caught) probeCaughtAll = false;
        if (!worst || score.composite < worst.composite) {
          worst = { composite: score.composite, rationale: score.rationale, distilled: distilledTrace };
        }
      }

      perTask.push({
        taskId: task.taskId,
        pool: task.pool,
        composite: mean(composites), // P-025: per-task reward = mean over repeats
        rationale: worst?.rationale ?? '',
        distilled: worst?.distilled ?? '',
        cost,
        regression,
        probeCaught: probeCaughtAll,
      });
    }

    const train = perTask.filter((r) => r.pool === 'train');
    const devAnchor = perTask.filter((r) => r.pool === 'dev-anchor');
    const probes = perTask.filter((r) => r.pool === 'probe');
    const trainVector = train.map((r) => r.composite);

    const totalCost = perTask.reduce((s, r) => s + r.cost, 0);
    const totalRuns = perTask.length * repeats;
    const evalResult: VariantEval = {
      variantId,
      trainAgg: mean(trainVector),
      trainVector,
      devAnchorAgg: mean(devAnchor.map((r) => r.composite)),
      // Mean cost PER RUN across every (task × repeat).
      meanCost: totalRuns ? totalCost / totalRuns : 0,
      anyNewRegression: perTask.some((r) => r.regression),
      // No probe tasks ⇒ the gate is vacuously satisfied (probe is a guardrail, not a target).
      allProbesCaught: probes.length === 0 ? true : probes.every((r) => r.probeCaught === true),
    };

    // The proposer reflects on the WORST train traces (lowest per-task mean composite first).
    const worstTraces: WorstTrace[] = [...train]
      .sort((a, b) => a.composite - b.composite)
      .slice(0, worstK)
      .map((r) => ({ taskId: r.taskId, composite: r.composite, rationale: r.rationale, distilledTrace: r.distilled }));

    return { evalResult, worstTraces, costUsd: totalCost };
  }

  return {
    baseline: cfg.baseline,
    evaluate,
    async propose(parentOverlay, worstTraces, changelog) {
      return proposeCandidate(
        {
          parentOverlay,
          worstTraces,
          changelog,
          proposerModel: cfg.proposerModel,
          // P-032: routed-idea candidate directions ride every propose call (additive).
          ...(cfg.candidateDirections?.length ? { candidateDirections: cfg.candidateDirections } : {}),
          // P-030: measured champion outcomes ride every propose call (additive).
          ...(cfg.championOutcomes?.length ? { championOutcomes: cfg.championOutcomes } : {}),
        },
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
    recordArchive: cfg.recordArchive,
    noveltyForVariant: cfg.noveltyForVariant,
    newVariantId: (cycle) => `cand-c${cycle}`,
    now,
    sleep,
  };
}
