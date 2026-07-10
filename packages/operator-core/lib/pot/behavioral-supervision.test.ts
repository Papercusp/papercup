import { describe, it, expect } from 'vitest';
import {
  scopeViolation,
  convergenceChurn,
  shouldWakeOnScopeViolation,
  shouldWakeOnChurn,
  DEFAULT_BEHAVIORAL_WAKE_POLICY as POLICY,
} from './behavioral-supervision';

describe('scopeViolation (P-052)', () => {
  const lane = ['packages/operator-core/lib/pot-eval/**'];

  it('no violation when every touched file is in-lane', () => {
    const v = scopeViolation({ declaredLane: lane, touchedFiles: ['packages/operator-core/lib/pot-eval/scenario.ts'] });
    expect(v.violated).toBe(false);
    expect(v.outOfLaneRatio).toBe(0);
  });

  it('flags files outside the declared lane (the EKG-blind off-brief signal)', () => {
    const v = scopeViolation({
      declaredLane: lane,
      touchedFiles: ['packages/operator-core/lib/pot-eval/scenario.ts', 'apps/operator/app/random/page.tsx', 'libs/flags/src/types.ts'],
    });
    expect(v.violated).toBe(true);
    expect(v.outOfLaneFiles).toEqual(['apps/operator/app/random/page.tsx', 'libs/flags/src/types.ts']);
    expect(v.outOfLaneRatio).toBeCloseTo(2 / 3, 5);
  });

  it('never flags an UN-LANED cup (exploratory work is unconstrained — no false positive)', () => {
    const v = scopeViolation({ declaredLane: [], touchedFiles: ['anything.ts', 'else.ts'] });
    expect(v.violated).toBe(false);
  });

  it('never flags a cup that touched nothing', () => {
    expect(scopeViolation({ declaredLane: lane, touchedFiles: [] }).violated).toBe(false);
  });
});

describe('shouldWakeOnScopeViolation — the false-positive guard (WAKE, never auto-kill)', () => {
  const lane = ['src/feature/**'];

  it('a single incidental out-of-lane file (e.g. a dependency fix) does NOT wake', () => {
    const touchedFiles = [...Array.from({ length: 19 }, (_, i) => `src/feature/f${i}.ts`), 'src/shared/dep.ts'];
    const v = scopeViolation({ declaredLane: lane, touchedFiles });
    expect(v.violated).toBe(true); // it IS a signal…
    expect(shouldWakeOnScopeViolation(v, POLICY)).toBe(false); // …but ratio 0.05 + count 1 stays under threshold
  });

  it('sustained off-lane work (high ratio) wakes', () => {
    const v = scopeViolation({ declaredLane: lane, touchedFiles: ['wrong/a.ts', 'wrong/b.ts', 'src/feature/ok.ts'] });
    expect(v.outOfLaneRatio).toBeCloseTo(2 / 3, 5);
    expect(shouldWakeOnScopeViolation(v, POLICY)).toBe(true); // ratio ≥ 0.5
  });

  it('several distinct off-lane files (high count) wake even at a low ratio', () => {
    const touchedFiles = [...Array.from({ length: 20 }, (_, i) => `src/feature/f${i}.ts`), 'a/x.ts', 'b/y.ts', 'c/z.ts'];
    const v = scopeViolation({ declaredLane: lane, touchedFiles });
    expect(v.outOfLaneRatio).toBeLessThan(0.5); // ratio is low…
    expect(v.outOfLaneFiles.length).toBe(3);
    expect(shouldWakeOnScopeViolation(v, POLICY)).toBe(true); // …but count ≥ 3 wakes
  });
});

describe('convergenceChurn (P-052)', () => {
  it('a converged item is never churn, however many retries it took', () => {
    const v = convergenceChurn({ failCount: 5, converged: true });
    expect(v.unproductiveAttempts).toBe(0);
    expect(shouldWakeOnChurn(v, POLICY)).toBe(false);
  });

  it('an un-converged item with repeated attempts is churn (wakes above threshold)', () => {
    const v = convergenceChurn({ failCount: 2, converged: false, statusOscillations: 1 });
    expect(v.unproductiveAttempts).toBe(3);
    expect(shouldWakeOnChurn(v, POLICY)).toBe(true); // ≥ 2
  });

  it('a first un-converged attempt does NOT wake (one retry is normal, not thrashing)', () => {
    const v = convergenceChurn({ failCount: 1, converged: false });
    expect(v.unproductiveAttempts).toBe(1);
    expect(shouldWakeOnChurn(v, POLICY)).toBe(false); // < 2 — fires before the breaker(3), after one
  });
});
