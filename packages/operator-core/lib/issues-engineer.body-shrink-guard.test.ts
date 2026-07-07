/**
 * EI-8497: `work_items:update`'s body field had no protection against a fat-finger
 * overwrite (a mis-call silently replaced a substantial description with a short
 * placeholder, with no revision history to recover from it). `bodyShrinkTripped`
 * is the pure decision function backing updateIssue's guard — pinned here without a
 * DB so the class of destructive edit it targets stays caught.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/issues-engineer.body-shrink-guard.test.ts
 */
import { describe, expect, it } from 'vitest';
import { BODY_SHRINK_GUARD_MIN_LENGTH, bodyShrinkTripped } from './issues-engineer';

describe('bodyShrinkTripped (EI-8497 fat-finger guard)', () => {
  it('trips on the exact reported scenario: a long real body overwritten with a short placeholder', () => {
    const existing = 'A'.repeat(200);
    const result = bodyShrinkTripped(existing, 'placeholder');
    expect(result).toEqual({ shrinkGuardTripped: true, field: 'body', existingLength: 200, newLength: 'placeholder'.length });
  });

  it('does NOT trip when the existing body is short (below the min-length floor)', () => {
    const existing = 'x'.repeat(BODY_SHRINK_GUARD_MIN_LENGTH - 1);
    expect(bodyShrinkTripped(existing, 'y')).toBeNull();
  });

  it('does NOT trip when the new body still retains a reasonable fraction of the old length', () => {
    const existing = 'x'.repeat(100);
    // 20 chars retained = 20% — above the 15% floor.
    expect(bodyShrinkTripped(existing, 'y'.repeat(20))).toBeNull();
  });

  it('trips right at the boundary just below the retain ratio', () => {
    const existing = 'x'.repeat(100);
    // 14 chars retained = 14% — below the 15% floor.
    const result = bodyShrinkTripped(existing, 'y'.repeat(14));
    expect(result?.shrinkGuardTripped).toBe(true);
  });

  it('does NOT trip on a body GROWING (never fires for an expansion)', () => {
    const existing = 'x'.repeat(50);
    expect(bodyShrinkTripped(existing, 'y'.repeat(500))).toBeNull();
  });

  it('does NOT trip when there is no existing body (new issue / null body)', () => {
    expect(bodyShrinkTripped(null, 'anything')).toBeNull();
    expect(bodyShrinkTripped(undefined, 'anything')).toBeNull();
    expect(bodyShrinkTripped('', 'anything')).toBeNull();
  });
});
