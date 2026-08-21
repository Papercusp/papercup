/** Bounded, injected orchestration for one REM dream cycle (P-005). */
import type { ScoutLlmCall } from '../scout/types';
import type { CorpusEntry } from '../scout/critique-core';
import {
  resolveDreamCycleConfig,
  resolveDreamPassConfig,
  type DreamCycleConfig,
  type DreamPassConfig,
  type DreamReviewConfig,
  type DreamSamplerConfig,
} from './dream-config';
import { runDreamPass, type DreamPassUsage } from './dream-pass';
import { runDreamReview, type DreamReviewUsage } from './dream-review';
import {
  sampleDreamPair,
  type DreamFragment,
  type DreamFragmentPair,
  type SampleDreamPairOptions,
} from './fragment-sampler';
import { sinkDreamInsight, type SinkDreamInsightResult } from './dream-sink';
import type { DreamGovernorPreflight, RecordDreamSpendResult } from './dream-governor';
import type { DreamRun, DreamRunMode, DreamRunTerminalStatus, FinalizeDreamRunInput } from './dream-run-store';
import type { DreamSourceSnapshot } from './dream-sources';

export interface DreamCycleInput {
  workspaceId: string;
  potSlug: string;
  mode: DreamRunMode;
  cycleId: string;
  cycle?: Partial<DreamCycleConfig>;
  sampler?: Partial<DreamSamplerConfig>;
  pass?: Partial<DreamPassConfig>;
  review?: Partial<DreamReviewConfig>;
  signal?: AbortSignal;
}

type FinalizeInput = Omit<FinalizeDreamRunInput, 'workspaceId'>;

export interface DreamCycleDeps {
  llmCall: ScoutLlmCall;
  preflight: () => Promise<DreamGovernorPreflight>;
  loadSources: () => Promise<DreamSourceSnapshot>;
  readCorpus: (fragments: readonly DreamFragment[]) => Promise<CorpusEntry[]>;
  beginRun: (input: { runId: string; cycleId: string }) => Promise<{ created: boolean; run: DreamRun }>;
  recordSelection: (input: { runId: string; pair: DreamFragmentPair; dreamerModel: string }) => Promise<DreamRun>;
  finalizeRun: (input: FinalizeInput) => Promise<DreamRun>;
  recordSpend: (run: DreamRun) => Promise<RecordDreamSpendResult>;
  samplePair?: typeof sampleDreamPair;
  dream?: typeof runDreamPass;
  review?: typeof runDreamReview;
  sink?: typeof sinkDreamInsight;
  rng?: () => number;
  now?: () => number;
}

export interface DreamCycleRunSummary {
  runId: string;
  status: DreamRun['status'];
  costUsd: number;
  routedRef: string | null;
  replayed: boolean;
}

export type DreamCycleReason =
  | 'completed'
  | 'no-pair'
  | 'cycle-cost-cap'
  | 'rolling-cost-cap'
  | 'governor-refused'
  | 'aborted';

export interface DreamCycleResult {
  fired: boolean;
  reason: DreamCycleReason;
  governorReason?: string;
  cycleId: string;
  attempts: number;
  accepted: number;
  costUsd: number;
  newSpendUsd: number;
  runs: DreamCycleRunSummary[];
  sources?: DreamSourceSnapshot['census'];
}

export function dreamRunId(cycleId: string, index: number): string {
  if (!cycleId.trim()) throw new RangeError('cycleId must be a non-empty string');
  if (!Number.isInteger(index) || index < 0) throw new RangeError('dream index must be a non-negative integer');
  return `${cycleId}:dream:${index + 1}`;
}

