/**
 * harness-test-rollup — P-085 of harness-tests-tab-and-tester-promotion-2026-05-26.
 *
 * The plan↔test link math: assertion status derived from covering tests, and
 * the per-plan-item coverage rollup (join through the VAL).
 */

import { describe, expect, it } from 'vitest';
import {
  deriveAssertionStatus,
  computePlanItemTestStatus,
  type RollupTest,
  type RollupAssertion,
} from '../harness-test-rollup';

const T = (coversVALs: string[], status: string): RollupTest => ({ coversVALs, status });

describe('deriveAssertionStatus', () => {
  it('is todo when no test covers the VAL', () => {
    expect(deriveAssertionStatus('VAL-1', [T(['VAL-2'], 'passing')])).toBe('todo');
    expect(deriveAssertionStatus('VAL-1', [])).toBe('todo');
  });
  it('is passed when every covering test passes', () => {
    expect(deriveAssertionStatus('VAL-1', [T(['VAL-1'], 'passing'), T(['VAL-1', 'VAL-2'], 'passing')])).toBe('passed');
  });
  it('is failed when any covering test fails', () => {
    expect(deriveAssertionStatus('VAL-1', [T(['VAL-1'], 'passing'), T(['VAL-1'], 'failing')])).toBe('failed');
  });
  it('is validating when covered but a covering test is pending (not run)', () => {
    expect(deriveAssertionStatus('VAL-1', [T(['VAL-1'], 'not_run')])).toBe('validating');
    expect(deriveAssertionStatus('VAL-1', [T(['VAL-1'], 'passing'), T(['VAL-1'], 'skipped')])).toBe('validating');
  });
});

describe('computePlanItemTestStatus', () => {
  const assertions: RollupAssertion[] = [
    { val_id: 'VAL-1', item_id: 'P-001', requires_test: true },
    { val_id: 'VAL-2', item_id: 'P-001', requires_test: true },
    { val_id: 'VAL-3', item_id: 'P-001', requires_test: false }, // exempt (e.g. copy)
    { val_id: 'VAL-9', item_id: 'P-002', requires_test: true },
  ];

  it('rolls VALs up to their plan items with coverage + passing counts', () => {
    const tests: RollupTest[] = [
      T(['VAL-1'], 'passing'), // VAL-1 covered + passing
      T(['VAL-2'], 'failing'), // VAL-2 covered but failing
      // VAL-3 exempt; VAL-9 uncovered
      T([], 'passing'), // infra/Built-in test — no coversVALs, contributes nothing
    ];
    const r = computePlanItemTestStatus(assertions, tests);

    expect(r['P-001']).toEqual({
      itemId: 'P-001',
      valsTotal: 3, // VAL-1, VAL-2, VAL-3
      valsRequiringTest: 2, // VAL-1, VAL-2 (VAL-3 exempt)
      valsCovered: 2, // both required VALs have a covering test
      valsPassing: 1, // only VAL-1 passes
    });
    expect(r['P-002']).toEqual({
      itemId: 'P-002',
      valsTotal: 1,
      valsRequiringTest: 1,
      valsCovered: 0, // VAL-9 uncovered
      valsPassing: 0,
    });
  });

  it('an exempt VAL never drags coverage down', () => {
    // P-001 has one required (covered+passing) + one exempt, no test for exempt.
    const r = computePlanItemTestStatus(
      [
        { val_id: 'VAL-1', item_id: 'P-001', requires_test: true },
        { val_id: 'VAL-3', item_id: 'P-001', requires_test: false },
      ],
      [T(['VAL-1'], 'passing')],
    );
    expect(r['P-001'].valsRequiringTest).toBe(1);
    expect(r['P-001'].valsCovered).toBe(1);
    expect(r['P-001'].valsPassing).toBe(1); // fully covered despite the exempt VAL
  });
});
