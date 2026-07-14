// pot-health-format — the pure helpers PotHealthPane renders ages/counts/ids
// with (moved from the retired PotStatusStrip, WI-4789).
import { describe, expect, it } from 'vitest';
import { compactAge, compactCount, splitLeadingWi } from './pot-health-format';

describe('compactAge', () => {
  const now = Date.parse('2026-07-14T12:00:00Z');

  it('formats seconds / minutes / hours / days compactly', () => {
    expect(compactAge(now - 40_000, now)).toBe('40s');
    expect(compactAge(now - 2 * 60_000, now)).toBe('2m');
    expect(compactAge(now - 3 * 3_600_000, now)).toBe('3h');
    expect(compactAge(now - 72 * 3_600_000, now)).toBe('3d');
  });

  it('is null- and garbage-safe', () => {
    expect(compactAge(null, now)).toBe('—');
    expect(compactAge(undefined, now)).toBe('—');
    expect(compactAge('not-a-date', now)).toBe('—');
  });

  it('clamps a future timestamp to 0s instead of a negative age', () => {
    expect(compactAge(now + 5_000, now)).toBe('0s');
  });
});

describe('compactCount', () => {
  it('renders 1..99 verbatim and caps above', () => {
    expect(compactCount(1)).toBe('1');
    expect(compactCount(99)).toBe('99');
    expect(compactCount(100)).toBe('99+');
    expect(compactCount(437)).toBe('99+');
  });
});

describe('splitLeadingWi', () => {
  it('splits a leading WI-/EI-/F- id off the doing line', () => {
    expect(splitLeadingWi('WI-4662 fleet-spec live e2e verify')).toEqual({
      wi: 'WI-4662',
      rest: 'fleet-spec live e2e verify',
    });
    expect(splitLeadingWi('EI-123 probe')).toEqual({ wi: 'EI-123', rest: 'probe' });
    expect(splitLeadingWi('F-042 ship it')).toEqual({ wi: 'F-042', rest: 'ship it' });
  });

  it('passes through a line with no leading id', () => {
    expect(splitLeadingWi('triaging the backlog')).toEqual({
      wi: null,
      rest: 'triaging the backlog',
    });
  });
});
