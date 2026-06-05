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

describe('planImplementRun — close-loop anti-re-dispatch guards (close-loop D-001)', () => {
  const NOW = Date.parse('2026-06-05T12:00:00Z');

  it('a freshly-claimed item is IN-FLIGHT and skipped (no double dispatch)', () => {
    const items = [
      cand({ id: 'B1', assignee: 'improvement-runner', assignedAt: '2026-06-05T11:30:00Z' }), // 30 min ago
      cand({ id: 'B2' }),
    ];
    const p = planImplementRun({ items, flagEnabled: true, runnerHarness: 'runner', maxPerRun: 10, nowMs: NOW });
    expect(p.candidates.map((c) => c.id)).toEqual(['B2']);
    expect(p.inFlightCount).toBe(1);
    expect(p.autoEligibleCount).toBe(2);
  });

  it('a STALE claim (runner died) becomes dispatchable again after staleClaimMs', () => {
    const items = [cand({ id: 'B1', assignee: 'improvement-runner', assignedAt: '2026-06-05T08:00:00Z' })]; // 4h ago
    const p = planImplementRun({ items, flagEnabled: true, runnerHarness: 'runner', maxPerRun: 10, nowMs: NOW });
    expect(p.candidates.map((c) => c.id)).toEqual(['B1']);
    expect(p.inFlightCount).toBe(0);
  });

  it('a claim with no assignedAt is treated as in-flight (conservative)', () => {
    const items = [cand({ id: 'B1', assignee: 'someone' })];
    const p = planImplementRun({ items, flagEnabled: true, runnerHarness: 'runner', maxPerRun: 10, nowMs: NOW });
    expect(p.action).toBe('noop');
    expect(p.inFlightCount).toBe(1);
  });

  it('attempts-exhausted items never auto-dispatch again', () => {
    const items = [cand({ id: 'B1', attempts: 3 }), cand({ id: 'B2', attempts: 2 })];
    const p = planImplementRun({ items, flagEnabled: true, runnerHarness: 'runner', maxPerRun: 10, nowMs: NOW });
    expect(p.candidates.map((c) => c.id)).toEqual(['B2']);
    expect(p.attemptsExhaustedCount).toBe(1);
    expect(p.message).toMatch(/attempts-exhausted/);
  });

  it('a needs-human item is not in the auto lane at all (policy tier)', () => {
    const items = [cand({ id: 'B1', needsHuman: true })];
    const p = planImplementRun({ items, flagEnabled: true, runnerHarness: 'runner', maxPerRun: 10, nowMs: NOW });
    expect(p.action).toBe('noop');
    expect(p.autoEligibleCount).toBe(0);
  });

  it('everything in-flight → noop with the skip note (an armed loop idles instead of re-dispatching)', () => {
    const items = [cand({ id: 'B1', assignee: 'improvement-runner', assignedAt: '2026-06-05T11:55:00Z' })];
    const p = planImplementRun({ items, flagEnabled: true, runnerHarness: 'runner', maxPerRun: 10, nowMs: NOW });
    expect(p.action).toBe('noop');
    expect(p.message).toMatch(/in-flight/);
  });
});
