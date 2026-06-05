/**
 * Coverage for harness-test-rollup — the pure VAL↔test join. deriveAssertionStatus
 * (todo/failed/passed/validating from covering tests) and computePlanItemTestStatus
 * (rolls assertions up to plan items, counting only requires_test VALs toward
 * coverage). No I/O.
 */
import { describe, expect, it } from 'vitest';
import { deriveAssertionStatus, computePlanItemTestStatus } from './harness-test-rollup';

const t = (coversVALs: string[], status: string) => ({ coversVALs, status });

describe('deriveAssertionStatus', () => {
  it("→ 'todo' when no test covers the VAL", () => {
    expect(deriveAssertionStatus('V-1', [])).toBe('todo');
    expect(deriveAssertionStatus('V-1', [t(['V-2'], 'passing')])).toBe('todo');
  });
  it("→ 'failed' when any covering test is failing", () => {
    expect(deriveAssertionStatus('V-1', [t(['V-1'], 'passing'), t(['V-1'], 'failing')])).toBe('failed');
  });
  it("→ 'passed' when every covering test passes", () => {
    expect(deriveAssertionStatus('V-1', [t(['V-1'], 'passing'), t(['V-1'], 'passing')])).toBe('passed');
  });
  it("→ 'validating' when covered but some test is pending", () => {
    expect(deriveAssertionStatus('V-1', [t(['V-1'], 'passing'), t(['V-1'], 'not_run')])).toBe('validating');
  });
});

describe('computePlanItemTestStatus', () => {
  it('rolls assertions up to items, counting only requires_test VALs', () => {
    const out = computePlanItemTestStatus(
      [
        { val_id: 'V-1', item_id: 'P-1', requires_test: true },
        { val_id: 'V-2', item_id: 'P-1', requires_test: false }, // exempt
        { val_id: 'V-3', item_id: 'P-1', requires_test: true }, // requiring, uncovered
      ],
      [t(['V-1'], 'passing')],
    );
    expect(out['P-1']).toEqual({
      itemId: 'P-1',
      valsTotal: 3, // all assertions
      valsRequiringTest: 2, // V-1 + V-3
      valsCovered: 1, // only V-1 has a covering test
      valsPassing: 1, // V-1 passes
    });
  });

  it('groups by item_id', () => {
    const out = computePlanItemTestStatus(
      [
        { val_id: 'V-1', item_id: 'P-1', requires_test: true },
        { val_id: 'V-2', item_id: 'P-2', requires_test: true },
      ],
      [t(['V-1'], 'failing'), t(['V-2'], 'passing')],
    );
    expect(Object.keys(out).sort()).toEqual(['P-1', 'P-2']);
    expect(out['P-1'].valsPassing).toBe(0); // V-1 fails
    expect(out['P-2'].valsPassing).toBe(1);
  });
});
