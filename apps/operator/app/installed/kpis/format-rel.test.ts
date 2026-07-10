import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatRel } from './format-rel';

describe('formatRel', () => {
  const NOW = new Date('2026-07-10T12:00:00.000Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats sub-minute durations as seconds', () => {
    expect(formatRel(new Date(NOW - 0).toISOString())).toBe('0s ago');
    expect(formatRel(new Date(NOW - 45_000).toISOString())).toBe('45s ago');
  });

  it('formats sub-hour durations as minutes', () => {
    expect(formatRel(new Date(NOW - 65_000).toISOString())).toBe('1m ago');
    expect(formatRel(new Date(NOW - 59 * 60_000).toISOString())).toBe('59m ago');
  });

  it('formats sub-day durations as hours', () => {
    expect(formatRel(new Date(NOW - 3_600_000).toISOString())).toBe('1h ago');
    expect(formatRel(new Date(NOW - 23 * 3_600_000).toISOString())).toBe('23h ago');
  });

  it('formats multi-day durations as days', () => {
    expect(formatRel(new Date(NOW - 86_400_000).toISOString())).toBe('1d ago');
    expect(formatRel(new Date(NOW - 3 * 86_400_000).toISOString())).toBe('3d ago');
  });

  it('clamps a future timestamp to 0s ago instead of going negative', () => {
    expect(formatRel(new Date(NOW + 10_000).toISOString())).toBe('0s ago');
  });

  it('returns an em dash for an invalid timestamp', () => {
    expect(formatRel('not-a-date')).toBe('—');
    expect(formatRel('')).toBe('—');
  });
});
