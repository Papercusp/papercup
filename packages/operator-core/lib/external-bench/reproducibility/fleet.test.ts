/**
 * fleetRunIdFor — the deterministic L2 fleet-run id = sha256(runId ∥ suite ∥
 * backlogId ∥ arm ∥ seed). Determinism makes re-emit idempotent (UPSERT key);
 * field-sensitivity keeps distinct runs (esp. hive vs queen-ablated arm) apart.
 * Pure — the rest of fleet.ts is DB I/O. Added in the test-coverage audit.
 */
import { describe, it, expect } from 'vitest';
import { fleetRunIdFor } from './fleet';

describe('fleetRunIdFor — deterministic fleet-run id', () => {
  const base = () => fleetRunIdFor('run1', 'suiteA', 'backlogX', 'hive', 0);

  it('is a 64-char lowercase hex sha256', () => {
    expect(base()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — identical inputs yield the same id (idempotent re-emit)', () => {
    expect(fleetRunIdFor('run1', 'suiteA', 'backlogX', 'hive', 0)).toBe(
      fleetRunIdFor('run1', 'suiteA', 'backlogX', 'hive', 0),
    );
  });

  it('changes when ANY single field changes', () => {
    const b = base();
    expect(fleetRunIdFor('run2', 'suiteA', 'backlogX', 'hive', 0)).not.toBe(b); // runId
    expect(fleetRunIdFor('run1', 'suiteB', 'backlogX', 'hive', 0)).not.toBe(b); // suite
    expect(fleetRunIdFor('run1', 'suiteA', 'backlogY', 'hive', 0)).not.toBe(b); // backlogId
    expect(fleetRunIdFor('run1', 'suiteA', 'backlogX', 'queen-ablated', 0)).not.toBe(b); // arm
    expect(fleetRunIdFor('run1', 'suiteA', 'backlogX', 'hive', 1)).not.toBe(b); // seed
  });

  it('separates the hive vs queen-ablated arm (the delta the Queen-value metric reads)', () => {
    expect(fleetRunIdFor('r', 's', 'b', 'hive', 0)).not.toBe(
      fleetRunIdFor('r', 's', 'b', 'queen-ablated', 0),
    );
  });

  it('distinct space-free field splits do not collide (the join delimiter is unambiguous here)', () => {
    // "a b c d 0" cannot be reproduced by a different assignment of space-free fields.
    expect(fleetRunIdFor('a', 'b', 'c', 'd', 0)).not.toBe(
      fleetRunIdFor('ab', 'b', 'c', 'd', 0),
    );
  });
});
