import { describe, it, expect, vi } from 'vitest';
import { maxPerTickFromPayload, runCalibrationResolve } from './resolve-loop';

describe('maxPerTickFromPayload', () => {
  it('returns undefined for non-object / missing payloads', () => {
    expect(maxPerTickFromPayload(undefined)).toBeUndefined();
    expect(maxPerTickFromPayload(null)).toBeUndefined();
    expect(maxPerTickFromPayload(42)).toBeUndefined();
    expect(maxPerTickFromPayload('x')).toBeUndefined();
    expect(maxPerTickFromPayload({})).toBeUndefined();
    expect(maxPerTickFromPayload({ other: 5 })).toBeUndefined();
  });

  it('returns a positive integer maxPerTick', () => {
    expect(maxPerTickFromPayload({ maxPerTick: 50 })).toBe(50);
  });

  it('floors a fractional maxPerTick', () => {
    expect(maxPerTickFromPayload({ maxPerTick: 7.9 })).toBe(7);
  });

  it('rejects non-positive / non-finite values', () => {
    expect(maxPerTickFromPayload({ maxPerTick: 0 })).toBeUndefined();
    expect(maxPerTickFromPayload({ maxPerTick: -3 })).toBeUndefined();
    expect(maxPerTickFromPayload({ maxPerTick: Number.NaN })).toBeUndefined();
    expect(maxPerTickFromPayload({ maxPerTick: Infinity })).toBeUndefined();
    expect(maxPerTickFromPayload({ maxPerTick: '5' })).toBeUndefined();
  });
});

describe('runCalibrationResolve gating', () => {
  it('skips with flag-off when the calibration flag is disabled', async () => {
    const governorGate = vi.fn();
    const out = await runCalibrationResolve(
      { workspaceId: 'ws', installSlug: 'slug' },
      { flag: async () => false, governorGate },
    );
    expect(out).toEqual({ ran: false, skipReason: 'flag-off' });
    expect(governorGate).not.toHaveBeenCalled(); // short-circuits before the governor
  });

  it('skips with governor-refused (carrying the reason) when the gate denies', async () => {
    const out = await runCalibrationResolve(
      { workspaceId: 'ws', installSlug: 'slug' },
      {
        flag: async () => true,
        governorGate: async () => ({ allow: false, reason: 'budget exhausted' }) as never,
      },
    );
    expect(out).toEqual({
      ran: false,
      skipReason: 'governor-refused',
      governorReason: 'budget exhausted',
    });
  });

  it('passes the install slug to the flag check', async () => {
    const flag = vi.fn(async () => false);
    await runCalibrationResolve({ workspaceId: 'ws', installSlug: 'my-install' }, { flag });
    expect(flag).toHaveBeenCalledWith('my-install');
  });
});
