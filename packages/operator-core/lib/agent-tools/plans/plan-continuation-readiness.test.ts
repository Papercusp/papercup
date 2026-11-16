/**
 * WI-6554700010049220: the plan continuation verdict is reused only for the exact fenced
 * revision, so a plan-bound write does not re-run the 7-60s readiness bundle per call
 * (the native pre-tool hook wall is 1.5s). Exercised against the REAL operator cache.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import { resetOperatorCacheForTests, _refreshCacheLayerForTests } from '../../cache/instance';
import { __setCachedReadEnabledForTests, resetCachedReadStatsForTests } from '../../cache/cached-read';
import { checkContinuationReadiness, PLAN_READINESS_PENDING, resetSettledReadinessRefusalsForTests,
  type ContinuationReadinessDeps, type ReadinessFence } from './plan-continuation-readiness';
import { checkPlanExecutionGuard, type ExecutionPlanBinding, type PlanExecutionTiming } from './plan-execution-guard';

const WS = 'ws-readiness';
const binding: ExecutionPlanBinding = { planSlug: 'plan-a', harnessSlug: 'papercusp' };

beforeEach(async () => {
  resetSettledReadinessRefusalsForTests();
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
  __setCachedReadEnabledForTests(true);
  setFlagOverridesForTest({ 'papercusp-cache-layer': true });
  await _refreshCacheLayerForTests();
});

afterEach(async () => {
  __setCachedReadEnabledForTests(false);
  setFlagOverridesForTest(null);
  await _refreshCacheLayerForTests();
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
});

function harness(initial: string[] = []) {
  const state = { fence: { harnessSlug: 'papercusp', contentHash: 'h1', startSeq: 296, inputs: '3/44:2/t1' } as ReadinessFence | null,
    verdict: initial, calls: 0, hang: false };
  const deps: ContinuationReadinessDeps = {
    readFence: async () => state.fence,
    evaluate: async () => {
      state.calls++;
      if (state.hang) return new Promise<string[]>(() => { /* never settles */ });
      return [...state.verdict];
    },
  };
  return { state, deps };
}

