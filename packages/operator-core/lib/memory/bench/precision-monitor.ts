/**
 * precision-monitor.ts — the memory-precision-bench RUN path
 * (relight-self-learning-edges-2026-06-14 P-033).
 *
 * The injection floor is SOLVED (D-007: 0.45 cosine / 0.40 lexical is sweep-
 * optimal, FP@5 ~17% at R@10 ~82%) but was benchmarked ONCE. This monitor
 * replays the frozen gold set against the production HYBRID backend AT THE
 * PRODUCTION PUSH FLOOR on a weekly cadence and records the metrics, so floor
 * DRIFT is visible on the Learning tab instead of silently rotting.
 *
 * Why the floored replay (not the unfloored `runBench`): D-007 notes EI-533's
 * "FP@5 = 100%" is the UNFLOORED number; the production push path is floored to
 * ~17%. To MONITOR production precision we measure the same floor the live
 * injector applies — `runGoldSet(..., { minScore, minLexScore })` with the
 * exported {@link MEMORY_INJECTION_COSINE_FLOOR}/{@link MEMORY_INJECTION_LEX_FLOOR}.
 *
 * Cost: embeddings only (corpus seed + gold queries), NO LLM and NO writes to the
 * live memory store — the bench runs in an isolated `bench_memory` PG schema
 * (created/dropped by `makeBackendCtx('hybrid')`). ~$0.05/run (or free on a local
 * embedder). Flag-only gating (no governor — like change-ledger): the routine is
 * cheap bookkeeping, not a budgeted frontier loop.
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { runGoldSet, seedCorpus } from '@papercusp/memory/bench';

import { MEMORY_INJECTION_COSINE_FLOOR, MEMORY_INJECTION_LEX_FLOOR } from '../injection';
import { loadCorpusFixture } from './corpus';
import { loadGoldSetFixture } from './gold-set';
import { BENCH_SCOPE, makeBackendCtx } from './run-bench';
import { recordMemoryPrecisionRun, readMemoryPrecision, type MemoryPrecisionMetrics } from './precision-read';
import { evaluateRecallDrop, BASELINE_HISTORY_WINDOW, type RecallDropEvaluation } from './precision-alert';
import { fileRecallDropEi, resolveRecallDropEi } from './precision-alert-ei';

/** Test/seam injection — swap the bench, the DB write, the flag, the invalidation. */
export interface MemoryPrecisionBenchDeps {
  flag?: (installSlug: string) => Promise<boolean>;
  /** Override the actual bench run (tests inject fixed metrics — no embedder, no PG). */
  runBench?: () => Promise<MemoryPrecisionMetrics>;
  /** Override the DB write (tests capture without a live pool). */
  record?: (workspaceId: string, m: MemoryPrecisionMetrics) => Promise<number>;
  /** Override the sync invalidation (tests assert it fired). */
  invalidate?: () => void;
  /** Override the prior-r@10-history read the recall-drop baseline is built from (EI-10047). */
  history?: (workspaceId: string) => Promise<Array<number | null>>;
  /** Override the recall-drop escalation (file on alert / resolve on recovery). Tests capture without PG. */
  escalateRecall?: (workspaceId: string, backend: string, rowId: number, evaluation: RecallDropEvaluation) => Promise<void>;
  log?: (m: string) => void;
}

export type MemoryPrecisionOutcome =
  | { ran: false; skipReason: 'flag-off' }
  | { ran: false; skipReason: 'failed'; error: string }
  | { ran: true; metrics: MemoryPrecisionMetrics; rowId: number };

function fmt(v: number | null): string {
  return v == null ? '—' : v.toFixed(3);
}

/**
 * Run the floored hybrid gold-set ONCE and return the metrics (no DB write).
 * Exported for a CLI / one-off seeding run and for the op's default path.
 */
export async function benchMemoryPrecision(): Promise<MemoryPrecisionMetrics> {
  const corpus = loadCorpusFixture('v1');
  const gold = loadGoldSetFixture('v1');
  const ctx = await makeBackendCtx('hybrid', false);
  try {
    await seedCorpus(ctx.backend, corpus, { scope: BENCH_SCOPE, verbatim: true, concurrency: 8 });
    const retrieval = await runGoldSet(ctx.backend, gold.queries, {
      scope: BENCH_SCOPE,
      limit: 10,
      concurrency: 4,
      // Measure the EXACT production push floor — the whole point is monitoring
      // the LIVE injector's precision, not the unfloored raw-recall number.
      minScore: MEMORY_INJECTION_COSINE_FLOOR,
      minLexScore: MEMORY_INJECTION_LEX_FLOOR,
      fusionMode: 'floored-union',
    });
    const hardNeg = retrieval.byClass['hard-negative'];
    return {
      backend: ctx.backend.name,
      corpusVersion: 'v1',
      goldVersion: gold.version,
      corpusN: corpus.length,
      goldN: gold.queries.length,
      floorCosine: MEMORY_INJECTION_COSINE_FLOOR,
      floorLex: MEMORY_INJECTION_LEX_FLOOR,
      fpAt5: hardNeg?.fpAt5 ?? null,
      rAt10: retrieval.overall.r10,
      pAt5: retrieval.overall.p5,
      mrr: retrieval.overall.mrr,
      medianTopScore: retrieval.overall.medianTopScore ?? null,
      latencyP50Ms: retrieval.latency.p50,
      byClass: retrieval.byClass as Record<string, unknown>,
      // Embedding cost is not separately metered here (small, no LLM); left null.
      costUsd: null,
      notes: null,
    };
  } finally {
    // A cleanup failure (e.g. a held pooled connection) must never lose the run;
    // makeBackendCtx already drops the bench schema. Swallow non-fatally.
    await ctx.cleanup().catch(() => {});
  }
}

