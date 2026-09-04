import { describe, expect, it } from 'vitest';
import {
  FROZEN_REPAIR_LEG_CAP,
  applyRepairLegMeasurements,
  parseRepairLegStates,
  partitionRepairSignatures,
  summarizeRepairLegs,
  type FrozenRepairLegState,
  type RepairLegMeasurement,
} from './repair-leg-lifecycle';
import {
  createFrozenCandidateRepairQueue,
  parseFrozenCandidateRepairQueue,
  recordFrozenRepairLegMeasurement,
  summarizeFrozenRepairLegs,
  type FrozenCandidateRepairQueue,
} from './frozen-candidate-repair-queue';

const HEAD_A = 'aaaaaaaaaaaa';
const HEAD_B = 'bbbbbbbbbbbb';
const T0 = 1_800_000_000_000;

function measure(id: string, status: RepairLegMeasurement['status']): RepairLegMeasurement {
  return { id, status };
}

/** One leg admitted failing at round 1, head A. */
function admitted(): FrozenRepairLegState[] {
  return applyRepairLegMeasurements([], {
    measurements: [measure('lint:tsc', 'fail')],
    head: HEAD_A,
    round: 1,
    nowMs: T0,
  });
}

describe('P-002 / D-005 — a non-test leg has the lifecycle a test file has', () => {
  /**
   * PERMANENT deliberately-wrong control #1 (CLAUDE.md: prove falsifiability without mutating
   * the shared tree). This is the fold an implementer writes when they treat the measurement
   * as the whole truth: whatever the latest tick reported IS the failing set. It reads clean
   * and it silently converts "this tick did not measure the leg" into "the leg is fixed" —
   * the exact false all-clear this plan exists to end.
   */
  function naiveApply(_existing: readonly FrozenRepairLegState[], measurements: readonly RepairLegMeasurement[]) {
    return measurements.filter((m) => m.status !== 'pass').map((m) => m.id);
  }

  /**
   * PERMANENT deliberately-wrong control #2: shrink decided by PATH correlation, which is
   * what `detectFrozenRepairSharedTreeCollision` does at :1235 and why a leg can never
   * shrink. A fixer repairing `lint:design-primitives` edits a CSS file, so the leg id never
   * intersects the edited set and the leg is reported as making no progress forever.
   */
  function pathCorrelatedShrink(legIds: readonly string[], editedPaths: readonly string[]): string[] {
    const edited = new Set(editedPaths);
    return legIds.filter((id) => !edited.has(id));
  }

  it('CALIBRATION: a measured failure admits the leg, named, with its own vintage', () => {
    // If this fails, every control below is rejecting the honest fold for the wrong reason.
    const legs = admitted();
    expect(legs).toHaveLength(1);
    expect(legs[0]!.id).toBe('lint:tsc');
    expect(legs[0]!.state).toBe('failing');
    expect(legs[0]!.admittedRound).toBe(1);
    expect(legs[0]!.admittedHead).toBe(HEAD_A);
    expect(legs[0]!.failingRounds).toBe(1);
  });

  it("LOAD-BEARING: a leg the tick did NOT measure stays failing — the naive fold calls it fixed", () => {
    // Round 2 measures a DIFFERENT leg. lint:tsc was not looked at, so nothing is known
    // about it, so it must not move.
    const next = applyRepairLegMeasurements(admitted(), {
      measurements: [measure('lint:plane-ratchet', 'fail')],
      head: HEAD_B,
      round: 2,
      nowMs: T0 + 1_000,
    });
    const tsc = next.find((leg) => leg.id === 'lint:tsc')!;
    expect(tsc.state).toBe('failing');
    // ...and its measurement stamp still points at the round that actually measured it.
    expect(tsc.lastMeasuredRound).toBe(1);
    expect(tsc.lastMeasuredHead).toBe(HEAD_A);
    expect(summarizeRepairLegs(next).failingLegIds).toEqual(['lint:plane-ratchet', 'lint:tsc']);

    // The control drops it entirely: an unmeasured leg silently leaves the failing set.
    expect(naiveApply(admitted(), [measure('lint:plane-ratchet', 'fail')])).toEqual(['lint:plane-ratchet']);
    expect(naiveApply(admitted(), [measure('lint:plane-ratchet', 'fail')])).not.toContain('lint:tsc');
  });

  it("LOAD-BEARING: only the leg's OWN re-run resolves it — a path edit never does", () => {
    const fixed = applyRepairLegMeasurements(admitted(), {
      measurements: [measure('lint:tsc', 'pass')],
      head: HEAD_B,
      round: 2,
      nowMs: T0 + 1_000,
    });
    expect(fixed[0]!.state).toBe('fixed');
    expect(fixed[0]!.resolvedHead).toBe(HEAD_B);
    expect(summarizeRepairLegs(fixed).shrinkTotal).toBe(1);
    expect(summarizeRepairLegs(fixed).failingLegIds).toEqual([]);

    // The control: the fixer really did repair the leg, and really did edit the file that
    // fixes it, and path correlation still reports no progress — because a leg id is not a
    // path and never will be.
    expect(pathCorrelatedShrink(['lint:tsc'], ['packages/operator-core/tsconfig.json'])).toEqual(['lint:tsc']);
  });

  it('LOAD-BEARING: "nothing measured" is a different answer from "nothing failing"', () => {
    const empty = summarizeRepairLegs([]);
    expect(empty.measured).toBe(false);
    expect(empty.failingLegs).toBe(0);
    // A zero shrink over an unmeasured cycle is a claim that it is not shrinking.
    expect(empty.shrinkTotal).toBeNull();
    expect(summarizeRepairLegs(undefined).measured).toBe(false);

    const real = summarizeRepairLegs(admitted());
    expect(real.measured).toBe(true);
    expect(real.failingLegs).toBe(1);
    expect(real.shrinkTotal).toBe(0);
  });

  it('a re-break KEEPS the original admission round and is counted as a regression', () => {
    const fixed = applyRepairLegMeasurements(admitted(), {
      measurements: [measure('lint:tsc', 'pass')],
      head: HEAD_B,
      round: 2,
      nowMs: T0 + 1_000,
    });
    const broke = applyRepairLegMeasurements(fixed, {
      measurements: [measure('lint:tsc', 'fail')],
      head: HEAD_B,
      round: 3,
      nowMs: T0 + 2_000,
    });
    expect(broke[0]!.state).toBe('failing');
    // The baseline every shrink figure is measured against must survive a regression.
    expect(broke[0]!.admittedRound).toBe(1);
    expect(broke[0]!.regressions).toBe(1);
    expect(broke[0]!.resolvedHead).toBeUndefined();
    expect(summarizeRepairLegs(broke).regressedLegs).toBe(1);
  });

  it('an `errored` leg is FAILING — an apparatus failure is never a pass', () => {
    const legs = applyRepairLegMeasurements([], {
      measurements: [measure('lint:perf', 'errored')],
      head: HEAD_A,
      round: 1,
      nowMs: T0,
    });
    expect(legs[0]!.state).toBe('failing');
  });

  it('a passing leg with no prior state is NOT admitted — the cap belongs to legs that failed', () => {
    const legs = applyRepairLegMeasurements([], {
      measurements: [measure('lint:tsc', 'pass'), measure('lint:perf', 'pass')],
      head: HEAD_A,
      round: 1,
      nowMs: T0,
    });
    expect(legs).toEqual([]);
    expect(summarizeRepairLegs(legs).measured).toBe(false);
  });

  it('failingRounds counts ROUNDS, not measurements — two ticks in one round is one round', () => {
    const once = admitted();
    const twiceSameRound = applyRepairLegMeasurements(once, {
      measurements: [measure('lint:tsc', 'fail')],
      head: HEAD_A,
      round: 1,
      nowMs: T0 + 500,
    });
    expect(twiceSameRound[0]!.failingRounds).toBe(1);
    const nextRound = applyRepairLegMeasurements(twiceSameRound, {
      measurements: [measure('lint:tsc', 'fail')],
      head: HEAD_B,
      round: 2,
      nowMs: T0 + 1_000,
    });
    expect(nextRound[0]!.failingRounds).toBe(2);
  });

  it('the cap retains the EARLIEST-admitted legs, never a tail slice', () => {
    let legs: FrozenRepairLegState[] = [];
    for (let round = 1; round <= FROZEN_REPAIR_LEG_CAP + 5; round += 1) {
      legs = applyRepairLegMeasurements(legs, {
        measurements: [measure(`lint:leg-${String(round).padStart(3, '0')}`, 'fail')],
        head: HEAD_A,
        round,
        nowMs: T0 + round,
      });
    }
    expect(legs).toHaveLength(FROZEN_REPAIR_LEG_CAP);
    // The baseline survives; the newest admissions are what the cap sheds.
    expect(legs[0]!.id).toBe('lint:leg-001');
    expect(legs.some((leg) => leg.id === `lint:leg-${String(FROZEN_REPAIR_LEG_CAP + 5).padStart(3, '0')}`)).toBe(false);
  });
});

