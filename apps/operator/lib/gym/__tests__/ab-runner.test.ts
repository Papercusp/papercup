import { describe, it, expect } from 'vitest';
import { runAbEvaluation, type AbConfig, type AbDeps, type AbStore } from '../ab-runner';
import { GYM_JUDGE_RUBRIC_V1 } from '../judge-scoring';
import type { GymScore } from '../judge';
import type { VariantComparisonRow } from '../store';

/**
 * P-014 bounded A/B harness: for each (variant × task × repeat) it runs the pipeline →
 * collects+distills → judges → stores, then derives per-task variance (ε/δ/min-n), cost,
 * and the A-vs-B comparison. Pure orchestration with injected effects, so the SEQUENCING +
 * analysis are tested with fakes (no live operator, no real agents, no real judge, no PG).
 */
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

function cfg(over: Partial<AbConfig> = {}): AbConfig {
  return {
    variants: [
      { variantId: 'baseline', label: 'baseline', overlay: { promptOverrides: {} } },
      { variantId: 'cand-1', label: 'candidate 1', overlay: { promptOverrides: { worker: '# w2' } } },
    ],
    tasks: [
      { taskId: 'task-a', pool: 'train', repoUrl: '/repos/sub', repoCommit: COMMIT, spec: 'Add /health', intent: 'liveness probe', projectContext: 'a Hono API' },
    ],
    repeats: 2,
    rubric: GYM_JUDGE_RUBRIC_V1,
    harnessCommit: COMMIT,
    workspaceId: 'gym-ws',
    scratchRoot: '/scratch/gym',
    deriveOpts: { sigmaMultiple: 2, targetStandardError: 0.25 },
    maxDistillChars: 60_000,
    ...over,
  };
}

/** Fake store: in-memory; comparison derived from recorded scores (max composite per variant×task). */
function makeStore() {
  const variants: string[] = [];
  const tasks: string[] = [];
  const runs: Array<{ runId: string; variantId: string; taskId: string }> = [];
  const finished: string[] = [];
  const scores = new Map<string, GymScore>(); // runId → score
  const store: AbStore = {
    async upsertVariant(v) { variants.push(v.variantId); },
    async upsertTask(t) { tasks.push(t.taskId); },
    async startRun(r) { runs.push({ runId: r.runId, variantId: r.variantId, taskId: r.taskId }); },
    async finishRun(runId) { finished.push(runId); },
    async recordScore(runId, s) { scores.set(runId, s); },
    async comparison(a, b): Promise<VariantComparisonRow[]> {
      const byTask = new Map<string, { a: number | null; b: number | null }>();
      for (const run of runs) {
        const s = scores.get(run.runId);
        if (!s) continue;
        const row = byTask.get(run.taskId) ?? { a: null, b: null };
        if (run.variantId === a) row.a = Math.max(row.a ?? -Infinity, s.composite);
        if (run.variantId === b) row.b = Math.max(row.b ?? -Infinity, s.composite);
        byTask.set(run.taskId, row);
      }
      return [...byTask.entries()].map(([taskId, r]) => ({
        taskId, aComposite: r.a, bComposite: r.b, delta: r.a !== null && r.b !== null ? r.b - r.a : null,
      })).sort((x, y) => x.taskId.localeCompare(y.taskId));
    },
  };
  return { store, variants, tasks, runs, finished, scores };
}

