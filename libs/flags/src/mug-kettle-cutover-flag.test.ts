/**
 * FLAGS.MUG_KETTLE_SYSTEM — the cutover switch's POLARITY guard
 * (retire-mug-kettle-su-only-2026-08-09, P-006 / D-004 / D-008).
 *
 * P-006 says, verbatim: "Verify the derived default is actually OFF with a test,
 * not by reading the comment." That instruction is not ceremony — this repo has
 * shipped the flag-default-inversion bug at least eight times (AUTHORITY_RPC_PROTOMUX,
 * LAZY_SUBSTRATE_BOOT, AUTHORITY_EVICTION_PROBE, GIT_SYNC_DERIVED_ATTRIBUTION,
 * DOC_STEWARD, …): a flag whose comment said "DEFAULT OFF" for months while it
 * derived live-ON, because the comment was never backed by a DARK_FLAGS entry.
 * A comment is a claim; FLAG_DEFAULTS is the writer. This file reads the writer.
 *
 * WHY THIS FLAG SPECIFICALLY GETS ITS OWN GUARD: its polarity is INVERTED relative
 * to every other dark flag. Normally OFF = "the new thing is not on yet", so the
 * house rule "finished work ships ON" is right. Here OFF IS the finished work —
 * the Mug/Kettle/Cup tier retired, su + GOAL mode the only way to drive the app.
 * That makes this entry uniquely vulnerable to a well-intentioned "fix": an agent
 * or a dark-flag sweep applying the usual rule would remove it from DARK_FLAGS to
 * "graduate" it, and silently UN-RETIRE the entire tier. Nothing would error. The
 * failure mode is the mug loop, kettle loop and cup placement quietly coming back.
 *
 * So the assertions below are deliberately about the DERIVED VALUE and the CASE,
 * not about the prose.
 */
import { describe, it, expect } from 'vitest';
import { FLAGS, FLAG_DEFAULTS, DARK_FLAGS, DARK_FLAGS_PARKING_CASES } from './types';

describe('FLAGS.MUG_KETTLE_SYSTEM — the retirement cutover switch', () => {
  it('derives DEFAULT OFF (read from FLAG_DEFAULTS, not from the comment)', () => {
    expect(FLAG_DEFAULTS[FLAGS.MUG_KETTLE_SYSTEM]).toBe(false);
  });

  it('is default-OFF BECAUSE it is registered in DARK_FLAGS (the one source of truth)', () => {
    // The inversion bug's signature is precisely a comment/entry mismatch: the
    // derived default above can only be false if this entry exists, so asserting
    // both pins the mechanism rather than just the outcome.
    expect(DARK_FLAGS.has(FLAGS.MUG_KETTLE_SYSTEM)).toBe(true);
  });

  it("is a 'cutover' kill switch — NOT parked/incomplete, so it is not rationed by the parking budget", () => {
    const entry = DARK_FLAGS.get(FLAGS.MUG_KETTLE_SYSTEM);
    expect(entry?.case).toBe('cutover');
    // Guards the classification's real consequence: parked/incomplete entries are
    // capped by DARK_FLAGS_HIGH_WATERMARK, and mis-filing this as one would force a
    // future agent to "make room" by graduating it — i.e. un-retiring the tier to
    // satisfy a size budget that was never meant to govern kill switches.
    expect(DARK_FLAGS_PARKING_CASES.has(entry!.case)).toBe(false);
  });

  it('states the inverted polarity in its own reason, so a sweep cannot mistake OFF for unfinished work', () => {
    // The one prose assertion here, and it earns its place: the dark-flag review
    // walks entries by READING reasons, and this is the entry whose correct action
    // ("leave it OFF") is the opposite of the default reading ("flip it when ready").
    const reason = DARK_FLAGS.get(FLAGS.MUG_KETTLE_SYSTEM)?.reason ?? '';
    expect(reason).toMatch(/INVERTED/);
    expect(reason).toMatch(/retire-mug-kettle-su-only-2026-08-09/);
  });

  it('does NOT gate Scout/Blender or the shared pot substrate (D-001/D-003)', () => {
    // Both survive the retirement, and both have their own flags where gating is
    // wanted. This asserts the boundary at the registry level: MUG_KETTLE_SYSTEM is
    // one distinct key, never an alias of a Scout/overwatch flag.
    expect(FLAGS.MUG_KETTLE_SYSTEM).toBe('papercusp-mug-kettle-system');
    expect(FLAGS.MUG_KETTLE_SYSTEM).not.toBe(FLAGS.OVERWATCH);
    expect(FLAGS.MUG_KETTLE_SYSTEM).not.toBe(FLAGS.SCORECARD_EMISSION_PULSE);
  });

  it('the P-035 scorecard floor is NOT swept up by the retirement (D-015)', () => {
    // The pulse backstops the retiring agent, so it must outlive it. If someone
    // later dark-flags the pulse alongside the tier, the deterministic
    // pot-coordination-health floor dies silently — the exact WI-2374 regression
    // D-015 removed. Default ON, and deliberately not in DARK_FLAGS.
    expect(FLAG_DEFAULTS[FLAGS.SCORECARD_EMISSION_PULSE]).toBe(true);
    expect(DARK_FLAGS.has(FLAGS.SCORECARD_EMISSION_PULSE)).toBe(false);
  });
});