function record(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function withoutRefs(fragments: readonly DreamFragment[], refs: readonly string[]): DreamFragment[] {
  const used = new Set(refs);
  return fragments.filter((fragment) => !used.has(fragment.ref));
}

function combinedSignal(parent: AbortSignal | undefined, controller: AbortController): AbortSignal {
  if (!parent) return controller.signal;
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener('abort', () => controller.abort(parent.reason), { once: true });
  return controller.signal;
}

/**
 * Run at most maxDreamsPerCycle attempts. Stable run ids + write-once finalize
 * make a DBOS replay heal accounting and return prior outcomes without another
 * model call or another Blender artifact.
 */
export async function runDreamCycle(input: DreamCycleInput, deps: DreamCycleDeps): Promise<DreamCycleResult> {
  const config = resolveDreamCycleConfig(input.cycle);
  const preflight = await deps.preflight();
  if (!preflight.allow) {
    return {
      fired: false,
      reason: 'governor-refused',
      governorReason: preflight.reason,
      cycleId: input.cycleId,
      attempts: 0,
      accepted: 0,
      costUsd: 0,
      newSpendUsd: 0,
      runs: [],
    };
  }
  if (config.maxCostUsd <= 0) {
    return {
      fired: false,
      reason: 'cycle-cost-cap',
      cycleId: input.cycleId,
      attempts: 0,
      accepted: 0,
      costUsd: 0,
      newSpendUsd: 0,
      runs: [],
    };
  }

  const controller = new AbortController();
  const signal = combinedSignal(input.signal, controller);
  const deadlineMs = (deps.now ?? Date.now)() + config.timeoutMs;
  const timer = setTimeout(() => controller.abort(new Error('dream cycle deadline exceeded')), config.timeoutMs);
  timer.unref?.();

  let sources: DreamSourceSnapshot;
  try {
    sources = await deps.loadSources();
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }

  const sample = deps.samplePair ?? sampleDreamPair;
  const dream = deps.dream ?? runDreamPass;
  const review = deps.review ?? runDreamReview;
  const sink = deps.sink ?? sinkDreamInsight;
  const dreamerModel = resolveDreamPassConfig(input.pass).model;
  let remaining = [...sources.fragments];
  let corpusPromise: Promise<CorpusEntry[]> | null = null;
  let cycleSpend = 0;
  let newSpend = 0;
  let accepted = 0;
  let reason: DreamCycleReason = 'completed';
  const runs: DreamCycleRunSummary[] = [];

  const account = async (run: DreamRun): Promise<void> => {
    const result = await deps.recordSpend(run);
    if (result.recorded) newSpend += result.costUsd;
  };
  const complete = async (input: FinalizeInput): Promise<DreamRun> => {
    const run = await deps.finalizeRun(input);
    await account(run);
    return run;
  };
  const summarize = (run: DreamRun, replayed: boolean): void => {
    runs.push({
      runId: run.runId,
      status: run.status,
      costUsd: run.costUsd,
      routedRef: run.routedRef,
      replayed,
    });
  };

  try {
    for (let index = 0; index < config.maxDreamsPerCycle; index += 1) {
      if (signal.aborted) {
        reason = 'aborted';
        break;
      }
      if (cycleSpend >= config.maxCostUsd) {
        reason = 'cycle-cost-cap';
        break;
      }
      if (newSpend >= preflight.rollingRemainingUsd) {
        reason = 'rolling-cost-cap';
        break;
      }

      const runId = dreamRunId(input.cycleId, index);
      const begun = await deps.beginRun({ runId, cycleId: input.cycleId });
      if (begun.run.status !== 'running') {
        await account(begun.run);
        cycleSpend += begun.run.costUsd;
        if (begun.run.status === 'accepted') accepted += 1;
        summarize(begun.run, true);
        remaining = withoutRefs(remaining, begun.run.fragmentRefs);
        if (begun.run.status === 'no-pair') {
          reason = 'no-pair';
          break;
        }
        continue;
      }

      const sampleOptions: SampleDreamPairOptions = {
        harness: input.potSlug,
        now: deps.now ? deps.now() : Date.now(),
      };
      if (input.sampler) sampleOptions.config = input.sampler;
      if (deps.rng) sampleOptions.rng = deps.rng;
      const pair = sample(remaining, sampleOptions);
      if (!pair) {
        const run = await complete({ runId, status: 'no-pair', outcome: { verdict: 'no-pair' } });
        summarize(run, false);
        reason = 'no-pair';
        break;
      }
      await deps.recordSelection({ runId, pair, dreamerModel });
      remaining = withoutRefs(remaining, [pair.anchor.ref, pair.partner.ref]);

      let dreamUsage: DreamPassUsage | null = null;
      let reviewUsage: DreamReviewUsage | null = null;
      let outcome: Record<string, unknown> | null = null;
      try {
        const dreamed = await dream({
          fragments: [pair.anchor, pair.partner],
          llmCall: deps.llmCall,
          config: input.pass,
          signal,
          cycleDeadlineMs: deadlineMs,
        });
        dreamUsage = dreamed.usage;
        outcome = record(dreamed);
        if (dreamed.verdict === 'none') {
          const run = await complete({ runId, status: 'abstained', dreamUsage, outcome });
          cycleSpend += run.costUsd;
          summarize(run, false);
          continue;
        }
        if (dreamed.verdict === 'malformed') {
          const run = await complete({
            runId,
            status: 'malformed',
            dreamUsage,
            outcome,
            error: dreamed.error,
          });
          cycleSpend += run.costUsd;
          summarize(run, false);
          continue;
        }

        corpusPromise ??= deps.readCorpus(sources.fragments);
        const reviewed = await review({
          insight: dreamed.insight,
          fragments: [pair.anchor, pair.partner],
          corpus: await corpusPromise,
          dreamerModel: dreamed.usage.model,
          llmCall: deps.llmCall,
          config: input.review,
          signal,
          cycleDeadlineMs: deadlineMs,
        });
        reviewUsage = reviewed.usage;
        if (reviewed.verdict === 'reject') {
          const status: DreamRunTerminalStatus = reviewed.reason === 'duplicate' ? 'duplicate' : 'rejected';
          const run = await complete({
            runId,
            status,
            dreamUsage,
            reviewUsage,
            outcome,
            review: record(reviewed),
          });
          cycleSpend += run.costUsd;
          summarize(run, false);
          continue;
        }

        const sunk: SinkDreamInsightResult = await sink({
          dreamRunId: runId,
          cycleId: input.cycleId,
          harnessSlug: input.potSlug,
          insight: dreamed.insight,
          fragments: [pair.anchor, pair.partner],
          review: reviewed,
          workspaceId: input.workspaceId,
          createdBy: 'system:dream-cycle',
        });
        if (!sunk.sunk) throw new Error(`accepted dream was not sunk: ${sunk.reason}`);
        const run = await complete({
          runId,
          status: 'accepted',
          dreamUsage,
          reviewUsage,
          outcome,
          review: record(reviewed),
          routedRef: sunk.routedRef,
        });
        accepted += 1;
        cycleSpend += run.costUsd;
        summarize(run, false);
      } catch (error) {
        const run = await complete({
          runId,
          status: 'error',
          dreamUsage,
          reviewUsage,
          outcome,
          error: error instanceof Error ? error.message : String(error),
        });
        cycleSpend += run.costUsd;
        summarize(run, false);
        if (signal.aborted) {
          reason = 'aborted';
          break;
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }

  return {
    fired: runs.length > 0,
    reason,
    cycleId: input.cycleId,
    attempts: runs.length,
    accepted,
    costUsd: cycleSpend,
    newSpendUsd: newSpend,
    runs,
    sources: sources.census,
  };
}
