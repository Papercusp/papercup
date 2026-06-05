/**
 * Tests for the battery-aware pause policy.
 *
 * Step B2 (Tier-3 follow-up arc).
 */
import { describe, it, expect } from 'vitest';
import { shouldRun, readLinuxBattery } from './battery-policy';

describe('shouldRun', () => {
  it('returns "run" when no battery reading available', () => {
    expect(shouldRun({ reading: null, envOverride: null })).toBe('run');
  });

  it('returns "run" when battery is Charging', () => {
    expect(shouldRun({
      reading: { status: 'Charging', capacity: 20 },
      envOverride: null,
    })).toBe('run');
  });

  it('returns "run" when battery is Full', () => {
    expect(shouldRun({
      reading: { status: 'Full', capacity: 100 },
      envOverride: null,
    })).toBe('run');
  });

  it('returns "pause" when Discharging AND below threshold', () => {
    expect(shouldRun({
      reading: { status: 'Discharging', capacity: 15 },
      minPct: 30,
      envOverride: null,
    })).toBe('pause');
  });

  it('returns "run" when Discharging AND at or above threshold', () => {
    expect(shouldRun({
      reading: { status: 'Discharging', capacity: 45 },
      minPct: 30,
      envOverride: null,
    })).toBe('run');
    expect(shouldRun({
      reading: { status: 'Discharging', capacity: 30 },
      minPct: 30,
      envOverride: null,
    })).toBe('run');
  });

  it('returns "run" when capacity is unknown (null)', () => {
    expect(shouldRun({
      reading: { status: 'Discharging', capacity: null },
      envOverride: null,
    })).toBe('run');
  });

  it('env override "force_pause" wins over all other inputs', () => {
    expect(shouldRun({
      reading: { status: 'Charging', capacity: 100 },
      envOverride: 'force_pause',
    })).toBe('pause');
  });

  it('env override "always_run" wins over low-battery state', () => {
    expect(shouldRun({
      reading: { status: 'Discharging', capacity: 5 },
      envOverride: 'always_run',
    })).toBe('run');
  });

  it('custom minPct threshold is honored', () => {
    expect(shouldRun({
      reading: { status: 'Discharging', capacity: 40 },
      minPct: 50,
      envOverride: null,
    })).toBe('pause');
  });
});

describe('readLinuxBattery', () => {
  it('returns null OR a valid reading shape (depends on host)', () => {
    const r = readLinuxBattery();
    if (r === null) return; // server host without battery
    expect(typeof r.status).toBe('string');
    expect(r.capacity === null || (typeof r.capacity === 'number' && r.capacity >= 0 && r.capacity <= 100)).toBe(true);
  });
});
