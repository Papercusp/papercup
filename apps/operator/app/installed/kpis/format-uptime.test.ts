import { describe, expect, it } from 'vitest';
import { formatUptime } from './format-uptime';

describe('formatUptime', () => {
  it('formats sub-minute durations as seconds', () => {
    expect(formatUptime(0)).toBe('0s');
    expect(formatUptime(45)).toBe('45s');
  });

  it('formats sub-hour durations as minutes + seconds', () => {
    expect(formatUptime(65)).toBe('1m 5s');
    expect(formatUptime(3599)).toBe('59m 59s');
  });

  it('formats sub-day durations as hours + minutes', () => {
    expect(formatUptime(3600)).toBe('1h 0m');
    expect(formatUptime(4 * 3600 + 2 * 60)).toBe('4h 2m');
  });

  it('formats multi-day durations as days + hours', () => {
    expect(formatUptime(86_400)).toBe('1d 0h');
    expect(formatUptime(3 * 86_400 + 4 * 3600 + 12 * 60)).toBe('3d 4h');
  });

  it('clamps negative input to 0s', () => {
    expect(formatUptime(-5)).toBe('0s');
  });
});
