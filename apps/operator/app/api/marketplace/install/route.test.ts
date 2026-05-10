/**
 * Slug-collision recovery: when the user-requested project name already
 * exists, the install route returns a suggested next-free name in the
 * 409 response so the UI can offer one-click recovery. Tests pin the
 * suggester logic; the route's filesystem glue is exercised by the
 * sheets E2E smoke.
 */
import { describe, it, expect } from 'vitest';
import { suggestNextFreeName } from './route';

describe('suggestNextFreeName', () => {
  const allTaken = (set: Set<string>) => (c: string) => set.has(c);

  it('returns base-2 when only base is taken', () => {
    expect(suggestNextFreeName('sheets', allTaken(new Set(['sheets-1'])))).toBe('sheets-2');
    expect(suggestNextFreeName('sheets', allTaken(new Set([])))).toBe('sheets-2');
  });

  it('skips taken suffixes', () => {
    const taken = new Set(['sheets-2', 'sheets-3', 'sheets-5']);
    expect(suggestNextFreeName('sheets', allTaken(taken))).toBe('sheets-4');
  });

  it('returns base-N where N is the first free in 2..ceiling', () => {
    const taken = new Set(['sheets-2', 'sheets-3', 'sheets-4', 'sheets-5', 'sheets-6']);
    expect(suggestNextFreeName('sheets', allTaken(taken))).toBe('sheets-7');
  });

  it('returns null when every candidate up to ceiling is taken', () => {
    const taken = new Set(Array.from({ length: 98 }, (_, i) => `sheets-${i + 2}`));
    expect(suggestNextFreeName('sheets', allTaken(taken))).toBe(null);
  });

  it('respects custom ceiling', () => {
    const taken = new Set(['x-2', 'x-3']);
    expect(suggestNextFreeName('x', allTaken(taken), 4)).toBe('x-4');
    expect(suggestNextFreeName('x', allTaken(taken), 3)).toBe(null);
  });

  it('handles names that already contain dashes', () => {
    expect(suggestNextFreeName('sheets-fork', allTaken(new Set([])))).toBe('sheets-fork-2');
  });
});
