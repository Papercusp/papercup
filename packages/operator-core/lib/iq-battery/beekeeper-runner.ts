/**
 * Beekeeper runner v1 (P-003): orchestrate ONE battery execution against ONE papercusp instance.
 *
 * Adapts the gym's ab-runner pattern for instance-level evaluation:
 * - Boot is swapped: GymOperatorBootSpec → InstanceManifest
 * - Store: variants/tasks/runs/scores adapted to beekeeper schema (harness_shared)
 * - Judge + circuit-breaker reused from gym
 * - One instance, battery corpus (P-001), collected metrics (P-002)
 *
 * Runs sequentially (bounded by construction — the caller sizes corpus × repeats).
 * All effects injected for testability (EI-58: testability-seam pattern).
 *
 * Testability seams (EI-58):
 * - BeekeeperDeps interface: all external effects injected (store, instance runner,
 *   metric collection, LLM judge) so unit tests can stub them with mocks/vitest.
 * - RunBeekeeperBattery is pure orchestration: zero implicit dependencies.
 * - Unit tests mock all deps; integration tests stub them for e2e validation.
 */

import { judgeGymRun, type GymScore, type JudgeLlmCall } from '../gym/judge';
import { rubricHash, type GymJudgeRubric } from '../gym/judge-scoring';
import type { CorpusCase } from './corpus';
import type { IQBatteryMetrics, MetricCollectorInput } from './collectors';
import type { InstanceBootSpec, InstanceRunHandle } from './instance-manifest';
import { runWithRatePause, type RatePauseDeps } from '../gym/rate-pause';

export interface BeekeeperConfig {
  instanceSpec: InstanceBootSpec;
  corpus: CorpusCase[];
  /** Repeats per case — for noise calibration (D-012). */
  repeats: number;
  rubric: GymJudgeRubric;
  maxDistillChars: number;
}

export interface BeekeeperRunInput {
  case: CorpusCase;
  repeat: number;
  instanceSpec: InstanceBootSpec;
}

export interface BeekeeperStore {
  upsertInstance(m: InstanceBootSpec['manifest']): Promise<void>;
  upsertCorpusCase(c: CorpusCase): Promise<void>;
  startRun(r: {
    runId: string;
    instanceId: string;
    caseId: string;
    caseVariant: string;
    caseTitle: string;
  }): Promise<void>;
  finishRun(
    runId: string,
    fields: { terminalState: string; deterministicSignals: unknown; traceRef?: string; elapsedMs: number }
  ): Promise<void>;
  recordScore(runId: string, score: GymScore, metrics: IQBatteryMetrics): Promise<void>;
}

export interface BeekeeperDeps {
  store: BeekeeperStore;
  runInstance(input: BeekeeperRunInput): Promise<InstanceRunHandle>;
  collectAndDistill(input: {
    handle: InstanceRunHandle;
    case: CorpusCase;
    maxChars: number;
  }): Promise<{
    distilledTrace: string;
    traceRef: string;
    rawSignals: unknown;
    /**
     * The run's REAL metric signals (status / tokens / times / escalation /
     * retrieved-vs-expected sources), threaded into `collectMetrics` so the
     * seven collectors measure the actual run — not the stubbed defaults the
     * orchestrator used to pass (apiary-generation-0-battery D-004). Optional:
     * a dep that omits it keeps the prior {runId,caseId,variant}-only behavior.
     */
    signals?: Partial<MetricCollectorInput>;
  }>;
  collectMetrics(input: MetricCollectorInput): Promise<IQBatteryMetrics>;
  llmCall: JudgeLlmCall;
  newRunId(caseId: string, repeat: number): string;
  now(): number;
  sleep?(ms: number): Promise<void>;
  ratePauseHooks?: Pick<RatePauseDeps, 'onPause' | 'onReset'>;
}

export interface BeekeeperRunOutcome {
  caseId: string;
  caseVariant: string;
  repeat: number;
  runId: string;
  instanceId: string;
  outcome: string;
  d1: number;
  d2: number;
  d3: number;
  composite: number;
  costUsd: number;
  judgeUsd: number;
  status?: 'scored' | 'rate_limited' | 'errored';
  error?: string;
}