/** Fake deps: pipeline returns a canned outcome; the judge returns scripted composites per call. */
function makeDeps(opts: { store: AbStore; composites: number[]; pipelineUsd?: number; judgeUsd?: number }) {
  const calls = { pipeline: 0, collect: 0, judge: 0 };
  let scoreIdx = 0;
  const deps: AbDeps = {
    store: opts.store,
    async runPipeline(input) {
      calls.pipeline++;
      const slug = `gym${input.variant.variantId}${input.task.taskId}r${input.repeat}`.replace(/[^a-z0-9]/g, '');
      return { harnessSlug: slug, clonePath: `${input.scratchRoot}/${slug}`, workflowID: `wf:${slug}`, outcome: 'passed', pipelineUsd: opts.pipelineUsd ?? 0.4 };
    },
    async collectAndDistill() {
      calls.collect++;
      return { distilledTrace: '## Diff\n+health()', traceRef: '/t/x.json', rawSignals: { ok: true } };
    },
    llmCall: async () => {
      const composite = opts.composites[Math.min(scoreIdx++, opts.composites.length - 1)];
      // Encode the wanted composite as equal dims so judge-scoring's weighted composite == it.
      calls.judge++;
      return { text: JSON.stringify({ d1: composite, d2: composite, d3: composite, rationale: 'fake' }), costUsd: opts.judgeUsd ?? 2.5, inputTokens: 100, outputTokens: 200 };
    },
    newRunId: (v, t, r) => `${v}:${t}:r${r}`,
    now: () => 0,
  };
  return { deps, calls };
}

describe('runAbEvaluation', () => {
  it('runs pipeline+judge once per (variant × task × repeat) and stores each', async () => {
    const { store, runs, finished, scores, variants, tasks } = makeStore();
    const { deps, calls } = makeDeps({ store, composites: [6, 7, 8, 9] }); // baseline:6,7  cand-1:8,9
    const res = await runAbEvaluation(cfg(), deps);

    // 2 variants × 1 task × 2 repeats = 4 runs, each: pipeline → collect → judge → store.
    expect(calls.pipeline).toBe(4);
    expect(calls.collect).toBe(4);
    expect(calls.judge).toBe(4);
    expect(runs).toHaveLength(4);
    expect(finished).toHaveLength(4);
    expect(scores.size).toBe(4);
    expect(new Set(variants)).toEqual(new Set(['baseline', 'cand-1']));
    expect(tasks).toEqual(['task-a']);
    expect(res.outcomes).toHaveLength(4);
  });

  it('derives per-(variant,task) variance + thresholds from the repeat composites', async () => {
    const { store } = makeStore();
    const { deps } = makeDeps({ store, composites: [6, 8, 8, 8] }); // baseline:{6,8}→mean7 sd1 ; cand-1:{8,8}→mean8 sd0
    const res = await runAbEvaluation(cfg(), deps);

    const base = res.perTaskVariance.find((v) => v.variantId === 'baseline' && v.taskId === 'task-a')!;
    expect(base.mean).toBeCloseTo(7);
    expect(base.sd).toBeCloseTo(1);
    expect(base.n).toBe(2);
    expect(base.epsilon).toBeCloseTo(2); // sigmaMultiple 2 × sd 1
    // minRepeats: ceil((sd/targetSE)^2) = ceil((1/0.25)^2) = 16
    expect(base.minRepeats).toBe(16);

    const cand = res.perTaskVariance.find((v) => v.variantId === 'cand-1' && v.taskId === 'task-a')!;
    expect(cand.sd).toBeCloseTo(0);
    expect(cand.minRepeats).toBe(1); // zero variance → 1 repeat suffices
  });

  it('aggregates cost (pipeline + judge) per run and overall', async () => {
    const { store } = makeStore();
    const { deps } = makeDeps({ store, composites: [7, 7, 7, 7], pipelineUsd: 0.4, judgeUsd: 2.5 });
    const res = await runAbEvaluation(cfg(), deps);
    // 4 runs × (0.4 + 2.5) = 11.6 total; mean 2.9.
    expect(res.cost.totalUsd).toBeCloseTo(11.6);
    expect(res.cost.meanRunUsd).toBeCloseTo(2.9);
    expect(res.cost.perVariant['baseline']).toBeCloseTo(5.8);
    expect(res.cost.perVariant['cand-1']).toBeCloseTo(5.8);
  });

  it('produces the A-vs-B comparison (baseline vs candidate, signed delta)', async () => {
    const { store } = makeStore();
    const { deps } = makeDeps({ store, composites: [6, 6, 9, 9] }); // baseline max 6, cand-1 max 9
    const res = await runAbEvaluation(cfg(), deps);
    expect(res.comparison).toEqual([{ taskId: 'task-a', aComposite: 6, bComposite: 9, delta: 3 }]);
  });
});
