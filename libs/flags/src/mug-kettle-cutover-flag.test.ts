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

/**
 * The four detection predicates, factored out of the assertions so the NEGATIVE
 * CONTROLS at the bottom of this file can exercise the EXACT logic the real
 * assertions use.
 *
 * They are functions rather than inline `expect`s for one reason: a control that
 * re-implements its subject proves the COPY works, not the guard. Sharing the
 * predicate is what makes the control load-bearing.
 *
 * ⚠ These replace a one-shot in-tree mutation probe (re-add the flag to
 * `types.ts`, watch this file red, restore it). That probe was REJECTED, not
 * skipped: CLAUDE.md's falsifiability tiers put an imported module at tier 1
 * ("keep a deliberately-wrong implementation permanently in the test file …
 * never mutate production code"), and here the tier-3 alternative is actively
 * dangerous — git-sync sweeps the whole tree every few minutes, so a probe that
 * holds `types.ts` mutated for the length of a run can COMMIT a re-added
 * MUG_KETTLE_SYSTEM: the exact un-retirement this file exists to prevent, landed
 * by the act of testing for it. Permanent controls also re-run in CI forever,
 * where a one-shot probe proves the guard was falsifiable once, on one machine.
 */
const keyPresent = (reg: Record<string, string>): boolean => 'MUG_KETTLE_SYSTEM' in reg;
const wireValueSmuggled = (reg: Record<string, string>): boolean =>
  Object.values(reg).includes(RETIRED_WIRE_VALUE);
const defaultDerived = (defaults: Record<string, unknown>): boolean =>
  RETIRED_WIRE_VALUE in defaults;
const darklyPreserved = (dark: { has(value: string): boolean }): boolean =>
  dark.has(RETIRED_WIRE_VALUE);

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
    expect(keyPresent(FLAGS as Record<string, string>)).toBe(false);
    // The key could be renamed while the wire value survives, which would restore
    // the switch under a different name — so assert the VALUE is absent too.
    expect(wireValueSmuggled(FLAGS as Record<string, string>)).toBe(false);
  });

  it('is gone from FLAG_DEFAULTS — nothing derives a default for it', () => {
    expect(defaultDerived(FLAG_DEFAULTS as Record<string, unknown>)).toBe(false);
  });

  it('is gone from DARK_FLAGS — the tier is retired permanently, not darkly', () => {
    // A DARK_FLAGS entry here would mean the retirement had become reversible
    // again, which is the one thing P-068 was for.
    expect(darklyPreserved(DARK_FLAGS)).toBe(false);
  });

  it('the P-035 scorecard floor is still NOT swept up by the retirement (D-015)', () => {
    // Unchanged by the deletion, and still worth pinning: the pulse backstops the
    // retired agent, so it must outlive it. If someone later dark-flags the pulse
    // alongside the tier, the deterministic pot-coordination-health floor dies
    // silently — the exact WI-2374 regression D-015 removed.
    expect(FLAG_DEFAULTS[FLAGS.SCORECARD_EMISSION_PULSE]).toBe(true);
    expect(DARK_FLAGS.has(FLAGS.SCORECARD_EMISSION_PULSE)).toBe(false);
  });

  describe('NEGATIVE CONTROLS — every predicate above must FIRE on a re-added flag', () => {
    /**
     * The calibration test proves the registry LOADED. These prove the predicates
     * would CATCH a re-added flag. Both are required, and neither substitutes for
     * the other: a loaded registry says the measurement happened, a firing
     * predicate says the measurement can come back positive.
     *
     * Each control is paired with a negative case, so a predicate that simply
     * returned `true` for everything would fail here rather than look vigilant.
     */
    it('keyPresent catches the key being re-added', () => {
      expect(keyPresent({ MUG_KETTLE_SYSTEM: RETIRED_WIRE_VALUE })).toBe(true);
      expect(keyPresent({ SOMETHING_ELSE: 'papercusp-other' })).toBe(false);
    });

    it('wireValueSmuggled catches the value re-added under a DIFFERENT key', () => {
      // The rename-smuggling case the value assertion exists for: the key is gone
      // but the switch is back.
      expect(wireValueSmuggled({ RENAMED_TIER_FLAG: RETIRED_WIRE_VALUE })).toBe(true);
      expect(wireValueSmuggled({ SOMETHING_ELSE: 'papercusp-other' })).toBe(false);
    });

    it('defaultDerived catches a reintroduced default', () => {
      expect(defaultDerived({ [RETIRED_WIRE_VALUE]: false })).toBe(true);
      expect(defaultDerived({ 'papercusp-other': true })).toBe(false);
    });

    it('darklyPreserved catches a reintroduced DARK_FLAGS entry', () => {
      expect(darklyPreserved(new Set([RETIRED_WIRE_VALUE]))).toBe(true);
      expect(darklyPreserved(new Set(['papercusp-other']))).toBe(false);
    });
  });
});