export interface BeekeeperResult {
  instanceId: string;
  outcomes: BeekeeperRunOutcome[];
  totalCases: number;
  passedCases: number;
  meanComposite: number;
  rubricHash: string;
}

export async function runBeekeeperBattery(config: BeekeeperConfig, deps: BeekeeperDeps): Promise<BeekeeperResult> {
  const rh = rubricHash(config.rubric);
  const outcomes: BeekeeperRunOutcome[] = [];
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // Register the instance and corpus cases.
  await deps.store.upsertInstance(config.instanceSpec.manifest);
  for (const c of config.corpus) await deps.store.upsertCorpusCase(c);

  const instanceId = config.instanceSpec.manifest.instanceId;

  // One row per (case × repeat). Sequential by design: bounded spend + rate limit on judge.
  // Each run wrapped so a single failure (rate-limited judge, instance error) is recorded
  // and the battery continues — never aborting remaining runs.
  for (const caseItem of config.corpus) {
    for (let repeat = 0; repeat < config.repeats; repeat++) {
      const runId = deps.newRunId(caseItem.id, repeat);
      let handle: InstanceRunHandle | undefined;
      try {
        handle = await deps.runInstance({
          case: caseItem,
          repeat,
          instanceSpec: config.instanceSpec,
        });

        const startTime = Date.now();
        await deps.store.startRun({
          runId,
          instanceId,
          caseId: caseItem.id,
          caseVariant: caseItem.variant,
          caseTitle: caseItem.title,
        });

        const { distilledTrace, traceRef, rawSignals, signals } = await deps.collectAndDistill({
          handle,
          case: caseItem,
          maxChars: config.maxDistillChars,
        });

        const elapsedMs = Date.now() - startTime;
        await deps.store.finishRun(runId, {
          terminalState: 'completed',
          deterministicSignals: rawSignals,
          traceRef,
          elapsedMs,
        });

        // Collect metrics from the run's REAL signals (apiary-generation-0-battery
        // D-004): collectAndDistill extracts status/tokens/times/escalation/sources
        // from the actual instance run and returns them as `signals`; thread them
        // into the seven collectors. A dep that omits `signals` (e.g. a test stub)
        // falls back to the {runId,caseId,variant}-only call as before.
        const metrics = await deps.collectMetrics({
          ...(signals ?? {}),
          runId,
          caseId: caseItem.id,
          variant: caseItem.variant,
        });

        // Judge the run.
        const score = await runWithRatePause(
          () =>
            judgeGymRun(
              {
                intent: caseItem.prompt,
                projectContext: '',
                distilledTrace,
                rubric: config.rubric,
              },
              { llmCall: deps.llmCall }
            ),
          { now: deps.now, sleep, ...(deps.ratePauseHooks ?? {}) }
        );

        await deps.store.recordScore(runId, score, metrics);

        outcomes.push({
          caseId: caseItem.id,
          caseVariant: caseItem.variant,
          repeat,
          runId,
          instanceId,
          outcome: 'completed',
          d1: score.d1,
          d2: score.d2,
          d3: score.d3,
          composite: score.composite,
          costUsd: handle.costUsd,
          judgeUsd: score.costUsd,
          status: 'scored',
        });
      } catch (err) {
        const status: 'rate_limited' | 'errored' = isRateLimitError(err) ? 'rate_limited' : 'errored';
        const message = err instanceof Error ? err.message : String(err);
        outcomes.push({
          caseId: caseItem.id,
          caseVariant: caseItem.variant,
          repeat,
          runId,
          instanceId,
          outcome: handle?.targetSlug ?? '',
          d1: 0,
          d2: 0,
          d3: 0,
          composite: 0,
          costUsd: handle?.costUsd ?? 0,
          judgeUsd: 0,
          status,
          error: message,
        });
      }
    }
  }

  const passedCases = outcomes.filter((o) => o.status === 'scored').length;
  const meanComposite =
    outcomes.length > 0
      ? outcomes.reduce((sum, o) => sum + o.composite, 0) / outcomes.filter((o) => o.status === 'scored').length
      : 0;

  return {
    instanceId,
    outcomes,
    totalCases: config.corpus.length * config.repeats,
    passedCases,
    meanComposite,
    rubricHash: rh,
  };
}

function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('rate_limit') || err.message.includes('rate-limit');
}
