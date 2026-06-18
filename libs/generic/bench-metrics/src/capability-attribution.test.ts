import { describe, it, expect } from 'vitest';
import {
  buildCapabilityAttribution,
  buildCrossSuiteAttribution,
  formatAttributionLines,
  DEFAULT_CONTROL_ARM,
  ATTRIBUTION_CAVEATS,
} from './capability-attribution';
import type { TaskRunResult, ArmId, BenchSuite, GraderStatus } from './schema';

let seq = 0;
function mk(over: Partial<TaskRunResult> = {}): TaskRunResult {
  return {
    runId: 'run1',
    suite: 'swe-bench-pro',
    modality: 'diff',
    taskId: 't1',
    arm: 'vanilla',
    seed: seq++,
    resolved: false,
    graderStatus: 'failed',
    graderFamily: 'swe-bench-pro',
    graderVersion: 'v1',
    tokensIn: 0,
    tokensOut: 0,
    tokensTotal: 0,
    costUsd: 0,
    priceTableVersion: 'price-table-v1',
    wallClockMs: 1000,
    turns: 1,
    budgetTokens: 2_000_000,
    capped: false,
    generationStatus: 'completed',
    modelId: 'claude-opus-4-8',
    harnessVersion: 'bp@sha',
    preregHash: 'h',
    rolloutId: 'ro1',
    createdAt: '2026-06-15T00:00:00Z',
    ...over,
  };
}

/** One scored attempt: task, arm, resolved, tokens (1M Opus input ≈ $5). */
function attempt(taskId: string, arm: ArmId, resolved: boolean, tokensIn: number, suite: BenchSuite = 'swe-bench-pro'): TaskRunResult {
  return mk({
    taskId,
    arm,
    suite,
    resolved,
    graderStatus: (resolved ? 'passed' : 'failed') as GraderStatus,
    tokensIn,
    tokensTotal: tokensIn,
  });
}

/** N tasks for one arm, each with a single seed of the given resolved value + token cost. */
function tasks(arm: ArmId, ids: string[], resolved: boolean, tokensIn: number, suite: BenchSuite = 'swe-bench-pro'): TaskRunResult[] {
  return ids.map((id) => attempt(id, arm, resolved, tokensIn, suite));
}