describe('P-002 — parsing persisted legs', () => {
  it('round-trips through JSON', () => {
    const legs = admitted();
    expect(parseRepairLegStates(JSON.parse(JSON.stringify(legs)))).toEqual(legs);
  });

  it('drops a MALFORMED ENTRY, never the whole array — a live queue outranks a display row', () => {
    const good = JSON.parse(JSON.stringify(admitted())) as Record<string, unknown>[];
    const parsed = parseRepairLegStates([...good, { id: 'lint:bad', state: 'maybe' }, null, 'lint:tsc']);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.id).toBe('lint:tsc');
  });

  it('a non-array reads as no legs recorded', () => {
    expect(parseRepairLegStates(undefined)).toEqual([]);
    expect(parseRepairLegStates(null)).toEqual([]);
    expect(parseRepairLegStates('lint:tsc')).toEqual([]);
  });
});

describe('P-002 — partitioning the flat failing list', () => {
  it('LOAD-BEARING: a MEASURED leg id is authoritative, and shape never promotes to a leg', () => {
    const partition = partitionRepairSignatures(
      ['lib/a.test.ts', 'lint:tsc', 'some-unmeasured-signature', 'packages/x/y.ts'],
      ['lint:tsc'],
    );
    expect(partition.legIds).toEqual(['lint:tsc']);
    expect(partition.testPaths).toEqual(['lib/a.test.ts', 'packages/x/y.ts']);
    // NOT guessed into either population. Naming the ignorance is what stops the guess that
    // re-creates this item's bug.
    expect(partition.unclassified).toEqual(['some-unmeasured-signature']);
  });

  it('with NO measurement to go on, a leg-shaped signature is unclassified, not a test path', () => {
    // The live 2026-09-03 queue held exactly this: failingTests ["lint:tsc"], no leg
    // measurement yet. Counting it as a test path is how the conflation started.
    const partition = partitionRepairSignatures(['lint:tsc'], []);
    expect(partition.testPaths).toEqual([]);
    expect(partition.legIds).toEqual([]);
    expect(partition.unclassified).toEqual(['lint:tsc']);
  });

  it('is stable and de-duplicated', () => {
    const partition = partitionRepairSignatures(['lib/a.test.ts', 'lib/a.test.ts', '  '], []);
    expect(partition.testPaths).toEqual(['lib/a.test.ts']);
  });
});

