/**
 * Unit tests for buildLoopDeps (loop-deps.ts) — the real LoopDeps builder for the
 * autonomous loop's runner service (P-022 / D-020). The per-run engine, the judge, and
 * the proposer are all injected fakes, so the POOL→VariantEval aggregation, the worst-trace
 * selection, and the persist/record seams are verified with zero LLM / no PG / no operator.
 */
import { describe, it, expect } from 'vitest';
import type { Sql } from 'postgres';
import { buildLoopDeps, type LoopTask } from '../loop-deps';
import { composite, GYM_JUDGE_RUBRIC_V1 } from '../judge-scoring';
import type { AbDeps } from '../ab-runner';
import type { JudgeLlmCall } from '../judge';
import type { GymLlmCall } from '../task-generator';
import type { LoopProposalRecord } from '../loop';

const PIPELINE_USD = 0.5;
const JUDGE_USD = 0.1;
const expComposite = (v: number): number => composite({ d1: v, d2: v, d3: v }, GYM_JUDGE_RUBRIC_V1.weights);

/** A fake per-run engine: deterministic handle + injectable per-task signals. */
function fakeAbDeps(signalsByTask: Record<string, unknown>): AbDeps {
  return {
    store: {
      upsertVariant: async () => {},
      upsertTask: async () => {},
      startRun: async () => {},
      finishRun: async () => {},
      recordScore: async () => {},
      comparison: async () => [],
    },
    runPipeline: async (input) => ({
      harnessSlug: `h${input.task.taskId.replace(/[^a-z0-9]/g, '')}`,
      clonePath: `/tmp/${input.task.taskId}`,
      workflowID: `wf-${input.task.taskId}`,
      outcome: 'completed',
      pipelineUsd: PIPELINE_USD,
    }),
    collectAndDistill: async ({ task }) => ({
      distilledTrace: `distilled trace for ${task.taskId}`,
      traceRef: `ref-${task.taskId}`,
      rawSignals: signalsByTask[task.taskId] ?? {},
    }),
    llmCall: (async () => ({ text: '{}', costUsd: 0, inputTokens: 0, outputTokens: 0 })) as JudgeLlmCall,
    newRunId: (v, t, r) => `${v}::${t}::${r}`,
    now: () => 0,
  };
}

/** A fake judge: reads `score:N` out of the task intent (carried in the prompt) → d1=d2=d3=N. */
const fakeJudge: JudgeLlmCall = async (opts) => {
  const content = opts.messages.map((m) => m.content).join('\n');
  const m = /score:(\d+)/.exec(content);
  const v = m ? Number(m[1]) : 5;
  return { text: JSON.stringify({ d1: v, d2: v, d3: v, rationale: `rationale-${v}` }), costUsd: JUDGE_USD, inputTokens: 1, outputTokens: 1 };
};

const TASKS: LoopTask[] = [
  { taskId: 't-train-lo', pool: 'train', repoUrl: 'r', repoCommit: 'c', spec: 's', intent: 'score:2', projectContext: 'p' },
  { taskId: 't-train-hi', pool: 'train', repoUrl: 'r', repoCommit: 'c', spec: 's', intent: 'score:8', projectContext: 'p' },
  { taskId: 't-dev', pool: 'dev-anchor', repoUrl: 'r', repoCommit: 'c', spec: 's', intent: 'score:6', projectContext: 'p' },
  { taskId: 't-probe', pool: 'probe', repoUrl: 'r', repoCommit: 'c', spec: 's', intent: 'score:5', projectContext: 'p' },
];

/** A tagged-template Sql stub recording the statements persistCycle issues. */
function fakeSql(sink: string[]): Sql {
  return ((strings: TemplateStringsArray) => {
    sink.push(strings.join('?'));
    return Promise.resolve([]);
  }) as unknown as Sql;
}