describe('buildCapabilityAttribution', () => {
  it('holds the control fixed and reports each capability arm lift over it (D-011 inverse view)', () => {
    const ids = ['t1', 't2', 't3', 't4'];
    const rows = [
      ...tasks('vanilla', ids, false, 1_000_000), // control: 0/4
      ...tasks('+memory', ids, true, 1_000_000), //  +memory: 4/4
      ...tasks('+coord', ['t1', 't2'], true, 1_000_000), // +coord on a subset: 2/2 of t1,t2
      ...tasks('+coord', ['t3', 't4'], false, 1_000_000),
    ];
    const rep = buildCapabilityAttribution(rows);
    expect(rep.control).toBe('vanilla');
    expect(rep.suite).toBe('swe-bench-pro');
    // capability order is first-seen, control removed
    expect(rep.capabilities.map((c) => c.capability)).toEqual(['+memory', '+coord']);

    const mem = rep.capabilities.find((c) => c.capability === '+memory')!;
    expect(mem.controlPassAt1).toBeCloseTo(0, 6);
    expect(mem.capabilityPassAt1).toBeCloseTo(1, 6);
    expect(mem.accuracyDelta).toBeCloseTo(1, 6);
    expect(mem.unlockedTasks).toEqual(['t1', 't2', 't3', 't4']);
    expect(mem.regressedTasks).toEqual([]);
    expect(mem.tasksCompared).toBe(4);

    const coord = rep.capabilities.find((c) => c.capability === '+coord')!;
    expect(coord.capabilityPassAt1).toBeCloseTo(0.5, 6);
    expect(coord.accuracyDelta).toBeCloseTo(0.5, 6);
    expect(coord.unlockedTasks).toEqual(['t1', 't2']);
    expect(coord.neutralTasks).toEqual(['t3', 't4']); // both fail t3/t4 → neutral
  });

  it('flags significance via CI non-overlap on pass@1 (conservative)', () => {
    const ids = ['t1', 't2', 't3', 't4', 't5', 't6'];
    // control all-fail (CI collapses to [0,0]); +memory all-pass (CI [1,1]) → disjoint → significant.
    const rows = [...tasks('vanilla', ids, false, 1_000_000), ...tasks('+memory', ids, true, 1_000_000)];
    const sig = buildCapabilityAttribution(rows).capabilities[0];
    expect(sig.significant).toBe(true);

    // Both arms identical per-task rate (0.5 each task) → CIs equal → NOT disjoint → not significant.
    const half = (arm: ArmId): TaskRunResult[] =>
      ids.flatMap((id) => [attempt(id, arm, true, 1_000_000), attempt(id, arm, false, 1_000_000)]);
    const overlap = buildCapabilityAttribution([...half('vanilla'), ...half('+memory')]).capabilities[0];
    expect(overlap.significant).toBe(false);
    expect(overlap.accuracyDelta).toBeCloseTo(0, 6);
  });

  it('cost-normalizes the lift (D-008): paretoDominates only when better AND no costlier', () => {
    const ids = ['t1', 't2', 't3', 't4'];
    // +memory: better accuracy (all pass) AND cheaper per attempt (100k vs control 1M) → strictly dominates.
    const cheaperBetter = buildCapabilityAttribution([
      ...tasks('vanilla', ids, false, 1_000_000),
      ...tasks('+memory', ids, true, 100_000),
    ]).capabilities[0];
    expect(cheaperBetter.paretoDominates).toBe(true);
    expect(cheaperBetter.costFraction).toBeCloseTo(0.1, 6); // 100k / 1M mean $/attempt

    // +memory: better accuracy but MORE expensive (1M vs control 100k) → not strictly Pareto-better.
    const pricierBetter = buildCapabilityAttribution([
      ...tasks('vanilla', ids, false, 100_000),
      ...tasks('+memory', ids, true, 1_000_000),
    ]).capabilities[0];
    expect(pricierBetter.accuracyDelta).toBeGreaterThan(0);
    expect(pricierBetter.paretoDominates).toBe(false);
  });

  it('costRatio is costPerResolved(cap)/control, null when the control resolves nothing', () => {
    const ids = ['t1', 't2', 't3', 't4'];
    // control resolves nothing → control.costPerResolved is null → costRatio null.
    const noCtrlResolved = buildCapabilityAttribution([
      ...tasks('vanilla', ids, false, 1_000_000),
      ...tasks('+memory', ids, true, 1_000_000),
    ]).capabilities[0];
    expect(noCtrlResolved.costRatio).toBeNull();

    // control 2/4 @1M ($5/row), +memory 4/4 @1M → cpr_ctrl = (4·5)/2 = 10; cpr_mem = (4·5)/4 = 5 → ratio 0.5.
    const ratio = buildCapabilityAttribution([
      ...tasks('vanilla', ['t1', 't2'], true, 1_000_000),
      ...tasks('vanilla', ['t3', 't4'], false, 1_000_000),
      ...tasks('+memory', ids, true, 1_000_000),
    ]).capabilities[0];
    expect(ratio.costRatio).toBeCloseTo(0.5, 6); // cheaper per resolved task
  });

  it('classifies per-task unlocked / regressed / neutral over commonly-scored tasks', () => {
    const rows = [
      // control: t1 pass, t2 fail, t3 pass
      attempt('t1', 'vanilla', true, 1_000_000),
      attempt('t2', 'vanilla', false, 1_000_000),
      attempt('t3', 'vanilla', true, 1_000_000),
      // +coord: t1 fail (regressed), t2 pass (unlocked), t3 pass (neutral), t4 pass (no control row → ignored)
      attempt('t1', '+coord', false, 1_000_000),
      attempt('t2', '+coord', true, 1_000_000),
      attempt('t3', '+coord', true, 1_000_000),
      attempt('t4', '+coord', true, 1_000_000),
    ];
    const c = buildCapabilityAttribution(rows).capabilities[0];
    expect(c.unlockedTasks).toEqual(['t2']);
    expect(c.regressedTasks).toEqual(['t1']);
    expect(c.neutralTasks).toEqual(['t3']);
    expect(c.tasksCompared).toBe(3); // t4 excluded (not scored in control)
  });

  it('excludes infra-error rows from the per-task rate and the headline', () => {
    const rows = [
      attempt('t1', 'vanilla', false, 1_000_000),
      attempt('t1', '+memory', true, 1_000_000),
      // a generation-infra row on +memory — must not count as a resolved/fail
      mk({ taskId: 't2', arm: '+memory', generationStatus: 'error', resolved: null, tokensIn: 1_000_000, tokensTotal: 1_000_000 }),
    ];
    const c = buildCapabilityAttribution(rows).capabilities[0];
    expect(c.tasksCompared).toBe(1); // only t1 scored in both
    expect(c.unlockedTasks).toEqual(['t1']);
  });

  it('respects an explicit capabilityArms allow-list and default control', () => {
    const ids = ['t1', 't2'];
    const rows = [
      ...tasks('vanilla', ids, false, 1_000_000),
      ...tasks('+memory', ids, true, 1_000_000),
      ...tasks('ours', ids, true, 1_000_000),
    ];
    const only = buildCapabilityAttribution(rows, { capabilityArms: ['+memory'] });
    expect(only.capabilities.map((c) => c.capability)).toEqual(['+memory']);
    expect(DEFAULT_CONTROL_ARM).toBe('vanilla');
  });

  it('supports a non-default control arm', () => {
    const ids = ['t1', 't2'];
    const rows = [...tasks('baseline-b-native', ids, false, 1_000_000), ...tasks('+memory', ids, true, 1_000_000)];
    const rep = buildCapabilityAttribution(rows, { control: 'baseline-b-native' });
    expect(rep.control).toBe('baseline-b-native');
    expect(rep.capabilities[0].accuracyDelta).toBeCloseTo(1, 6);
  });

  it('throws on empty rows and on a missing control arm', () => {
    expect(() => buildCapabilityAttribution([])).toThrow(/no rows/);
    const noControl = tasks('+memory', ['t1'], true, 1_000_000);
    expect(() => buildCapabilityAttribution(noControl)).toThrow(/control arm "vanilla" has no rows/);
  });

  it('always carries the honest-framing caveats', () => {
    const rows = [attempt('t1', 'vanilla', false, 1_000_000), attempt('t1', '+memory', true, 1_000_000)];
    expect(buildCapabilityAttribution(rows).caveats).toEqual(ATTRIBUTION_CAVEATS);
    expect(ATTRIBUTION_CAVEATS.length).toBeGreaterThanOrEqual(3);
  });
});

