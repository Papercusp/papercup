import { describe, expect, it } from 'vitest';
import {
  classifyGraderPickup,
  observeGraderPickup,
  type GraderActivityReading,
  type GraderPickupVerdict,
} from './acceptance-grader-pickup';

/**
 * P-003 R-3 falsifier, from the plan's acceptance bar:
 *   "The provider reports a grader as woken on the strength of a queued delivery
 *    count while that grader takes no turn afterwards."
 *
 * Both wrong implementations below are kept PERMANENTLY as live controls rather
 * than mutating the subject to prove falsifiability (the shared tree is swept by
 * git-sync, so an in-tree mutation can be committed even when nothing goes wrong).
 * Each control is exercised on the same input as the real subject; a test that
 * only asserted the subject's answer could not show the two DISAGREE, which is
 * the whole property under test.
 */

const WAKE = Date.parse('2026-09-22T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * CONTROL A — the FORBIDDEN implementation R-3 exists to rule out: pickup
 * inferred from the wake fan's queued delivery count. Note it cannot even be
 * written against `GraderActivityReading`, because that type carries no delivery
 * count; it has to take its own receipt shape. That is the structural guarantee.
 */
function pickupFromDeliveryCount(receipt: { woke: number }): GraderPickupVerdict {
  return receipt.woke > 0 ? 'confirmed' : 'not-yet';
}

/**
 * CONTROL B — the SUBTLY wrong implementation: reconstruct the activity instant
 * from a whole-second "seconds ago" reading instead of the raw timestamp. This is
 * what `classifyGraderPickup` would do if it read `deriveLastActive`'s rounded
 * `lastActiveSecAgo` back into an absolute instant.
 */
function pickupFromRoundedSecAgo(args: {
  wakeInstantMs: number;
  lastActiveAt: string;
  nowMs: number;
}): GraderPickupVerdict {
  const secAgo = Math.max(0, Math.round((args.nowMs - Date.parse(args.lastActiveAt)) / 1000));
  const reconstructed = args.nowMs - secAgo * 1000;
  return reconstructed > args.wakeInstantMs ? 'confirmed' : 'not-yet';
}

describe('classifyGraderPickup — R-3 pickup is the grader’s own later activity', () => {
  it('CALIBRATION: a genuinely picked-up grader is confirmed, and both controls agree', () => {
    // Exists so the controls below cannot pass vacuously: it proves each control
    // is wired up and capable of returning 'confirmed' at all. Without it, a
    // control that always returned 'not-yet' would look like it was discriminating.
    const reading: GraderActivityReading = { recordLastActiveAt: iso(WAKE + 30_000) };
    const out = classifyGraderPickup({ wakeInstantMs: WAKE, reading, nowMs: WAKE + 60_000 });

    expect(out.verdict).toBe('confirmed');
    expect(out.source).toBe('presence');
    expect(out.sinceWakeMs).toBe(30_000);

    expect(pickupFromDeliveryCount({ woke: 1 })).toBe('confirmed');
    expect(
      pickupFromRoundedSecAgo({
        wakeInstantMs: WAKE,
        lastActiveAt: iso(WAKE + 30_000),
        nowMs: WAKE + 60_000,
      }),
    ).toBe('confirmed');
  });

  it('FALSIFIER ARM: woke:1 with no activity after the wake is NOT a confirmed pickup', () => {
    // The exact falsifier: delivery succeeded (woke:1) but the grader has taken no
    // turn since. A confirmed verdict here would falsify R-3 on P-003.
    const reading: GraderActivityReading = { recordLastActiveAt: iso(WAKE - 30_000) };
    const out = classifyGraderPickup({ wakeInstantMs: WAKE, reading, nowMs: WAKE + 60_000 });

    expect(out.verdict).toBe('not-yet');
    expect(out.verdict).not.toBe('confirmed');
    expect(out.sinceWakeMs).toBe(-30_000);

    // The control, on the SAME situation, reports the grader as woken purely on
    // the delivery count — and therefore disagrees. That disagreement IS R-3.
    expect(pickupFromDeliveryCount({ woke: 1 })).toBe('confirmed');
    expect(pickupFromDeliveryCount({ woke: 1 })).not.toBe(out.verdict);
  });

  it('fails closed at the boundary: activity exactly AT the wake instant is not pickup', () => {
    const reading: GraderActivityReading = { recordLastActiveAt: iso(WAKE) };
    const out = classifyGraderPickup({ wakeInstantMs: WAKE, reading, nowMs: WAKE + 60_000 });
    expect(out.verdict).toBe('not-yet');
  });

  it('sub-second precision: activity 100ms BEFORE the wake is not pickup (rounding control disagrees)', () => {
    // Chosen so whole-second rounding flips the verdict: now-wake is deliberately
    // not a whole number of seconds, which is the ordinary case in production.
    const nowMs = WAKE + 300_300;
    const lastActiveAt = iso(WAKE - 100);
    const out = classifyGraderPickup({
      wakeInstantMs: WAKE,
      reading: { recordLastActiveAt: lastActiveAt },
      nowMs,
    });

    expect(out.verdict).toBe('not-yet');
    // CONTROL B reconstructs the instant from a rounded seconds-ago value and
    // lands AFTER the wake — a false confirmation from a 100ms-stale reading.
    expect(pickupFromRoundedSecAgo({ wakeInstantMs: WAKE, lastActiveAt, nowMs })).toBe('confirmed');
  });

  it('consults the transcript leg too: a stale presence row with a fresh turn part is pickup', () => {
    // Both activity sources under-report and neither over-reports, so the freshest
    // of the two is the defensible reading. Ignoring the transcript leg would
    // report a working grader as not-yet.
    const out = classifyGraderPickup({
      wakeInstantMs: WAKE,
      reading: {
        recordLastActiveAt: iso(WAKE - 600_000),
        turnPartLastAt: iso(WAKE + 120_000),
      },
      nowMs: WAKE + 180_000,
    });

    expect(out.verdict).toBe('confirmed');
    expect(out.source).toBe('turn-parts');
  });

  it('UNREADABLE is distinct from not-yet: a TTL-reaped grader is a failed measurement', () => {
    // coord_presence rows are TTL-reaped, so an absent row is routine and is NOT
    // evidence the grader did nothing. Collapsing this into a boolean false is the
    // false-negative that drives needless re-recruitment (plan D-011 ruling 4).
    const out = classifyGraderPickup({
      wakeInstantMs: WAKE,
      reading: { recordLastActiveAt: null, turnPartLastAt: null },
      nowMs: WAKE + 60_000,
    });

    expect(out.verdict).toBe('unreadable');
    expect(out.verdict).not.toBe('not-yet');
    expect(out.graderLastActiveMs).toBeNull();
    expect(out.source).toBeNull();
  });

  it('an unparseable timestamp is unreadable, not a verdict about the grader', () => {
    const out = classifyGraderPickup({
      wakeInstantMs: WAKE,
      reading: { recordLastActiveAt: 'not-a-timestamp' },
      nowMs: WAKE + 60_000,
    });
    expect(out.verdict).toBe('unreadable');
  });

  it('STRUCTURAL: a delivery count cannot be supplied to the classifier at all', () => {
    // Compile-time guard, checked by lint:tsc (vitest strips types and cannot see
    // it). If anyone adds a delivery-count field to GraderActivityReading, the
    // directive below becomes an unused-directive error (TS2578) and the build
    // fails — which is the point: an absent field is enforcement, a comment is
    // advice. NB: do not start a prose line in this file with the directive's own
    // name — TypeScript parses any comment line beginning with it as a REAL
    // directive, which then applies to the following comment line and reports
    // TS2578 against documentation rather than code.
    // @ts-expect-error — `woke` is deliberately absent from GraderActivityReading
    const forbidden: GraderActivityReading = { recordLastActiveAt: null, woke: 1 };
    expect(forbidden.recordLastActiveAt).toBeNull();
  });
});

describe('observeGraderPickup — the callable later-observation seam', () => {
  it('re-reads the grader and confirms pickup from its own activity', async () => {
    const out = await observeGraderPickup(
      { graderId: 'su-grader', wakeInstantMs: WAKE, nowMs: WAKE + 60_000 },
      { read: async () => ({ recordLastActiveAt: iso(WAKE + 5_000) }) },
    );
    expect(out.verdict).toBe('confirmed');
  });

  it('reports a failed read as unreadable, never as not-yet', async () => {
    // An infrastructure fault must not be reported as a statement about the
    // grader's behaviour — that is how a live grader gets replaced.
    const out = await observeGraderPickup(
      { graderId: 'su-grader', wakeInstantMs: WAKE, nowMs: WAKE + 60_000 },
      {
        read: async () => {
          throw new Error('pg down');
        },
      },
    );
    expect(out.verdict).toBe('unreadable');
    expect(out.verdict).not.toBe('not-yet');
  });

  it('a parked grader that never takes a turn is never reported as picked up', async () => {
    // The end-to-end shape of the falsifier at the callable seam.
    const out = await observeGraderPickup(
      { graderId: 'su-parked', wakeInstantMs: WAKE, nowMs: WAKE + 3_600_000 },
      { read: async () => ({ recordLastActiveAt: iso(WAKE - 1_000) }) },
    );
    expect(out.verdict).toBe('not-yet');
    expect(out.reason).toContain('NOT a basis for re-recruiting');
  });
});
