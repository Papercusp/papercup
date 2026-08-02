/**
 * plane-adoption-probe.test.ts — the P-024 / D-047 runtime-ADOPTION judges
 * (unified-agent-state-plane-2026-07-27, built under WI-6768).
 *
 * WHAT IS ACTUALLY BEING PROTECTED HERE — the same posture as its sibling
 * `plane-producer-census.test.ts`, for a different question.
 *
 * The producer census asks "is anything WRITING this field". This probe asks the
 * question that census cannot: **is anything USING this surface**. A shipped,
 * correct, fully-producing agent surface that no agent ever calls passes every other
 * check in this plane — the ratchet, the census, the type checker, its own unit tests
 * — while being, functionally, absent. That is the failure mode this plane keeps
 * producing (WI-6763's audit: "all gaps are ADOPTION, not construction"), and this
 * probe is the only gate that can see it.
 *
 * A green run proves only the no-false-alarm direction. The directions that matter
 * are the ones a healthy tree can never exercise, and each is a plausible future
 * "simplification" that would silently gut the gate:
 *
 *   1. `unused` collapsed into `below-floor`. Zero is not a small number: a surface
 *      with SOME traffic is a calibration question (is the floor right?), a surface
 *      with NONE has never been reached by anybody. Different defect, different
 *      remedy — and the second is the one that keeps recurring here.
 *   2. `no-data` collapsed into either a pass or a fail. A window with no traffic at
 *      all says NOTHING about adoption; scoring it green is a tick that means "we
 *      looked at nothing", scoring it red trains the fleet to ignore the gate.
 *   3. The review-date gate dropped, so a below-floor row fails IMMEDIATELY. That
 *      would red-pin `main` for a condition no commit caused — the probe would be
 *      reverted within a day and the plane would lose its only adoption signal.
 *   4. A `ruling` row made failable. D-047 records floors that were ACCEPTED at zero
 *      by ruling; re-failing them relitigates a settled decision as a build error.
 *
 * Each is locked below, because the tree cannot lock them.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS gate script, no .d.ts; imported for its predicates only. Kept on ONE line: @ts-ignore suppresses only the line that follows it, so a multi-line import leaves the module specifier unguarded and TS7016 reds the build.
import { judgeAdoption, isPastReview, rollupAdoption, ADOPTION_VERDICTS, PLANE_ADOPTION_SURFACES } from '../../../scripts/check-plane-adoption.mjs';

const FLOORS = { floorCalls: 10, floorCallers: 3 };

describe('judgeAdoption — the four-verdict split', () => {
  it('meeting BOTH floors is ADOPTED', () => {
    expect(judgeAdoption({ calls: 150, distinctCallers: 5, ...FLOORS })).toBe('adopted');
  });

  it('exactly ON both floors is ADOPTED — the floor is a floor, not a threshold to exceed', () => {
    // Off-by-one here would silently fail every surface sitting exactly at its
    // declared floor, which is the value D-047 actually wrote down.
    expect(judgeAdoption({ calls: 10, distinctCallers: 3, ...FLOORS })).toBe('adopted');
  });

  it('⚠ ZERO calls is UNUSED, never below-floor — the distinction is the point', () => {
    // The live finding this probe was built for: state:subscribe at 0 calls ever,
    // sessions:timeline{goalRef} at 0 ever while its writer stamps ~38k rows/day.
    expect(judgeAdoption({ calls: 0, distinctCallers: 0, ...FLOORS })).toBe('unused');
  });

  it('SOME traffic under a floor is BELOW-FLOOR — a calibration question, not an absence', () => {
    expect(judgeAdoption({ calls: 2, distinctCallers: 1, ...FLOORS })).toBe('below-floor');
  });

  it('enough CALLS but too few CALLERS is BELOW-FLOOR — one enthusiast is not adoption', () => {
    // The failure this second floor exists for: a single agent (or one agent's loop)
    // can trivially clear a call-count floor alone, which measures a caller's habit
    // rather than the fleet's uptake.
    expect(judgeAdoption({ calls: 500, distinctCallers: 1, ...FLOORS })).toBe('below-floor');
  });

  it('⚠ an EMPTY WINDOW is NO-DATA — neither pass nor fail', () => {
    // A fresh box, a pruned retention window, a quiet night. `calls: 0` here means
    // something completely different from the `unused` case above, and conflating
    // them is how a fresh database becomes a wall of red.
    expect(judgeAdoption({ calls: 0, distinctCallers: 0, windowHadTraffic: false, ...FLOORS })).toBe('no-data');
    // …and it dominates even a row that would otherwise look adopted, because the
    // window itself is untrustworthy.
    expect(judgeAdoption({ calls: 999, distinctCallers: 9, windowHadTraffic: false, ...FLOORS })).toBe('no-data');
  });

  it('is total on junk — a probe must never throw mid-gate on a malformed count', () => {
    // These arrive from SQL, where a missing row yields null and a cast can yield NaN.
    // Treating either as "adopted" would be the worst possible failure direction.
    expect(judgeAdoption({ calls: null, distinctCallers: null, ...FLOORS })).toBe('unused');
    expect(judgeAdoption({ calls: NaN, distinctCallers: NaN, ...FLOORS })).toBe('unused');
    expect(judgeAdoption({ calls: undefined, distinctCallers: undefined, ...FLOORS })).toBe('unused');
  });

  it('only ever returns a declared verdict', () => {
    for (const args of [
      { calls: 150, distinctCallers: 5 },
      { calls: 0, distinctCallers: 0 },
      { calls: 2, distinctCallers: 1 },
      { calls: 0, distinctCallers: 0, windowHadTraffic: false },
    ]) {
      expect(ADOPTION_VERDICTS).toContain(judgeAdoption({ ...args, ...FLOORS }));
    }
  });
});

describe('isPastReview — the clock that makes a floor fireable without red-pinning main', () => {
  const now = new Date('2026-08-02T12:00:00Z');

  it('a future review date has NOT arrived', () => {
    expect(isPastReview('2026-09-01', now)).toBe(false);
  });

  it('a past review date HAS arrived', () => {
    expect(isPastReview('2026-07-01', now)).toBe(true);
  });

  it('the review date itself counts as arrived — inclusive, so a date can never be skipped', () => {
    expect(isPastReview('2026-08-02', now)).toBe(true);
  });

  it('⚠ an unparseable date is NOT past — it must never silently start failing the build', () => {
    // A typo'd date is a data error in the probe's own table. Failing closed here
    // would turn that typo into a fleet-wide red with a misleading cause.
    expect(isPastReview('not-a-date', now)).toBe(false);
    expect(isPastReview('', now)).toBe(false);
    expect(isPastReview(undefined, now)).toBe(false);
  });
});

describe('rollupAdoption — what actually fails the build, and what only reports', () => {
  const now = new Date('2026-08-02T12:00:00Z');
  const PAST = '2026-07-01';
  const FUTURE = '2026-09-01';

  it('⚠ a below-floor row BEFORE its review date is PENDING, not failing', () => {
    // The property that lets this probe land on a live gate at all. Without it,
    // merging the probe reds `main` for a condition no commit caused.
    const roll = rollupAdoption([{ verdict: 'below-floor', reviewBy: FUTURE }], now);
    expect(roll.failing).toHaveLength(0);
    expect(roll.pending).toHaveLength(1);
  });

  it('a below-floor row AFTER its review date FAILS — the floor is real, not decorative', () => {
    // The other half: a floor that can never fire is a comment. D-016's own finding
    // is that a floor with no consequence is how the feature quietly dies.
    const roll = rollupAdoption([{ verdict: 'below-floor', reviewBy: PAST }], now);
    expect(roll.failing).toHaveLength(1);
    expect(roll.pending).toHaveLength(0);
  });

  it('an UNUSED row fails on the same clock as below-floor', () => {
    expect(rollupAdoption([{ verdict: 'unused', reviewBy: PAST }], now).failing).toHaveLength(1);
    expect(rollupAdoption([{ verdict: 'unused', reviewBy: FUTURE }], now).failing).toHaveLength(0);
  });

  it('⚠ a RULING row never fails, even past its date — a settled decision is not a build error', () => {
    const roll = rollupAdoption(
      [{ verdict: 'unused', reviewBy: PAST, ruling: 'D-103 (ruled)' }],
      now,
    );
    expect(roll.failing).toHaveLength(0);
    expect(roll.pending).toHaveLength(0);
    expect(roll.ruled).toBe(1);
  });

  it('NO-DATA never fails, on either side of the clock', () => {
    expect(rollupAdoption([{ verdict: 'no-data', reviewBy: PAST }], now).failing).toHaveLength(0);
    expect(rollupAdoption([{ verdict: 'no-data', reviewBy: FUTURE }], now).failing).toHaveLength(0);
  });

  it('ADOPTED never fails', () => {
    expect(rollupAdoption([{ verdict: 'adopted', reviewBy: PAST }], now).failing).toHaveLength(0);
  });

  it('counts every verdict, so the summary line cannot under-report', () => {
    const roll = rollupAdoption(
      [
        { verdict: 'adopted', reviewBy: PAST },
        { verdict: 'adopted', reviewBy: FUTURE },
        { verdict: 'below-floor', reviewBy: FUTURE },
        { verdict: 'unused', reviewBy: PAST },
        { verdict: 'no-data', reviewBy: PAST },
        { verdict: 'unused', reviewBy: PAST, ruling: 'D-103 (ruled)' },
      ],
      now,
    );
    expect(roll.adopted).toBe(2);
    expect(roll.belowFloor).toBe(1);
    expect(roll.unused).toBe(2); // the ruled one is still UNUSED; `ruled` is orthogonal
    expect(roll.noData).toBe(1);
    expect(roll.ruled).toBe(1);
    expect(roll.failing).toHaveLength(1); // only the un-ruled past-date unused row
    expect(roll.pending).toHaveLength(1); // the future-date below-floor row
  });
});

describe('the surface table encodes D-047, not invented floors', () => {
  it('every surface declares floors and a review date the rollup can act on', () => {
    expect(PLANE_ADOPTION_SURFACES.length).toBeGreaterThan(0);
    for (const s of PLANE_ADOPTION_SURFACES) {
      expect(s.id, 'every row needs an id').toBeTruthy();
      expect(typeof s.floorCalls, `${s.id}.floorCalls`).toBe('number');
      expect(typeof s.floorCallers, `${s.id}.floorCallers`).toBe('number');
      // A row with no review date can never fail, which would make it decorative —
      // exactly the "floor with no consequence" D-016 names as how a feature dies.
      expect(s.reviewBy, `${s.id} must declare a review date`).toBeTruthy();
      expect(isPastReview(s.reviewBy, new Date('2000-01-01')), `${s.id}.reviewBy must parse`).toBe(false);
      expect(isPastReview(s.reviewBy, new Date('2099-01-01')), `${s.id}.reviewBy must parse`).toBe(true);
      // The `why` is what a future reader needs to judge whether the floor is still
      // the right number — a floor with no stated rationale cannot be re-litigated.
      expect(s.why, `${s.id} must say why its floor is what it is`).toBeTruthy();
    }
  });
});
