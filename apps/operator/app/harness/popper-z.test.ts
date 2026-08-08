/**
 * The layer algebra behind harness/popper-z.ts.
 *
 * WHY THIS TEST EXISTS AND WHAT IT CAN ACTUALLY PROVE
 * ---------------------------------------------------
 * jsdom does not paint — it has no stacking contexts and no hit-testing — so a
 * component test asserting "the modal is on top" passes with the bug fully
 * present. `_lints/popper-stacking.test.ts` says this at length and it is the
 * reason the CSS-side guard is a static lint.
 *
 * But the defect in WI-35969 was not a painting subtlety: it was a NUMBER.
 * `Modal` defaulted to z 100 while the popper floor was 1500, so every modal
 * opened from a dropdown was ordered under it. An ordering that is decided by
 * arithmetic can be tested by arithmetic, and that is all this file does — it
 * asserts the three orderings the app depends on, in every open/close sequence
 * that produces them:
 *
 *     shell  <  popper  <  modal  <  popper-inside-that-modal  <  tooltip
 *
 * The CONTROL at the bottom is what keeps this honest: it re-runs the SAME
 * assertion against the old constant and requires it to FAIL. Without it,
 * "these tests pass" is equally consistent with "these tests assert nothing".
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  LAYER_STEP,
  MODAL_CEILING_Z,
  MODAL_FLOOR_Z,
  POPPER_WRAPPER_FLOOR_Z,
  TOOLTIP_FLOOR_Z,
  _resetModalLayerRegistry,
  clampModalZ,
  clampPopperZ,
  nextModalZ,
  popperFloorZ,
  registerOpenModalZ,
  topOpenModalZ,
} from './popper-z';

describe('popper/modal layer model', () => {
  beforeEach(() => {
    _resetModalLayerRegistry();
  });

  describe('the floors are ordered', () => {
    it('puts modals above poppers and tooltips above the whole modal band', () => {
      expect(MODAL_FLOOR_Z).toBeGreaterThan(POPPER_WRAPPER_FLOOR_Z);
      expect(MODAL_CEILING_Z).toBeGreaterThanOrEqual(MODAL_FLOOR_Z);
      // Static, so it must clear the DEEPEST a modal can ever go — not merely
      // the floor. This is the assertion that makes MODAL_CEILING_Z load-bearing
      // rather than decorative.
      expect(TOOLTIP_FLOOR_Z).toBeGreaterThan(MODAL_CEILING_Z);
    });
  });

  describe('with no modal open', () => {
    it('leaves the popper floor exactly at the shell floor', () => {
      expect(topOpenModalZ()).toBe(0);
      expect(popperFloorZ()).toBe(POPPER_WRAPPER_FLOOR_Z);
      expect(clampPopperZ(undefined)).toBe(POPPER_WRAPPER_FLOOR_Z);
    });

    it('clamps a below-floor caller value up instead of honouring it', () => {
      // Measured 2026-08-03: every explicit Popover call site was below the
      // floor (five at 200, three at 1400, one at 120). Honouring any of them
      // is burial behind the shell, not "lower ordering".
      for (const bad of [0, 90, 120, 200, 1400, 1499]) {
        expect(clampPopperZ(bad)).toBe(POPPER_WRAPPER_FLOOR_Z);
      }
      expect(clampPopperZ(1600)).toBe(1600);
    });
  });

  describe('a modal opened while a popover is up', () => {
    it('takes a layer ABOVE that popover — the reported bug', () => {
      const popoverZ = clampPopperZ(undefined); // the dropdown is already open
      const modalZ = nextModalZ();
      expect(modalZ).toBe(MODAL_FLOOR_Z);
      expect(modalZ).toBeGreaterThan(popoverZ);
    });
  });

  describe('a popper opened INSIDE a modal', () => {
    it('rises above that modal instead of being buried by it', () => {
      const modalZ = nextModalZ();
      const release = registerOpenModalZ(modalZ);
      try {
        expect(topOpenModalZ()).toBe(modalZ);
        expect(popperFloorZ()).toBe(modalZ + LAYER_STEP);
        expect(popperFloorZ()).toBeGreaterThan(modalZ);
        // A caller-supplied value that used to be "the floor" must not pin it
        // back down below the modal.
        expect(clampPopperZ(POPPER_WRAPPER_FLOOR_Z)).toBeGreaterThan(modalZ);
      } finally {
        release();
      }
    });

    it('drops back to the shell floor once the modal closes', () => {
      const release = registerOpenModalZ(nextModalZ());
      expect(popperFloorZ()).toBeGreaterThan(POPPER_WRAPPER_FLOOR_Z);
      release();
      expect(topOpenModalZ()).toBe(0);
      expect(popperFloorZ()).toBe(POPPER_WRAPPER_FLOOR_Z);
    });
  });

  describe('modal → popper → modal nesting', () => {
    it('keeps every layer strictly above the one it was opened from', () => {
      const modalA = nextModalZ();
      const releaseA = registerOpenModalZ(modalA);
      const popperInA = clampPopperZ(undefined);
      const modalB = nextModalZ();
      const releaseB = registerOpenModalZ(modalB);
      const popperInB = clampPopperZ(undefined);

      expect(modalA).toBeGreaterThan(POPPER_WRAPPER_FLOOR_Z);
      expect(popperInA).toBeGreaterThan(modalA);
      // The one `+ 2 * LAYER_STEP` exists for: modal B was launched from a
      // popper sitting above modal A, so clearing modal A is not enough.
      expect(modalB).toBeGreaterThan(popperInA);
      expect(popperInB).toBeGreaterThan(modalB);
      expect(TOOLTIP_FLOOR_Z).toBeGreaterThan(popperInB);

      releaseB();
      expect(topOpenModalZ()).toBe(modalA);
      releaseA();
      expect(topOpenModalZ()).toBe(0);
    });

    it('stays inside the band no matter how deep the nesting goes', () => {
      const releases: Array<() => void> = [];
      for (let i = 0; i < 40; i++) releases.push(registerOpenModalZ(nextModalZ()));
      try {
        expect(topOpenModalZ()).toBeLessThanOrEqual(MODAL_CEILING_Z);
        // The whole point of the ceiling: a static tooltip floor stays on top
        // even under absurd nesting.
        expect(TOOLTIP_FLOOR_Z).toBeGreaterThan(popperFloorZ());
      } finally {
        for (const r of releases) r();
      }
    });
  });

  describe('registration bookkeeping', () => {
    it('does not let two modals sharing a z delete each other', () => {
      // Two modals opened in the same commit compute the same z. Keying the
      // registry by the VALUE would make the first close drop both.
      const a = registerOpenModalZ(MODAL_FLOOR_Z);
      const b = registerOpenModalZ(MODAL_FLOOR_Z);
      a();
      expect(topOpenModalZ()).toBe(MODAL_FLOOR_Z);
      b();
      expect(topOpenModalZ()).toBe(0);
    });

    it('falls back to the next-highest modal, not to zero, on an out-of-order close', () => {
      const low = registerOpenModalZ(MODAL_FLOOR_Z);
      const high = registerOpenModalZ(MODAL_FLOOR_Z + 2 * LAYER_STEP);
      high();
      expect(topOpenModalZ()).toBe(MODAL_FLOOR_Z);
      low();
    });
  });

  describe('clampModalZ', () => {
    it('lifts a legacy below-floor value instead of honouring it', () => {
      // The two real ones this repo carried: BranchActionRunner passed 200 and
      // FeatureEditor 120. Both were UNDER the popper floor, so neither ordered
      // its modal above anything — they only read as if they did.
      expect(clampModalZ(120)).toBe(MODAL_FLOOR_Z);
      expect(clampModalZ(200)).toBe(MODAL_FLOOR_Z);
      expect(clampModalZ(undefined)).toBe(MODAL_FLOOR_Z);
    });

    it('holds a runaway value inside the band', () => {
      expect(clampModalZ(999_999)).toBe(MODAL_CEILING_Z);
    });
  });

  /**
   * FALSIFIABILITY CONTROL — kept permanently rather than proven once by
   * mutating the source, because git-sync sweeps this tree into commits every
   * few minutes and an in-tree mutation probe can be committed by the sweep
   * (CLAUDE.md § "Proving a guard is falsifiable").
   *
   * Case 1 is the exact shape that shipped: the modal floor as it was.
   */
  describe('CONTROL: the assertions above can fail', () => {
    it('rejects the constant that shipped the bug', () => {
      const SHIPPED_MODAL_Z = 100; // harness/Modal.tsx, `const z = zIndex ?? 100`
      expect(SHIPPED_MODAL_Z).toBeLessThan(POPPER_WRAPPER_FLOOR_Z);
      // i.e. the "a modal opened while a popover is up" test above would fail
      // against it — which is what the user saw.
      expect(SHIPPED_MODAL_Z > clampPopperZ(undefined)).toBe(false);
    });

    it('rejects a modal floor that forgets the popper floor rises inside it', () => {
      // The tempting half-fix: bump Modal above 1500 and leave the popper floor
      // static. Every Select/Combobox inside a modal is then buried — the
      // failure mode that made a naive fix worse than the bug.
      const staticPopperFloor = POPPER_WRAPPER_FLOOR_Z;
      const release = registerOpenModalZ(nextModalZ());
      try {
        expect(staticPopperFloor > topOpenModalZ()).toBe(false);
        expect(popperFloorZ() > topOpenModalZ()).toBe(true);
      } finally {
        release();
      }
    });
  });
});
