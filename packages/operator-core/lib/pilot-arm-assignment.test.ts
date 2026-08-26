import { describe, it, expect } from 'vitest';

import {
  PILOT_ARMS,
  type PilotArm,
  type PilotCandidate,
  assignCohort,
  assignmentPayloadPatch,
  asPilotArm,
  blockPermutation,
  existingArm,
  verifyAssignments,
} from './pilot-arm-assignment.js';

/** n substantive candidates in one stratum, ids zero-padded so sort order is obvious. */
function cohort(n: number, stratum?: string): PilotCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `WI-${String(i + 1).padStart(3, '0')}`,
    tier: 'substantive' as const,
    ...(stratum ? { stratum } : {}),
  }));
}

const armOf = (plan: ReturnType<typeof assignCohort>, id: string): PilotArm | undefined =>
  plan.assignments.find((a) => a.id === id)?.arm;

describe('assignCohort — determinism and reproducibility', () => {
  it('is a pure function of (seed, candidate set)', () => {
    const a = assignCohort(cohort(9), 'seed-1');
    const b = assignCohort(cohort(9), 'seed-1');
    expect(b.assignments).toEqual(a.assignments);
  });

  it('ignores the caller argument ORDER — the anti-arm-shopping rail', () => {
    // Without id-sorting, re-running with a shuffled input would hand back different arms,
    // and "re-run until the split looks right" would be arm-shopping with extra steps.
    const forward = assignCohort(cohort(9), 'seed-1');
    const reversed = assignCohort([...cohort(9)].reverse(), 'seed-1');
    expect(reversed.assignments).toEqual(forward.assignments);
  });

  it('CHANGES when the seed changes — proves the seed is actually load-bearing', () => {
    // Calibration control. Without this, every determinism test above would still pass if
    // assignCohort ignored its seed entirely and returned a fixed pattern.
    const one = assignCohort(cohort(9), 'seed-1').assignments.map((a) => a.arm).join('');
    const other = assignCohort(cohort(9), 'seed-2').assignments.map((a) => a.arm).join('');
    expect(other).not.toEqual(one);
  });
});

