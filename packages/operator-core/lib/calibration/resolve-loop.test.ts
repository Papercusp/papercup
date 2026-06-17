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
    expect(maxPerTickFromPayload({ maxPerTick: 5.9 })).toBe(5);
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

  it('past BOTH gates runs the sweep with the payload limit and returns { ran, result }', async () => {
    // Inject a sweepDeps whose store ops are recording fakes so the real
    // runCalibrationResolveTick runs PG-free; capture the limit it threads.
    let seenLimit: number | undefined = 'unset' as never;
    const sweepDeps = {
      sql: {} as never,
      probes: { fixSurvived: async () => null, planShipped: async () => null, flakeRecurred: async () => null },
      list: async (_sql: unknown, q: { limit?: number }) => {
        seenLimit = q.limit;
        return [];
      },
      nowMs: () => Date.parse('2026-06-12T00:00:00.000Z'),
      log: () => {},
    };
    const out = await runCalibrationResolve(
      { workspaceId: 'ws', installSlug: 'slug', payload: { maxPerTick: 25 } },
      {
        flag: async () => true,
        governorGate: async () => ({ allow: true }) as never,
        sweepDeps: sweepDeps as never,
      },
    );
    expect(out).toEqual({ ran: true, result: { matured: 0, resolved: 0, voided: 0, skipped: 0 } });
    expect(seenLimit).toBe(25); // limit derived from maxPerTickFromPayload(payload)
  });

  it('an absent payload yields an undefined payload-limit, so the tick falls back to its own default (200)', async () => {
    let seenLimit: number | undefined = 'unset' as never;
    const sweepDeps = {
      sql: {} as never,
      probes: { fixSurvived: async () => null, planShipped: async () => null, flakeRecurred: async () => null },
      list: async (_sql: unknown, q: { limit?: number }) => {
        seenLimit = q.limit;
        return [];
      },
      nowMs: () => Date.parse('2026-06-12T00:00:00.000Z'),
      log: () => {},
    };
    const out = await runCalibrationResolve(
      { workspaceId: 'ws', installSlug: 'slug' }, // no payload → maxPerTickFromPayload(undefined) = undefined
      { flag: async () => true, governorGate: async () => ({ allow: true }) as never, sweepDeps: sweepDeps as never },
    );
    expect(out.ran).toBe(true);
    // runCalibrationResolveTick applies its own `opts.limit ?? 200` once the
    // payload limit is undefined — proving the chain reaches the tick's default.
    expect(seenLimit).toBe(200);
  });

  it('never reaches the sweep (or builds default sweepDeps) when the flag is off', async () => {
    // Default sweepDeps would call getOrgPg() + defaultOutcomeProbes — only
    // PAST both gates. With the flag off and NO sweepDeps injected, the absence
    // of a thrown getOrgPg() error proves the default builder stayed lazy.
    const governorGate = vi.fn(async () => ({ allow: true }) as never);
    const out = await runCalibrationResolve(
      { workspaceId: 'ws', installSlug: 'slug', payload: { maxPerTick: 5 } },
      { flag: async () => false, governorGate },
    );
    expect(out).toEqual({ ran: false, skipReason: 'flag-off' });
    expect(governorGate).not.toHaveBeenCalled();
  });

  it('never builds default sweepDeps when the governor refuses', async () => {
    // Same lazy-default proof on the governor branch: a refusal returns before
    // the `deps.sweepDeps ?? (() => getOrgPg()...)` thunk is evaluated.
    const out = await runCalibrationResolve(
      { workspaceId: 'ws', installSlug: 'slug', payload: { maxPerTick: 5 } },
      { flag: async () => true, governorGate: async () => ({ allow: false, reason: 'cooldown' }) as never },
    );
    expect(out).toEqual({ ran: false, skipReason: 'governor-refused', governorReason: 'cooldown' });
  });
});