describe('P-002 — legs on the queue itself', () => {
  function queue(): FrozenCandidateRepairQueue {
    return createFrozenCandidateRepairQueue({
      candidate: '1111111111111111111111111111111111111111',
      base: '0000000000000000000000000000000000000000',
      failingTests: ['lint:tsc'],
      nowMs: T0,
    });
  }

  it('records a measurement and survives a persist/parse round-trip', () => {
    const withLegs = recordFrozenRepairLegMeasurement(queue(), {
      measurements: [measure('lint:tsc', 'fail')],
      head: HEAD_A,
      nowMs: T0 + 1_000,
    });
    expect(withLegs.legs).toHaveLength(1);
    const reparsed = parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(withLegs)));
    expect(reparsed).not.toBeNull();
    expect(reparsed!.legs).toEqual(withLegs.legs);
    expect(summarizeFrozenRepairLegs(reparsed).failingLegIds).toEqual(['lint:tsc']);
  });

  it('LOAD-BEARING: a LEGACY queue with no legs still parses, and reads as unmeasured', () => {
    // Additive-optional is the whole contract. If legs ever became required, every
    // pre-existing row would fail to parse and the queue — the gate's safety state — would
    // be discarded over a display field.
    const legacy = JSON.parse(JSON.stringify(queue())) as Record<string, unknown>;
    expect(legacy.legs).toBeUndefined();
    const parsed = parseFrozenCandidateRepairQueue(legacy);
    expect(parsed).not.toBeNull();
    expect(parsed!.legs).toBeUndefined();
    const summary = summarizeFrozenRepairLegs(parsed);
    expect(summary.measured).toBe(false);
    expect(summary.shrinkTotal).toBeNull();
  });

  it('a measurement naming no failing leg leaves the queue untouched', () => {
    const before = queue();
    expect(recordFrozenRepairLegMeasurement(before, { measurements: [], head: HEAD_A, nowMs: T0 + 1 })).toBe(before);
  });

  it('leg rounds are the SAME rounds as convergence rounds, not a second clock', () => {
    const withRounds: FrozenCandidateRepairQueue = {
      ...queue(),
      convergenceRounds: [
        { round: 1, head: HEAD_A, failingCount: 2, atMs: T0 },
        { round: 2, head: HEAD_B, failingCount: 1, atMs: T0 + 1_000 },
      ],
    };
    const recorded = recordFrozenRepairLegMeasurement(withRounds, {
      measurements: [measure('lint:tsc', 'fail')],
      head: HEAD_B,
      nowMs: T0 + 1_500,
    });
    expect(recorded.legs![0]!.admittedRound).toBe(2);
  });

  it('summarizeFrozenRepairLegs(null) is unmeasured, never a clean zero', () => {
    const summary = summarizeFrozenRepairLegs(null);
    expect(summary.measured).toBe(false);
    expect(summary.shrinkTotal).toBeNull();
    expect(summary.scope).toContain('unmeasured is not passing');
  });
});