describe('assignCohort — permuted-block balance', () => {
  it('splits a whole number of blocks exactly evenly', () => {
    const plan = assignCohort(cohort(9), 'seed-1');
    expect(plan.balance).toEqual({ A: 3, B: 3, C: 3 });
    expect(plan.partialBlockIds).toEqual([]);
  });

  it('stays balanced at EVERY block boundary, not just at the end', () => {
    // The property that makes an early-stopped pilot still analysable. A fair coin does not
    // have it: at this size it plausibly returns a 10/6/5 split.
    const plan = assignCohort(cohort(30), 'seed-x');
    for (let block = 1; block * 3 <= 30; block++) {
      const prefix = plan.assignments.slice(0, block * 3);
      const counts = { A: 0, B: 0, C: 0 } as Record<PilotArm, number>;
      for (const a of prefix) counts[a.arm] += 1;
      expect(counts).toEqual({ A: block, B: block, C: block });
    }
  });

  it('assigns a trailing partial block and FLAGS it rather than dropping the items', () => {
    const plan = assignCohort(cohort(8), 'seed-1');
    expect(plan.assignments).toHaveLength(8);
    // Items 7 and 8 form the trailing block of two.
    expect(plan.partialBlockIds).toEqual(['WI-007', 'WI-008']);
    const total = plan.balance.A + plan.balance.B + plan.balance.C;
    expect(total).toBe(8);
    // Off-by-at-most-one is the accepted cost of not discarding observations.
    const counts = Object.values(plan.balance);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it('balances WITHIN each stratum, not merely overall', () => {
    // Overall balance can hide a stratum that is entirely one arm — exactly the confound
    // stratification exists to prevent.
    const plan = assignCohort(
      [...cohort(3, 'db'), ...cohort(3, 'ui').map((c) => ({ ...c, id: `${c.id}-ui` }))],
      'seed-1',
    );
    for (const stratum of ['db', 'ui']) {
      const arms = plan.assignments.filter((a) => a.stratum === stratum).map((a) => a.arm);
      expect([...arms].sort()).toEqual(['A', 'B', 'C']);
    }
  });

  it('distributes each position across arms over many seeds', () => {
    // Control against a "randomiser" that always returns the same permutation: that would
    // pass every balance test above while assigning the first item to A every single time.
    const seen = new Set<PilotArm>();
    for (let s = 0; s < 40; s++) {
      const arm = armOf(assignCohort(cohort(3), `seed-${s}`), 'WI-001');
      if (arm) seen.add(arm);
    }
    expect([...seen].sort()).toEqual(['A', 'B', 'C']);
  });
});

describe('assignCohort — skips', () => {
  it('never reassigns an item that already carries an arm', () => {
    const candidates: PilotCandidate[] = [
      { id: 'WI-001', tier: 'substantive', payload: { pilotArm: 'C' } },
      ...cohort(3).slice(1),
    ];
    const plan = assignCohort(candidates, 'seed-1');
    expect(plan.assignments.some((a) => a.id === 'WI-001')).toBe(false);
    expect(plan.skipped).toContainEqual({
      id: 'WI-001',
      reason: 'already-assigned',
      existingArm: 'C',
    });
    // ...and it still counts toward the cohort balance.
    expect(plan.balance.C).toBeGreaterThanOrEqual(1);
  });

  it('treats an UNRECOGNISED pilotArm as assigned, not as unassigned', () => {
    // A typo must not read as "never assigned" and get silently re-randomised.
    const plan = assignCohort(
      [{ id: 'WI-001', tier: 'substantive', payload: { pilotArm: 'Z' } }],
      'seed-1',
    );
    expect(plan.assignments).toHaveLength(0);
    expect(plan.skipped[0]).toMatchObject({ reason: 'already-assigned', existingArm: 'Z' });
    // Unrecognised, so it cannot be credited to any arm.
    expect(plan.balance).toEqual({ A: 0, B: 0, C: 0 });
  });

  it('excludes trivial and high-risk tiers — D-007 already rules on those', () => {
    const plan = assignCohort(
      [
        { id: 'WI-001', tier: 'trivial' },
        { id: 'WI-002', tier: 'high-risk' },
        { id: 'WI-003', tier: 'substantive' },
      ],
      'seed-1',
    );
    expect(plan.assignments.map((a) => a.id)).toEqual(['WI-003']);
    expect(plan.skipped.map((s) => s.reason).sort()).toEqual([
      'not-substantive',
      'not-substantive',
    ]);
  });

  it('skips a duplicate id rather than assigning it twice', () => {
    const plan = assignCohort(
      [
        { id: 'WI-001', tier: 'substantive' },
        { id: 'WI-001', tier: 'substantive' },
      ],
      'seed-1',
    );
    expect(plan.assignments).toHaveLength(1);
    expect(plan.skipped).toContainEqual({ id: 'WI-001', reason: 'duplicate-id' });
  });
});

describe('existingArm / asPilotArm', () => {
  it('reads a stamped arm and ignores absent or malformed payloads', () => {
    expect(existingArm({ payload: { pilotArm: 'B' } })).toBe('B');
    expect(existingArm({ payload: { pilotArm: '  ' } })).toBeUndefined();
    expect(existingArm({ payload: {} })).toBeUndefined();
    expect(existingArm({ payload: null })).toBeUndefined();
    expect(existingArm(null)).toBeUndefined();
    expect(existingArm({ payload: { pilotArm: 3 } })).toBeUndefined();
  });

  it('normalises case but rejects non-arms', () => {
    expect(asPilotArm('c')).toBe('C');
    expect(asPilotArm(' b ')).toBe('B');
    expect(asPilotArm('Z')).toBeUndefined();
    expect(asPilotArm(undefined)).toBeUndefined();
  });
});

describe('blockPermutation', () => {
  it('returns each arm exactly once', () => {
    for (let i = 0; i < 25; i++) {
      expect([...blockPermutation('seed', 'default', i)].sort()).toEqual(['A', 'B', 'C']);
    }
  });

  it('cannot collide across a separator in the seed key', () => {
    // seed:"a|b" + stratum:"c" must not hash to the same block as seed:"a" + stratum:"b|c".
    // A naive string join would make these identical.
    expect(blockPermutation('a|b', 'c', 0)).not.toEqual(blockPermutation('a', 'b|c', 0));
  });
});

describe('verifyAssignments — catches a record edited after the fact', () => {
  it('passes when every stamped arm matches the re-derived plan', () => {
    const plan = assignCohort(cohort(9), 'seed-1');
    const stamped = cohort(9).map((c) => ({
      ...c,
      payload: { pilotArm: armOf(plan, c.id) },
    }));
    const result = verifyAssignments(stamped, 'seed-1');
    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);
  });

  it('FAILS on a hand-edited arm — the failure mode nothing else can see', () => {
    const plan = assignCohort(cohort(9), 'seed-1');
    const real = armOf(plan, 'WI-001')!;
    const tampered = PILOT_ARMS.find((a) => a !== real)!;
    const stamped = cohort(9).map((c) => ({
      ...c,
      payload: { pilotArm: c.id === 'WI-001' ? tampered : armOf(plan, c.id) },
    }));
    const result = verifyAssignments(stamped, 'seed-1');
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([
      { id: 'WI-001', recorded: tampered, expected: real },
    ]);
  });

  it('reports an item assigned in another round as unverifiable, not as a mismatch', () => {
    // A stamped item that is not derivable from THIS cohort+seed is unknown, not wrong.
    const result = verifyAssignments(
      [{ id: 'WI-999', tier: 'trivial', payload: { pilotArm: 'A' } }],
      'seed-1',
    );
    expect(result.mismatches).toEqual([]);
    expect(result.unverifiable).toEqual(['WI-999']);
    expect(result.ok).toBe(true);
  });
});

describe('assignmentPayloadPatch', () => {
  it('records the seed and block so the assignment stays auditable', () => {
    const plan = assignCohort(cohort(9), 'seed-1');
    const patch = assignmentPayloadPatch(plan.assignments[0], 'seed-1');
    expect(patch).toEqual({
      pilotArm: plan.assignments[0].arm,
      pilotSeed: 'seed-1',
      pilotStratum: 'default',
      pilotBlockIndex: 0,
    });
  });
});
