/**
 * Platform-mode gate for the improvement-watchdog/triage/implement seed
 * (per-hive-learning-loops-2026-06-14 P-070). These are LAYER-3
 * platform-improvement (Class-C) loops: when the PLATFORM_IMPROVEMENT_LOOPS knob
 * is OFF (a public release before the user opts into platform mode) they seed
 * INACTIVE regardless of the --active / --arm-implement CLI levers.
 */
import { describe, it, expect } from 'vitest';
import { resolveImprovementRoutineActive } from './seed-improvement-routines';

const watchdog = { arm: 'safe' as const }; // improvement-watchdog / improvement-triage
const implement = { arm: 'owner' as const }; // improvement-implement (owner-gated)

describe('resolveImprovementRoutineActive — platform-mode gate (P-070)', () => {
  it('platform mode OFF forces EVERY routine inactive, even with --active --arm-implement', () => {
    expect(
      resolveImprovementRoutineActive(watchdog, { active: true, armImplement: true, platformLoopsOn: false }),
    ).toBe(false);
    expect(
      resolveImprovementRoutineActive(implement, { active: true, armImplement: true, platformLoopsOn: false }),
    ).toBe(false);
  });

  it('platform mode ON preserves the existing CLI semantics for the safe (watchdog) tier', () => {
    expect(
      resolveImprovementRoutineActive(watchdog, { active: false, armImplement: false, platformLoopsOn: true }),
    ).toBe(false); // not --active ⇒ inactive
    expect(
      resolveImprovementRoutineActive(watchdog, { active: true, armImplement: false, platformLoopsOn: true }),
    ).toBe(true); // --active ⇒ live
  });

  it('platform mode ON preserves the owner-gated implement tier (needs BOTH --active + --arm-implement)', () => {
    expect(
      resolveImprovementRoutineActive(implement, { active: true, armImplement: false, platformLoopsOn: true }),
    ).toBe(false); // --active alone is not enough for the implement routine
    expect(
      resolveImprovementRoutineActive(implement, { active: true, armImplement: true, platformLoopsOn: true }),
    ).toBe(true); // both ⇒ live
  });
});
