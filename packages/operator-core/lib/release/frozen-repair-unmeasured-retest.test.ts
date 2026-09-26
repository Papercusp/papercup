import { describe, expect, it } from 'vitest';
import {
  createFrozenCandidateRepairQueue,
  decideFrozenCandidateRepairQueue,
  frozenRepairUnmeasuredRetestEligible,
  markFrozenRepairUnmeasuredRetest,
  parseFrozenCandidateRepairQueue,
  type FrozenCandidateRepairQueue,
} from './frozen-candidate-repair-queue';

/**
 * WI-10003213 — an UNMEASURED red (legs killed/timed out, no test reported a failure) used to
 * park the frozen repair queue in awaiting-fixer forever: the policy decided `dispatch-fixer`,
 * the dispatcher refused ("nothing to reproduce"), and no suite ever ran. These pin the
 * once-per-head re-verification that replaces that deadlock.
 */
const C = '1111111111111111111111111111111111111111';
const HEAD = '2222222222222222222222222222222222222222';
const NEXT_HEAD = '3333333333333333333333333333333333333333';
const BASE = '0000000000000000000000000000000000000000';
const T0 = 1_800_000_000_000;

function awaitingFixerNoFixer(): FrozenCandidateRepairQueue {
  return {
    ...createFrozenCandidateRepairQueue({
      candidate: C,
      base: BASE,
      failingTests: ['@papercusp/operator-core :: test:lane-stateful'],
      nowMs: T0,
    }),
    phase: 'awaiting-fixer',
    repairHead: HEAD,
    fixerSpawnId: null,
  };
}

const roundTrip = (q: FrozenCandidateRepairQueue) =>
  parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(q)));

describe('frozen repair unmeasured-red retest (WI-10003213)', () => {
  it('reproduces the deadlock shape: an unassigned awaiting-fixer queue only ever decides dispatch-fixer', () => {
    const decision = decideFrozenCandidateRepairQueue(awaitingFixerNoFixer(), { nowMs: T0 + 1 });
    expect(decision.kind).toBe('dispatch-fixer');
    expect(decision.runSuite).toBe(false);
  });

  it('moves the queue to ready-to-verify of the SAME head, so the next decision runs the suite', () => {
    const q = awaitingFixerNoFixer();
    expect(frozenRepairUnmeasuredRetestEligible(q)).toBe(true);
    const retest = markFrozenRepairUnmeasuredRetest(q, { nowMs: T0 + 5 });
    expect(retest.phase).toBe('ready-to-verify');
    expect(retest.repairHead).toBe(HEAD);
    expect(retest.unmeasuredRetestHead).toBe(HEAD);
    expect(retest.retestRequested).toEqual({ candidate: C, repairHead: HEAD, requestedAtMs: T0 + 5 });
    expect(retest.attempts).toBe(q.attempts);
    const decision = decideFrozenCandidateRepairQueue(retest, { nowMs: T0 + 6 });
    expect(decision.kind).toBe('verify-repair');
    expect(decision.runSuite).toBe(true);
    expect(decision.recordVerdict).toBe(true);
  });

  it('survives the persisted-row parser even with no fixer and no admission (the third route into verify)', () => {
    const retest = markFrozenRepairUnmeasuredRetest(awaitingFixerNoFixer(), { nowMs: T0 + 5 });
    expect(retest.admissions ?? []).toHaveLength(0);
    const parsed = roundTrip(retest);
    expect(parsed).not.toBeNull();
    expect(parsed?.phase).toBe('ready-to-verify');
    expect(parsed?.unmeasuredRetestHead).toBe(HEAD);
  });

  it('still rejects a no-fixer, no-admission verify row whose marker names a DIFFERENT head', () => {
    const forged: FrozenCandidateRepairQueue = {
      ...markFrozenRepairUnmeasuredRetest(awaitingFixerNoFixer(), { nowMs: T0 + 5 }),
      repairHead: NEXT_HEAD,
    };
    expect(roundTrip(forged)).toBeNull();
  });

  it('is bounded to ONE retest per head: a second unmeasured red at the same head is not eligible', () => {
    const spent: FrozenCandidateRepairQueue = {
      ...markFrozenRepairUnmeasuredRetest(awaitingFixerNoFixer(), { nowMs: T0 + 5 }),
      phase: 'awaiting-fixer',
    };
    expect(frozenRepairUnmeasuredRetestEligible(spent)).toBe(false);
    expect(markFrozenRepairUnmeasuredRetest(spent, { nowMs: T0 + 9 })).toBe(spent);
    // A NEW head (e.g. after an admission) earns its own retest.
    expect(frozenRepairUnmeasuredRetestEligible({ ...spent, repairHead: NEXT_HEAD })).toBe(true);
  });

  it('never fires while a fixer or a dispatch lease owns the queue, or outside awaiting-fixer', () => {
    const q = awaitingFixerNoFixer();
    expect(frozenRepairUnmeasuredRetestEligible({ ...q, fixerSpawnId: 'spawn-live' })).toBe(false);
    expect(
      frozenRepairUnmeasuredRetestEligible({
        ...q,
        dispatchReservation: { token: 't', claimedAtMs: T0, expiresAtMs: T0 + 60_000 },
      }),
    ).toBe(false);
    expect(frozenRepairUnmeasuredRetestEligible({ ...q, phase: 'ready-to-verify' })).toBe(false);
    expect(frozenRepairUnmeasuredRetestEligible(null)).toBe(false);
    const withFixer = { ...q, fixerSpawnId: 'spawn-live' };
    expect(markFrozenRepairUnmeasuredRetest(withFixer, { nowMs: T0 + 5 })).toBe(withFixer);
  });
});
