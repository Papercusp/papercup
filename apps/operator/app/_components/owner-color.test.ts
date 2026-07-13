/**
 * owner-color — deterministic per-user color (shared-hive-collaboration P-003).
 */
import { describe, it, expect } from 'vitest';
import { ownerHue, ownerColor } from './owner-color';

describe('ownerHue / ownerColor', () => {
  it('is deterministic + case/space-insensitive for the same identity', () => {
    // The point of these three is that ONE identity, written three ways, lands on
    // ONE hue — so the spellings must differ only in case/whitespace, never in the
    // identity itself.
    expect(ownerHue('dev@x.com')).toBe(ownerHue('dev@x.com'));
    expect(ownerHue('Dev@X.com ')).toBe(ownerHue('dev@x.com'));
    expect(ownerColor('dev@x.com')).toBe(ownerColor('DEV@X.COM'));
  });

  it('spreads distinct identities across the wheel (no trivial collision)', () => {
    const hues = ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com'].map(ownerHue);
    expect(new Set(hues).size).toBeGreaterThan(1);
    hues.forEach((h) => expect(h).toBeGreaterThanOrEqual(0));
    hues.forEach((h) => expect(h).toBeLessThan(360));
  });

  it('blank / null identity → neutral grey, never a vivid hue', () => {
    expect(ownerColor('')).toBe('hsl(0 0% 60%)');
    expect(ownerColor(null)).toBe('hsl(0 0% 60%)');
    expect(ownerColor(undefined)).toBe('hsl(0 0% 60%)');
    expect(ownerHue('')).toBe(0);
  });

  it('honors saturation/lightness/alpha opts', () => {
    const c = ownerColor('avi@x.com', { saturation: 50, lightness: 40, alpha: 0.5 });
    expect(c).toMatch(/^hsl\(\d{1,3} 50% 40% \/ 0\.5\)$/);
    // a non-blank identity at full alpha omits the alpha slash form
    expect(ownerColor('avi@x.com')).toMatch(/^hsl\(\d{1,3} 60% 60%\)$/);
  });
});