async function defaultInvalidate(): Promise<void> {
  // Lazy import so the read/test graph never pulls the SSE module.
  try {
    const m = await import('../../sync-sse');
    m.notifySyncInvalidate('learning.knowledge');
    m.notifySyncInvalidate('learning.efficacy');
  } catch {
    /* best-effort */
  }
}

/**
 * The orchestration the `memory-precision:bench` op runs: flag gate → bench →
 * record → invalidate. Every failure is non-fatal (a `failed` outcome, never a
 * throw that wedges the routine tick) — monitoring must never break the loop.
 */
export async function runMemoryPrecisionMonitor(
  input: { workspaceId: string; installSlug: string },
  deps: MemoryPrecisionBenchDeps = {},
): Promise<MemoryPrecisionOutcome> {
  const log = deps.log ?? ((m: string) => console.log(`[memory-precision-bench] ${m}`));
  const flag = deps.flag ?? ((slug: string) => getFlag(FLAGS.MEMORY_PRECISION_BENCH, `routine:${slug}`));
  if (!(await flag(input.installSlug))) return { ran: false, skipReason: 'flag-off' };

  let metrics: MemoryPrecisionMetrics;
  try {
    metrics = await (deps.runBench ?? benchMemoryPrecision)();
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log(`bench failed (non-fatal): ${error}`);
    return { ran: false, skipReason: 'failed', error };
  }

  // EI-10047: read the rolling baseline BEFORE this run's own row exists, so
  // the just-recorded number never contaminates the history it's judged
  // against. Best-effort — a history-read failure degrades to
  // 'insufficient-history' (never alerts), it never wedges the record path.
  let priorRAt10: Array<number | null> = [];
  try {
    if (deps.history) {
      priorRAt10 = await deps.history(input.workspaceId);
    } else {
      const { getOrgPg } = await import('@papercusp/db-org');
      const snap = await readMemoryPrecision(getOrgPg().sql, input.workspaceId, BASELINE_HISTORY_WINDOW);
      priorRAt10 = snap.trend.map((r) => r.rAt10);
    }
  } catch (e) {
    log(`recall-baseline history read failed (non-fatal, treated as no history): ${e instanceof Error ? e.message : e}`);
  }

  let rowId = 0;
  try {
    if (deps.record) {
      rowId = await deps.record(input.workspaceId, metrics);
    } else {
      const { getOrgPg } = await import('@papercusp/db-org');
      rowId = await recordMemoryPrecisionRun(getOrgPg().sql, input.workspaceId, metrics);
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log(`record failed (non-fatal): ${error}`);
    return { ran: false, skipReason: 'failed', error };
  }

  try {
    if (deps.invalidate) deps.invalidate();
    else await defaultInvalidate();
  } catch {
    /* best-effort — a missed invalidation just delays the panel refresh */
  }

  // EI-10047: alert on a recall-quality drop the routine's own liveness check
  // (learning-loop-health.ts) can't see — it only classifies whether this
  // routine FIRED, not whether what it measured is any good. Best-effort:
  // an escalation failure must never turn a good bench run into a 'failed'
  // outcome, and must never re-throw into the routine tick.
  const evaluation = evaluateRecallDrop(priorRAt10, metrics.rAt10);
  try {
    if (deps.escalateRecall) {
      await deps.escalateRecall(input.workspaceId, metrics.backend, rowId, evaluation);
    } else if (evaluation.alert) {
      await fileRecallDropEi({ workspaceId: input.workspaceId, backend: metrics.backend, rowId, evaluation });
    } else {
      await resolveRecallDropEi({ workspaceId: input.workspaceId, backend: metrics.backend, rowId, evaluation });
    }
  } catch (e) {
    log(`recall-drop escalation failed (non-fatal): ${e instanceof Error ? e.message : e}`);
  }

  log(
    `recorded run #${rowId}: fp@5=${fmt(metrics.fpAt5)} r@10=${fmt(metrics.rAt10)} ` +
      `p@5=${fmt(metrics.pAt5)} mrr=${fmt(metrics.mrr)} (floor ${metrics.floorCosine}/${metrics.floorLex}) ` +
      `recall-canary=${evaluation.reason}${evaluation.alert ? ' ALERT' : ''}`,
  );
  return { ran: true, metrics, rowId };
}
