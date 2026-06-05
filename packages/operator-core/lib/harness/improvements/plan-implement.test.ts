import { describe, it, expect } from 'vitest';
import { planImplementRun } from './plan-implement';
import type { ImprovementCandidate } from './policy';

function cand(p: Partial<ImprovementCandidate> & { id: string }): ImprovementCandidate {
  return { kind: 'bug', scope: 'operator', title: 'a plain bug', state: 'open', severity: 'major', ...p };
}

const bugs = [cand({ id: 'B1', title: 'bug one' }), cand({ id: 'B2', title: 'bug two' })];
const mixed = [...bugs, cand({ id: 'C1', kind: 'change', title: 'a change' })];

describe('planImplementRun — safety gates', () => {
  it('flag OFF (default) → disabled, dispatches nothing, but reports the waiting count', () => {
    const p = planImplementRun({ items: bugs, flagEnabled: false, runnerHarness: 'runner', maxPerRun: 5 });
    expect(p.action).toBe('disabled');
    expect(p.candidates).toEqual([]);
    expect(p.autoEligibleCount).toBe(2);
  });

  it('flag ON but no runner harness → no-runner (refuses in-process auto-implement, D-006)', () => {
    const p = planImplementRun({ items: bugs, flagEnabled: true, runnerHarness: null, maxPerRun: 5 });
    expect(p.action).toBe('no-runner');
    expect(p.message).toMatch(/RUNNER_HARNESS/);
  });

  it('flag ON + runner + nothing auto-eligible → noop', () => {
    const onlyHuman = [cand({ id: 'C1', kind: 'change' })];
    const p = planImplementRun({ items: onlyHuman, flagEnabled: true, runnerHarness: 'runner', maxPerRun: 5 });
    expect(p.action).toBe('noop');
    expect(p.candidates).toEqual([]);
  });

  it('flag ON + runner + auto-eligible bugs → dispatch, capped by maxPerRun (D-007)', () => {
    const p = planImplementRun({ items: mixed, flagEnabled: true, runnerHarness: 'runner', maxPerRun: 1 });
    expect(p.action).toBe('dispatch');
    expect(p.candidates).toHaveLength(1); // only 1 of the 2 bugs (cap); change excluded
    expect(p.autoEligibleCount).toBe(2);
    expect(p.candidates[0].kind).toBe('bug');
  });

  it('cap 0 → noop even with eligible work', () => {
    const p = planImplementRun({ items: bugs, flagEnabled: true, runnerHarness: 'runner', maxPerRun: 0 });
    expect(p.action).toBe('noop');
  });

  it('only OPEN auto-eligible items are dispatched (resolved excluded)', () => {
    const items = [cand({ id: 'B1' }), cand({ id: 'R1', state: 'resolved' })];
    const p = planImplementRun({ items, flagEnabled: true, runnerHarness: 'runner', maxPerRun: 10 });
    expect(p.candidates.map((c) => c.id)).toEqual(['B1']);
  });
});
