/**
 * FLAGS.MUG_KETTLE_SYSTEM — the DELETION guard
 * (retire-mug-kettle-su-only-2026-08-09, P-068 / D-098; formerly the P-006 polarity guard).
 *
 * ⚠ THIS FILE'S SUBJECT CHANGED. It used to guard the cutover switch's INVERTED
 * polarity: OFF was the finished work (the tier retired) and ON a reversible
 * testing escape hatch, so the file existed to stop a well-meaning dark-flag
 * sweep from "graduating" the entry and silently un-retiring the tier.
 *
 * P-068 deleted the flag — which is how its own DARK_FLAGS reason always said it
 * would graduate ("it does NOT graduate by being flipped ON: it graduates when
 * Stage 2/3 lands and the flag is DELETED"). That was safe ONLY because the gates
 * the flag fed did not go with it: `pot/started.ts`'s `mugKettleSystemEnabled()`
 * is now a permanent `false` feeding the same ~20 gates (D-098).
 *
 * So the old fear is now the STANDING invariant, inverted: the danger is no
 * longer that someone removes the DARK_FLAGS entry, it is that someone RE-ADDS
 * the flag — reintroducing a runtime switch that could flip a permanently-retired
 * tier back on. These assertions fail if that happens.
 *
 * ⚠ THESE ARE ABSENCE ASSERTIONS, which pass vacuously against an empty or
 * mis-imported registry. The calibration test below runs FIRST and fails loudly
 * in that case, so a green result here means "measured and absent", never
 * "nothing was measured".
 */
import { describe, it, expect } from 'vitest';
import { FLAGS, FLAG_DEFAULTS, DARK_FLAGS } from './types';

/** The wire value the deleted flag carried. Nothing may reintroduce it. */
const RETIRED_WIRE_VALUE = 'papercusp-mug-kettle-system';

describe('FLAGS.MUG_KETTLE_SYSTEM — deleted, and must stay deleted', () => {
  it('CALIBRATION: the registry really loaded (so the absence assertions below are not vacuous)', () => {
    // Without this, every assertion in this file would also pass against an empty
    // object — the exact failure mode where a guard reports clean because it
    // measured nothing at all.
    expect(Object.keys(FLAGS).length).toBeGreaterThan(20);
    expect(FLAGS.SCORECARD_EMISSION_PULSE).toBe('papercusp-scorecard-emission-pulse');
    expect(DARK_FLAGS.size).toBeGreaterThan(0);
  });

  it('is gone from FLAGS — no key, and no other key smuggles its wire value back', () => {
    expect('MUG_KETTLE_SYSTEM' in FLAGS).toBe(false);
    // The key could be renamed while the wire value survives, which would restore
    // the switch under a different name — so assert the VALUE is absent too.
    expect(Object.values(FLAGS as Record<string, string>)).not.toContain(RETIRED_WIRE_VALUE);
  });

  it('is gone from FLAG_DEFAULTS — nothing derives a default for it', () => {
    expect(RETIRED_WIRE_VALUE in FLAG_DEFAULTS).toBe(false);
  });

  it('is gone from DARK_FLAGS — the tier is retired permanently, not darkly', () => {
    // A DARK_FLAGS entry here would mean the retirement had become reversible
    // again, which is the one thing P-068 was for.
    expect(DARK_FLAGS.has(RETIRED_WIRE_VALUE)).toBe(false);
  });

  it('the P-035 scorecard floor is still NOT swept up by the retirement (D-015)', () => {
    // Unchanged by the deletion, and still worth pinning: the pulse backstops the
    // retired agent, so it must outlive it. If someone later dark-flags the pulse
    // alongside the tier, the deterministic pot-coordination-health floor dies
    // silently — the exact WI-2374 regression D-015 removed.
    expect(FLAG_DEFAULTS[FLAGS.SCORECARD_EMISSION_PULSE]).toBe(true);
    expect(DARK_FLAGS.has(FLAGS.SCORECARD_EMISSION_PULSE)).toBe(false);
  });
});
