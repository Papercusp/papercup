import { describe, expect, it } from 'vitest';
import { acceptanceBarMeaningUnchanged } from './rubrics';

describe('acceptance BAR amendments with legacy continuity probes', () => {
  it('classifies meaning from the stored BAR-set hash without rebuilding the old snapshot', () => {
    const stored = 'a'.repeat(64);

    expect(acceptanceBarMeaningUnchanged(stored, stored)).toBe(true);
    expect(acceptanceBarMeaningUnchanged(stored, 'b'.repeat(64))).toBe(false);
  });

  it('returns null for non-BAR callers so their canonical fallback remains available', () => {
    expect(acceptanceBarMeaningUnchanged(null, 'a'.repeat(64))).toBeNull();
    expect(acceptanceBarMeaningUnchanged(undefined, undefined)).toBeNull();
  });
});