function makeDeps(over: Partial<Parameters<typeof buildLoopDeps>[0]> = {}, signals: Record<string, unknown> = {}) {
  const sqlSink: string[] = [];
  const proposals: LoopProposalRecord[] = [];
  const proposerCalls: Array<{ system: string; user: string }> = [];
  const proposerCall: GymLlmCall = async (opts) => {
    proposerCalls.push({ system: opts.system ?? '', user: opts.messages.map((m) => m.content).join('\n') });
    return {
      text: JSON.stringify({ promptOverrides: { worker: '# Worker\nre-read acceptance' }, rationale: 'targets the low-score train task' }),
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
  };
  const deps = buildLoopDeps({
    gymSql: fakeSql(sqlSink),
    ports: {} as never,
    judgeCall: fakeJudge,
    proposerCall,
    proposerModel: 'claude-sonnet-4-6',
    tasks: TASKS,
    baseline: { variantId: 'baseline', overlay: { promptOverrides: {} } },
    harnessCommit: 'abc',
    workspaceId: 'gym-ws',
    scratchRoot: '/tmp/scratch',
    timeoutMs: 1000,
    pollIntervalMs: 10,
    maxDistillChars: 10_000,
    abDeps: fakeAbDeps(signals),
    recordProposal: async (rec) => {
      proposals.push(rec);
    },
    ...over,
  });
  return { deps, sqlSink, proposals, proposerCalls };
}

describe('buildLoopDeps.evaluate — pool → VariantEval aggregation', () => {
  it('rolls per-pool composites into trainAgg/devAnchorAgg/trainVector + meanCost', async () => {
    const { deps } = makeDeps({}, { 't-train-lo': { regressions: true }, 't-probe': { planted_bug_caught: true } });
    const { evalResult, worstTraces, costUsd } = await deps.evaluate('baseline', { promptOverrides: {} });

    // trainVector is in task order (lo, hi); trainAgg is their mean.
    expect(evalResult.trainVector).toEqual([expComposite(2), expComposite(8)]);
    expect(evalResult.trainAgg).toBeCloseTo((expComposite(2) + expComposite(8)) / 2, 6);
    expect(evalResult.devAnchorAgg).toBeCloseTo(expComposite(6), 6);

    // Each run costs pipeline + judge; meanCost is the per-run mean across all 4 pools.
    expect(evalResult.meanCost).toBeCloseTo(PIPELINE_USD + JUDGE_USD, 6);
    expect(costUsd).toBeCloseTo(4 * (PIPELINE_USD + JUDGE_USD), 6);

    // un-gameable signals from the injected per-task signals.
    expect(evalResult.anyNewRegression).toBe(true);
    expect(evalResult.allProbesCaught).toBe(true);

    // worst train trace first (lowest composite), carries the judge rationale.
    expect(worstTraces[0].taskId).toBe('t-train-lo');
    expect(worstTraces[0].rationale).toBe('rationale-2');
    expect(worstTraces.map((w) => w.taskId)).toEqual(['t-train-lo', 't-train-hi']);
  });

  it('allProbesCaught is false when a probe task does not catch its planted bug', async () => {
    const { deps } = makeDeps({}, { 't-probe': { planted_bug_caught: false } });
    const { evalResult } = await deps.evaluate('baseline', { promptOverrides: {} });
    expect(evalResult.allProbesCaught).toBe(false);
  });

  it('allProbesCaught is vacuously true when there are no probe tasks', async () => {
    const { deps } = makeDeps({ tasks: TASKS.filter((t) => t.pool !== 'probe') });
    const { evalResult } = await deps.evaluate('baseline', { promptOverrides: {} });
    expect(evalResult.allProbesCaught).toBe(true);
  });

  it('P-025: per-task composite is the MEAN over repeats, cost is summed, worst rationale kept', async () => {
    // A judge that returns a different score on each call (5,7,3,...) so repeats average ≠ a single run.
    let call = 0;
    const seq = [5, 7, 3]; // mean of 3 = 5
    const varyingJudge: JudgeLlmCall = async () => {
      const v = seq[call % seq.length];
      call++;
      return { text: JSON.stringify({ d1: v, d2: v, d3: v, rationale: `r-${v}` }), costUsd: JUDGE_USD, inputTokens: 1, outputTokens: 1 };
    };
    const oneTrain: LoopTask[] = [{ taskId: 't', pool: 'train', repoUrl: 'r', repoCommit: 'c', spec: 's', intent: 'x', projectContext: 'p' }];
    const { deps } = makeDeps({ tasks: oneTrain, repeats: 3, judgeCall: varyingJudge });
    const { evalResult, worstTraces, costUsd } = await deps.evaluate('baseline', { promptOverrides: {} });
    // composite = mean(composite(5),composite(7),composite(3)) = composite(5) since linear in d.
    expect(evalResult.trainAgg).toBeCloseTo((expComposite(5) + expComposite(7) + expComposite(3)) / 3, 6);
    // meanCost is per-run: 3 runs each (pipeline + judge).
    expect(evalResult.meanCost).toBeCloseTo(PIPELINE_USD + JUDGE_USD, 6);
    expect(costUsd).toBeCloseTo(3 * (PIPELINE_USD + JUDGE_USD), 6);
    // worst repeat's rationale (lowest composite = score 3) is fed to the proposer.
    expect(worstTraces[0].rationale).toBe('r-3');
  });

  it('respects worstK when selecting the worst train traces', async () => {
    const manyTrain: LoopTask[] = [2, 9, 4, 7, 1].map((n, i) => ({
      taskId: `t${i}`,
      pool: 'train',
      repoUrl: 'r',
      repoCommit: 'c',
      spec: 's',
      intent: `score:${n}`,
      projectContext: 'p',
    }));
    const { deps } = makeDeps({ tasks: manyTrain, worstK: 2 });
    const { worstTraces } = await deps.evaluate('baseline', { promptOverrides: {} });
    // lowest two composites: score 1 then score 2.
    expect(worstTraces.map((w) => w.rationale)).toEqual(['rationale-1', 'rationale-2']);
  });
});

describe('buildLoopDeps — propose / persistCycle / recordProposal seams', () => {
  it('propose feeds worst traces + changelog to the proposer and returns a merged overlay', async () => {
    const { deps, proposerCalls } = makeDeps();
    const parentOverlay = { promptOverrides: { validator: '# Validator\nbe strict' } };
    const candidate = await deps.propose(
      parentOverlay,
      [{ taskId: 't-train-lo', composite: 2, rationale: 'missed the spec gap' }],
      'cycle 1: baseline established',
    );
    expect(proposerCalls).toHaveLength(1);
    expect(proposerCalls[0].user).toContain('missed the spec gap');
    expect(proposerCalls[0].user).toContain('cycle 1: baseline established');
    // merged overlay = parent ⊕ proposed (prompts-only).
    expect(candidate.overlay.promptOverrides.validator).toBe('# Validator\nbe strict');
    expect(candidate.overlay.promptOverrides.worker).toContain('re-read acceptance');
    expect(candidate.diffFromParent).toBe('worker');
  });

  it('persistCycle writes a gym_cycles row keyed by cycle', async () => {
    const { deps, sqlSink } = makeDeps();
    await deps.persistCycle({ cycle: 3, parentId: 'baseline', candidateId: 'cand-c3', decision: 'accept', gateResults: { ok: true } });
    expect(sqlSink.join('\n')).toMatch(/gym_cycles/);
  });

  it('newVariantId is deterministic per cycle and recordProposal is wired through', async () => {
    const { deps, proposals } = makeDeps();
    expect(deps.newVariantId(5)).toBe('cand-c5');
    expect(typeof deps.recordProposal).toBe('function');
    await deps.recordProposal!({
      cycle: 1,
      candidateId: 'cand-c1',
      parentId: 'baseline',
      overlay: { promptOverrides: { worker: 'new' } },
      parentOverlay: { promptOverrides: {} },
      rationale: 'r',
      devAnchorDelta: 0.1,
      costDelta: 0,
      probeStatus: 'pass',
      verdict: 'accept',
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].candidateId).toBe('cand-c1');
  });

  it('promote and revert are no-ops unless wired (human-gated default, D-020)', async () => {
    const promoted: unknown[] = [];
    const { deps } = makeDeps({ promote: async (o) => { promoted.push(o); } });
    await deps.promote({ promptOverrides: { worker: 'x' } });
    await deps.revert(); // no revert wired → must not throw
    expect(promoted).toHaveLength(1);
  });
});