describe('buildCrossSuiteAttribution', () => {
  it('folds per-suite reports into cells + a per-capability roll-up', () => {
    const swe = buildCapabilityAttribution([
      ...tasks('vanilla', ['a1', 'a2', 'a3', 'a4'], false, 1_000_000, 'swe-bench-pro'),
      ...tasks('+memory', ['a1', 'a2', 'a3', 'a4'], true, 100_000, 'swe-bench-pro'), // sig + cheaper + better
    ]);
    const term = buildCapabilityAttribution([
      ...tasks('vanilla', ['b1', 'b2'], true, 1_000_000, 'terminal-bench'),
      ...tasks('+memory', ['b1', 'b2'], false, 1_000_000, 'terminal-bench'), // a regression on terminal-bench
    ]);
    const cross = buildCrossSuiteAttribution([swe, term]);

    expect(cross.cells).toHaveLength(2);
    expect(cross.cells.map((c) => c.suite)).toEqual(['swe-bench-pro', 'terminal-bench']);

    const roll = cross.rollup.find((r) => r.capability === '+memory')!;
    expect(roll.suites).toBe(2);
    expect(roll.meanAccuracyDelta).toBeCloseTo((1 + -1) / 2, 6); // +1 on swe, -1 on terminal
    expect(roll.suitesSignificant).toBe(2); // both CIs collapse (all-pass vs all-fail) → disjoint
    expect(roll.suitesParetoBetter).toBe(1); // only swe (cheaper+better); terminal regressed
    expect(roll.totalUnlocked).toBe(4); // 4 on swe, 0 on terminal
    expect(roll.totalRegressed).toBe(2); // 0 on swe, 2 on terminal
    expect(cross.caveats).toEqual(ATTRIBUTION_CAVEATS);
  });

  it('rolls a capability up over only the suites it appeared on', () => {
    const swe = buildCapabilityAttribution([
      ...tasks('vanilla', ['a1', 'a2'], false, 1_000_000, 'swe-bench-pro'),
      ...tasks('+coord', ['a1', 'a2'], true, 1_000_000, 'swe-bench-pro'),
    ]);
    const term = buildCapabilityAttribution([
      ...tasks('vanilla', ['b1', 'b2'], false, 1_000_000, 'terminal-bench'),
      ...tasks('+memory', ['b1', 'b2'], true, 1_000_000, 'terminal-bench'),
    ]);
    const cross = buildCrossSuiteAttribution([swe, term]);
    expect(cross.rollup.find((r) => r.capability === '+coord')!.suites).toBe(1);
    expect(cross.rollup.find((r) => r.capability === '+memory')!.suites).toBe(1);
  });
});

describe('formatAttributionLines', () => {
  it('marks a significant Pareto-better lift ✓, a regression ✗', () => {
    const rep = buildCapabilityAttribution([
      ...tasks('vanilla', ['t1', 't2', 't3', 't4'], false, 1_000_000),
      ...tasks('+memory', ['t1', 't2', 't3', 't4'], true, 100_000), // sig + cheaper + better
      ...tasks('+coord', ['t1', 't2', 't3', 't4'], false, 1_000_000), // no lift
    ]);
    const lines = formatAttributionLines(rep);
    expect(lines[0]).toMatch(/^✓ \+memory vs vanilla on swe-bench-pro: \+100\.0pp pass@1 \(sig\)/);
    expect(lines[0]).toContain('cost n/a'); // control resolved nothing → costPerResolved null → ratio n/a
    // +coord: 0 delta → neutral mark '·'
    expect(lines[1].startsWith('·')).toBe(true);
  });
});
