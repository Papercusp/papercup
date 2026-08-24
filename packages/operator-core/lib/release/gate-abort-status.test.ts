import { describe, expect, it } from 'vitest';
import {
  RECORDED_INCONCLUSIVE_STATUSES,
  classifyGateAbort,
  gateAbortLever,
  gateAbortRefireClause,
  isRecordedInconclusiveStatus,
  type RecordedInconclusiveStatus,
} from './gate-abort-status';

/**
 * EI-21290961259437085.
 *
 * The defect these guard: `'cancelled'` reached the generic "clear the gate's abort
 * condition ... re-firing aborts the same way" lever, and BOTH clauses are false for it
 * — an external SIGTERM records a kill, it does not latch a condition. It sat live on
 * papercusp's gate telling every reader to wait on nothing.
 *
 * The invariant that was actually violated is NOT "aborts never block a re-fire" (that
 * would be wrong — see the standing-condition tests below, which exist to stop the
 * over-correction). It is: **every status a reader can be advised about has a routing
 * someone explicitly decided.** `'cancelled'` was never classified; it inherited advice
 * written for a different kind of abort. So the guard enumerates the single source and
 * fails on any member that is merely defaulting.
 */

/** The false clauses, verbatim from the pre-fix generic arm. */
const LATCH_CLAIM = 're-firing aborts the same way';
const CLEAR_CLAIM = "clear the gate's abort condition";

describe('gate abort classification — every recorded status is explicitly routed', () => {
  it('classifies every RECORDED_INCONCLUSIVE_STATUS (a new status must be classified, not defaulted)', () => {
    const unclassified = RECORDED_INCONCLUSIVE_STATUSES.filter((s) => classifyGateAbort(s) === 'unknown');
    expect(
      unclassified,
      `These statuses are recorded as gate_health.inconclusive but have no entry in KIND_BY_STATUS, so a ` +
        `reader gets the standing-condition wording by DEFAULT rather than by decision — the exact shape of ` +
        `EI-21290961259437085. Classify each in gate-abort-status.ts.`,
    ).toEqual([]);
  });

  it('agrees with the recorded-set membership test', () => {
    for (const status of RECORDED_INCONCLUSIVE_STATUSES) {
      expect(isRecordedInconclusiveStatus(status)).toBe(true);
    }
  });

  it('CALIBRATION: that guard actually fails when a status is left unclassified', () => {
    // Falsifiability, proven in-file rather than by mutating the shared tree (a copy-out
    // probe would race git-sync's sweep for as long as the suite runs). This replays the
    // guard's own filter over the recorded set PLUS one deliberately-unclassified status:
    // if the filter cannot catch that, the guard above is decorative and would have sat
    // green through the very defect it is here to prevent.
    const withUnclassified = [...RECORDED_INCONCLUSIVE_STATUSES, 'a-status-nobody-classified'];
    const unclassified = withUnclassified.filter((s) => classifyGateAbort(s) === 'unknown');
    expect(unclassified).toEqual(['a-status-nobody-classified']);
  });
});

describe('transient aborts — the reported defect', () => {
  const transient = RECORDED_INCONCLUSIVE_STATUSES.filter((s) => classifyGateAbort(s) === 'transient');

  it('covers cancelled, and cancelled is transient (the live 2026-08-24 case)', () => {
    // Pinned by name: this is the status the bug was filed for. If a later change
    // reclassifies it, that should be a deliberate edit to this assertion.
    expect(classifyGateAbort('cancelled')).toBe('transient');
    expect(transient).toContain('cancelled');
  });

  it('never tells the reader a re-fire aborts identically', () => {
    for (const status of transient) {
      expect(gateAbortRefireClause(status), `refire clause for ${status}`).not.toContain(LATCH_CLAIM);
      expect(gateAbortLever(status), `lever for ${status}`).not.toContain(LATCH_CLAIM);
    }
  });

  it('never tells the reader to clear a condition that does not exist', () => {
    for (const status of transient) {
      expect(gateAbortLever(status), `lever for ${status}`).not.toContain(CLEAR_CLAIM);
    }
  });

  it('warns off triaging the previous red, which is what a reader would otherwise chase', () => {
    for (const status of transient) {
      expect(gateAbortLever(status).toLowerCase()).toContain('do not triage');
    }
  });
});

describe('standing conditions — the over-correction guard', () => {
  const standing = RECORDED_INCONCLUSIVE_STATUSES.filter(
    (s) => classifyGateAbort(s) === 'standing-condition',
  );

  it('has at least one member, so the tests below are not vacuous', () => {
    expect(standing.length).toBeGreaterThan(0);
  });

  it('KEEPS the generic wording — a real blocker does re-abort, and saying otherwise burns a ~55min suite', () => {
    for (const status of standing) {
      expect(gateAbortLever(status), `lever for ${status}`).toContain(CLEAR_CLAIM);
      expect(gateAbortRefireClause(status), `refire clause for ${status}`).toContain(
        'abort the same way',
      );
    }
  });
});

describe('peer-owned aborts', () => {
  const peerOwned = RECORDED_INCONCLUSIVE_STATUSES.filter((s) => classifyGateAbort(s) === 'peer-owned');

  it('routes to waiting on the owner rather than to clearing or re-firing', () => {
    expect(peerOwned.length).toBeGreaterThan(0);
    for (const status of peerOwned) {
      expect(gateAbortLever(status), `lever for ${status}`).not.toContain(CLEAR_CLAIM);
      expect(gateAbortLever(status).toLowerCase()).toContain('wait');
    }
  });
});

describe('unknown statuses fall back conservatively', () => {
  // The control that makes the suite falsifiable in the other direction: an
  // unclassified status must inherit the CAUTIOUS wording, never the transient
  // "nothing is blocking a re-fire" — we do not know that, and guessing it wrong
  // costs a full suite.
  const madeUp = 'some-status-invented-by-a-future-change' as unknown as RecordedInconclusiveStatus;

  it('is not a recorded status', () => {
    expect(isRecordedInconclusiveStatus(madeUp)).toBe(false);
    expect(classifyGateAbort(madeUp)).toBe('unknown');
  });

  it('does not claim a re-fire is safe', () => {
    expect(gateAbortLever(madeUp)).toContain(CLEAR_CLAIM);
    expect(gateAbortRefireClause(madeUp)).not.toContain('nothing about it blocks a re-fire');
  });
});