describe('continuation readiness reuse (WI-6554700010049220)', () => {
  it('reuses a positive verdict for the same fence without running the evaluator', async () => {
    const { state, deps } = harness();
    const timings: PlanExecutionTiming[] = [];
    expect(await checkContinuationReadiness(binding, WS, t => timings.push(t), deps)).toEqual([]);
    expect(state.calls).toBe(1);
    // A warm call must not wait on the bundle at all: an evaluator that never settles
    // would hang this call, which is exactly the hook-wall failure being prevented.
    state.hang = true;
    expect(await checkContinuationReadiness(binding, WS, t => timings.push(t), deps)).toEqual([]);
    expect(state.calls).toBe(1);
    expect(timings.some(t => t.stage === 'readiness_reused')).toBe(true);
  });

  it('misses when the plan revision or start changes', async () => {
    const { state, deps } = harness();
    await checkContinuationReadiness(binding, WS, undefined, deps);
    state.fence = { ...state.fence!, contentHash: 'h2' };
    await checkContinuationReadiness(binding, WS, undefined, deps);
    expect(state.calls).toBe(2);
    state.fence = { ...state.fence!, startSeq: 297 };
    await checkContinuationReadiness(binding, WS, undefined, deps);
    expect(state.calls).toBe(3);
  });

  it('re-evaluates when a plan audit or spec clause lands under the same revision and start', async () => {
    // A revocation through plan_audits / plan_spec_clauses does not void the start, so the
    // input fingerprint is what stops a cached positive verdict from masking it.
    const { state, deps } = harness();
    expect(await checkContinuationReadiness(binding, WS, undefined, deps)).toEqual([]);
    state.fence = { ...state.fence!, inputs: '4/45:2/t1' };
    state.verdict = ['activation_audit_stale'];
    expect(await checkContinuationReadiness(binding, WS, undefined, deps)).toEqual(['activation_audit_stale']);
    expect(state.calls).toBe(2);
    state.fence = { ...state.fence!, inputs: '4/45:3/t2' };
    state.verdict = ['spec_quality_not_current'];
    expect(await checkContinuationReadiness(binding, WS, undefined, deps)).toEqual(['spec_quality_not_current']);
    expect(state.calls).toBe(3);
  });

  it('never caches a refusal, so a repaired plan is admitted on the next call', async () => {
    const { state, deps } = harness(['spec_quality_not_current']);
    expect(await checkContinuationReadiness(binding, WS, undefined, deps)).toEqual(['spec_quality_not_current']);
    state.verdict = [];
    expect(await checkContinuationReadiness(binding, WS, undefined, deps)).toEqual([]);
    expect(state.calls).toBe(2);
  });

  it('shares one evaluation across concurrent callers of the same revision', async () => {
    const { state, deps } = harness();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow: ContinuationReadinessDeps = { ...deps, evaluate: async (...args) => { await gate; return deps.evaluate(...args); } };
    const calls = Array.from({ length: 5 }, () => checkContinuationReadiness(binding, WS, undefined, slow));
    release();
    expect(await Promise.all(calls)).toEqual([[], [], [], [], []]);
    expect(state.calls).toBe(1);
  });

  it('shares a refused evaluation with joined callers without evaluating each caller again', async () => {
    const { state, deps } = harness(['spec_quality_not_current']);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow: ContinuationReadinessDeps = { ...deps,
      evaluate: async (...args) => { await gate; return deps.evaluate(...args); } };
    const calls = Array.from({ length: 5 }, () => checkContinuationReadiness(binding, WS, undefined, slow));
    release();
    const outcomes = await Promise.all(calls);
    expect(outcomes).toEqual(Array.from({ length: 5 }, () => ['spec_quality_not_current']));
    expect(state.calls).toBe(1);
    outcomes[0]!.push('caller-local');
    expect(outcomes[1]).toEqual(['spec_quality_not_current']);

    // Sharing the running verdict must not cache a refusal after it settles.
    state.verdict = [];
    expect(await checkContinuationReadiness(binding, WS, undefined, slow)).toEqual([]);
    expect(state.calls).toBe(2);
  });

  it('preserves independent evaluations when the cache kill switch is off', async () => {
    setFlagOverridesForTest({ 'papercusp-cache-layer': false });
    await _refreshCacheLayerForTests();
    const { state, deps } = harness(['spec_quality_not_current']);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow: ContinuationReadinessDeps = { ...deps,
      evaluate: async (...args) => { await gate; return deps.evaluate(...args); } };
    const calls = Array.from({ length: 5 }, () => checkContinuationReadiness(binding, WS, undefined, slow));
    release();
    expect(await Promise.all(calls)).toEqual(Array.from({ length: 5 }, () => ['spec_quality_not_current']));
    expect(state.calls).toBe(5);
  });

  it('retries after a rejected shared evaluation without retaining the failed build', async () => {
    const { deps } = harness();
    let attempts = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const failure = new Error('readiness evaluation failed');
    const slow: ContinuationReadinessDeps = { ...deps, evaluate: async () => {
      attempts++;
      await gate;
      if (attempts === 1) throw failure;
      return [];
    } };
    const calls = Array.from({ length: 5 }, () => checkContinuationReadiness(binding, WS, undefined, slow));
    release();
    expect(await Promise.allSettled(calls)).toEqual(Array.from({ length: 5 }, () => ({ status: 'rejected', reason: failure })));
    expect(attempts).toBe(1);
    expect(await checkContinuationReadiness(binding, WS, undefined, slow)).toEqual([]);
    expect(attempts).toBe(2);
  });

  it('does not cache when the revision fence is unreadable', async () => {
    const { state, deps } = harness();
    state.fence = null;
    await checkContinuationReadiness(binding, WS, undefined, deps);
    await checkContinuationReadiness(binding, WS, undefined, deps);
    expect(state.calls).toBe(2);
  });

  // EI-28849154189042602: a cold rebuild past the admission budget used to run inside
  // kernel enforce until the ~55s dispatch deadline cancelled the write with no reason.
  it('returns native pending while an ordinary MCP caller keeps awaiting the same build', async () => {
    const { state, deps } = harness();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow: ContinuationReadinessDeps = { ...deps,
      evaluate: async (...args) => { await gate; return deps.evaluate(...args); } };
    let mcpSettled = false;
    const mcp = checkContinuationReadiness(binding, WS, undefined, slow)
      .then(result => { mcpSettled = true; return result; });
    const native = () => checkPlanExecutionGuard({ ownerId: 'native-owner', workspaceId: WS,
      toolName: 'apply_patch', args: {}, readinessDeadlineAtMs: performance.now() + 20 }, {
      readBindings: async () => [binding],
      checkPlan: (selected, workspace, observe, deadlineAtMs) =>
        checkContinuationReadiness(selected, workspace, observe, { ...slow, deadlineAtMs }),
    });
    expect(await native()).toMatchObject({ blockers: [PLAN_READINESS_PENDING], retryable: true });
    expect(mcpSettled).toBe(false);
    release();
    expect(await mcp).toEqual([]);
    expect(await native()).toBeNull();
    expect(state.calls).toBe(1);
  });

  it('includes a slow fresh fence in the native deadline and still fences the warmed retry', async () => {
    const { state, deps } = harness();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow: ContinuationReadinessDeps = { ...deps, deadlineAtMs: performance.now() + 20,
      readFence: async (...args) => { await gate; return deps.readFence(...args); } };
    expect(await checkContinuationReadiness(binding, WS, undefined, slow)).toEqual([PLAN_READINESS_PENDING]);
    expect(state.calls).toBe(0);
    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(await checkContinuationReadiness(binding, WS, undefined, deps)).toEqual([]);
    expect(state.calls).toBe(1);
    state.fence = { ...state.fence!, inputs: 'changed-policy' };
    state.verdict = ['spec_quality_not_current'];
    expect(await checkContinuationReadiness(binding, WS, undefined, deps)).toEqual(['spec_quality_not_current']);
    expect(state.calls).toBe(2);
  });

  it('bounds a fresh start proof even with a warm verdict and still requires it on retry', async () => {
    const { state, deps } = harness();
    expect(await checkContinuationReadiness(binding, WS, undefined, deps)).toEqual([]);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const preflight = async () => { await gate; return ['plan_not_started']; };
    expect(await checkContinuationReadiness(binding, WS, undefined, {
      ...deps, preflight, deadlineAtMs: performance.now() + 20,
    })).toEqual([PLAN_READINESS_PENDING]);
    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(await checkContinuationReadiness(binding, WS, undefined, { ...deps, preflight }))
      .toEqual(['plan_not_started']);
    expect(state.calls).toBe(1);
  });

  it('bounds final freshness without sharing a late owner-specific refusal', async () => {
    const { state, deps } = harness();
    expect(await checkContinuationReadiness(binding, WS, undefined, deps)).toEqual([]);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    expect(await checkContinuationReadiness(binding, WS, undefined, {
      ...deps, deadlineAtMs: performance.now() + 20,
      recheck: async () => { await gate; return ['canonical_plan_binding_stale']; },
    })).toEqual([PLAN_READINESS_PENDING]);
    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    // A different current owner shares the plan cache, never that owner's revocation.
    expect(await checkContinuationReadiness(binding, WS, undefined, {
      ...deps, recheck: async () => [],
    })).toEqual([]);
    expect(state.calls).toBe(1);
    expect(await checkContinuationReadiness(binding, WS, undefined, {
      ...deps, recheck: async () => ['canonical_plan_binding_stale'],
    })).toEqual(['canonical_plan_binding_stale']);
  });

  it('does not turn a late failed fresh-authority read into a cached grant', async () => {
    const { state, deps } = harness();
    expect(await checkContinuationReadiness(binding, WS, undefined, deps)).toEqual([]);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const failure = new Error('fresh start proof unavailable');
    const preflight = async () => { await gate; throw failure; };
    expect(await checkContinuationReadiness(binding, WS, undefined, {
      ...deps, preflight, deadlineAtMs: performance.now() + 20,
    })).toEqual([PLAN_READINESS_PENDING]);
    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    await expect(checkContinuationReadiness(binding, WS, undefined, { ...deps, preflight }))
      .rejects.toBe(failure);
    expect(state.calls).toBe(1);
  });

  it('hands off a native-deadline refusal only to the exact current fence', async () => {
    const { state, deps } = harness(['spec_quality_not_current']);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow: ContinuationReadinessDeps = { ...deps, deadlineAtMs: performance.now() + 20,
      evaluate: async (...args) => { await gate; return deps.evaluate(...args); } };
    expect(await checkContinuationReadiness(binding, WS, undefined, slow)).toEqual([PLAN_READINESS_PENDING]);
    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(await checkContinuationReadiness(binding, WS, undefined, deps)).toEqual(['spec_quality_not_current']);
    expect(state.calls).toBe(1);
    state.verdict = [];
    expect(await checkContinuationReadiness(binding, WS, undefined, deps)).toEqual([]);
    expect(state.calls).toBe(2);
  });

  it('bounds an unreadable native fence without caching its eventual verdict', async () => {
    const { state, deps } = harness();
    state.fence = null;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow: ContinuationReadinessDeps = { ...deps, deadlineAtMs: performance.now() + 20,
      evaluate: async (...args) => { await gate; return deps.evaluate(...args); } };
    expect(await checkContinuationReadiness(binding, WS, undefined, slow)).toEqual([PLAN_READINESS_PENDING]);
    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    state.verdict = ['activation_audit_stale'];
    expect(await checkContinuationReadiness(binding, WS, undefined, deps)).toEqual(['activation_audit_stale']);
    expect(state.calls).toBe(2);
  });

  it('refuses with the retryable pending verdict at the budget, then admits the retry from the warmed cache', async () => {
    const { state, deps } = harness();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow: ContinuationReadinessDeps = { ...deps, budgetMs: 20,
      evaluate: async (...args) => { await gate; return deps.evaluate(...args); } };
    const timings: PlanExecutionTiming[] = [];
    expect(await checkContinuationReadiness(binding, WS, t => timings.push(t), slow)).toEqual([PLAN_READINESS_PENDING]);
    expect(timings.some(t => t.stage === 'readiness_pending')).toBe(true);
    release();
    await gate;
    await new Promise(resolve => setTimeout(resolve, 5));
    // The background build finished and stored the positive verdict; no second evaluation.
    expect(await checkContinuationReadiness(binding, WS, undefined, slow)).toEqual([]);
    expect(state.calls).toBe(1);
  });

  it('holds a background-settled refusal for the retrying caller once, then re-evaluates', async () => {
    const { state, deps } = harness(['spec_quality_not_current']);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow: ContinuationReadinessDeps = { ...deps, budgetMs: 20,
      evaluate: async (...args) => { await gate; return deps.evaluate(...args); } };
    const calls = Array.from({ length: 5 }, () => checkContinuationReadiness(binding, WS, undefined, slow));
    expect(await Promise.all(calls)).toEqual(Array.from({ length: 5 }, () => [PLAN_READINESS_PENDING]));
    release();
    await new Promise(resolve => setTimeout(resolve, 5));
    // The real blockers reach the retry without another evaluation (fail-closed either way).
    expect(await checkContinuationReadiness(binding, WS, undefined, slow)).toEqual(['spec_quality_not_current']);
    expect(state.calls).toBe(1);
    // Consumed once: a repaired plan is re-evaluated on the following call.
    state.verdict = [];
    expect(await checkContinuationReadiness(binding, WS, undefined, slow)).toEqual([]);
    expect(state.calls).toBe(2);
  });

  it('answers within the budget when it is not exceeded (no pending verdict)', async () => {
    const { state, deps } = harness();
    expect(await checkContinuationReadiness(binding, WS, undefined, { ...deps, budgetMs: 1_000 })).toEqual([]);
    expect(state.calls).toBe(1);
  });

  it('distinguishes a held late lock refusal from a fresh missing-scorecard verdict (WI-6554700010049890)', async () => {
    const missing = ['spec_quality_scorecard_missing'];
    const { state, deps } = harness(missing);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow: ContinuationReadinessDeps = { ...deps, budgetMs: 20,
      evaluate: async (...args) => {
        const snapshot = await deps.evaluate(...args);
        if (state.calls === 1) await gate;
        return snapshot;
      } };
    const timings: PlanExecutionTiming[] = [];
    const lock = () => checkPlanExecutionGuard({
      ownerId: 'diagnostic-lock-owner', workspaceId: WS, toolName: 'locks:acquire',
      args: { paths: ['src/diagnostic.ts'], intent: 'private diagnostic' },
      observeTiming: timing => timings.push(timing),
    }, {
      readBindings: async () => [binding],
      checkPlan: (selected, workspace, observe) => checkContinuationReadiness(selected, workspace, observe, slow),
    });

    expect(await lock()).toMatchObject({ blockers: [PLAN_READINESS_PENDING], retryable: true });
    release();
    // Flush the completed build and its late-refusal handoff without a timing sleep.
    await new Promise<void>(resolve => setImmediate(resolve));
    state.verdict = [];
    expect(await deps.evaluate(binding, WS)).toEqual([]);
    expect(state.calls).toBe(2);

    timings.length = 0;
    expect(await lock()).toMatchObject({ blockers: missing });
    expect(state.calls).toBe(2); // The resumed lock did not evaluate the now-ready inputs.
    expect(timings.some(timing => timing.stage === 'readiness_settled_refusal')).toBe(true);
    expect(await lock()).toBeNull();
    expect(state.calls).toBe(3);

    // Positive control: the same public blocker can also come from fresh missing
    // evidence. Its trace lacks the handoff marker and performs an evaluation.
    state.fence = { ...state.fence!, inputs: '4/45:2/t1' };
    state.verdict = missing;
    timings.length = 0;
    expect(await lock()).toMatchObject({ blockers: missing });
    expect(state.calls).toBe(4);
    expect(timings.some(timing => timing.stage === 'readiness_settled_refusal')).toBe(false);
  });

  it('keeps workspaces isolated', async () => {
    const { state, deps } = harness();
    await checkContinuationReadiness(binding, WS, undefined, deps);
    await checkContinuationReadiness(binding, 'ws-other', undefined, deps);
    expect(state.calls).toBe(2);
  });
});
