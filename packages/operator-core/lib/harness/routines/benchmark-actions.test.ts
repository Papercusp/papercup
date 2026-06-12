import { describe, expect, it } from 'vitest';
// Side-effect import registers the cadence action (and exercises the import path).
import { setBenchmarkBatteryRunner } from './benchmark-actions';
import { listSystemActions } from './system-actions';

describe('benchmark-actions registration (consume-edges P-033 / B-12)', () => {
  it('registers system:iq-battery-gen', () => {
    expect(listSystemActions()).toContain('iq-battery-gen');
  });

  it('exposes the battery-runner test seam (mirrors setGymCycleRunner)', () => {
    expect(typeof setBenchmarkBatteryRunner).toBe('function');
    setBenchmarkBatteryRunner(null); // restore-default path is callable
  });
});
