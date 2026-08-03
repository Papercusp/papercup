/**
 * The z-index floor for every body-portaled Radix popper.
 *
 * WHY THIS IS A SHARED CONSTANT AND NOT A LITERAL PER COMPONENT
 * ------------------------------------------------------------
 * Radix wraps popper Content in `[data-radix-popper-content-wrapper]`, which is
 * `position: fixed` and therefore joins the ROOT stacking context. A z-index set
 * on the *Content* only orders things INSIDE the wrapper — except that Radix
 * reads the Content's computed z-index at mount and copies it onto the wrapper
 * as an INLINE style. Inline beats a stylesheet rule without `!important`, so a
 * Content that sets a LOW z-index actively OVERRIDES the CSS floor in
 * `harness.css` (`[data-radix-popper-content-wrapper] { z-index: 1500 }`) and
 * re-creates the "menus do nothing" bug: the menu mounts, positions correctly,
 * reports `opacity: 1` / `pointer-events: auto`, and is painted behind the shell.
 *
 * The value must clear EVERY shell layer, not just the obvious ones: `<main>` is
 * 70 and the floating Oracle controls are 80, but `.oracle-dock--maximal-hud`
 * reaches 1450 — which is why anything "high-looking" but under 1500 (1400 is
 * the tempting one) still loses in maximal-HUD mode.
 *
 * This value is asserted to equal the CSS floor by
 * `apps/operator/app/_lints/popper-stacking.test.ts`, so the two cannot drift.
 * Keep them in sync by changing BOTH, or the lint fails.
 */
export const POPPER_WRAPPER_FLOOR_Z = 1500;

/**
 * Clamp a caller-supplied popper z-index UP to the floor.
 *
 * Callers legitimately want to order poppers relative to each other, but any
 * value below the floor is not "lower ordering" — it is burial behind the app
 * shell, because the wrapper competes in the ROOT stacking context. Clamping
 * (rather than trusting the caller) is what makes the whole class impossible at
 * the primitive instead of relying on ~10 call sites each getting it right;
 * measured 2026-08-03, every explicit call site was below the floor (five at
 * 200, three at 1400, one at 120).
 *
 * Ties are fine: equal z-indexes resolve by DOM order, so a popper opened later
 * still paints above one opened earlier.
 */
export function clampPopperZ(zIndex: number | undefined): number {
  return Math.max(zIndex ?? POPPER_WRAPPER_FLOOR_Z, POPPER_WRAPPER_FLOOR_Z);
}
