/**
 * Unit coverage for the `calibration:resolve` CoordOp wrapper. The runner
 * (runCalibrationResolve, calibration/resolve-loop.test.ts) is tested separately and
 * mocked here. Under test: the workspaceId guard, the gate-vs-ran projection (ran
 * spreads matured/resolved/voided/skipped; skip leaves them undefined), installSlug
 * default, payload + deps threading, and registration.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/blueprint-steps/ops/calibration-resolve.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { registerCoordOp, runCalibrationResolve } = vi.hoisted(() => ({
  registerCoordOp: vi.fn(),
  runCalibrationResolve: vi.fn(),
}));
vi.mock('../../coord-ops/registry.js', () => ({ registerCoordOp }));
vi.mock('../../calibration/resolve-loop.js', () => ({ runCalibrationResolve }));

import { calibrationResolveOp, setCalibrationResolveDeps } from './calibration-resolve';

const ctx = (over: Record<string, unknown> = {}) => ({ workspaceId: 'ws-1', harnessSlug: 'h1', log: vi.fn(), ...over });

afterEach(() => {
  runCalibrationResolve.mockReset();
  setCalibrationResolveDeps(null);
});

describe('calibrationResolveOp', () => {
  it('declares its name + schemas and is registered on import', () => {
    expect(calibrationResolveOp.name).toBe('calibration:resolve');
    expect(calibrationResolveOp.argsSchema.safeParse({}).success).toBe(true);
    expect(registerCoordOp).toHaveBeenCalledWith(calibrationResolveOp);
  });

  it('throws without a workspaceId', async () => {
    await expect(calibrationResolveOp.run({}, ctx({ workspaceId: undefined }) as never)).rejects.toThrow(/workspaceId/);
  });

  it('a ran tick spreads matured/resolved/voided/skipped', async () => {
    runCalibrationResolve.mockResolvedValue({
      ran: true, result: { matured: 7, resolved: 5, voided: 1, skipped: 1 },
    });
    const r = await calibrationResolveOp.run({}, ctx() as never);
    expect(r).toEqual({
      ran: true, skipReason: undefined, governorReason: undefined,
      matured: 7, resolved: 5, voided: 1, skipped: 1,
    });
  });

  it('a skip leaves all result-derived fields undefined', async () => {
    runCalibrationResolve.mockResolvedValue({ ran: false, skipReason: 'governor-refused', governorReason: 'cap' });
    const r = await calibrationResolveOp.run({}, ctx() as never);
    expect(r).toMatchObject({ ran: false, skipReason: 'governor-refused', governorReason: 'cap' });
    expect(r.matured).toBeUndefined();
    expect(r.resolved).toBeUndefined();
  });

  it('threads payload + injected deps, defaults installSlug to "op"', async () => {
    const fakeDeps = { foo: 1 };
    setCalibrationResolveDeps(fakeDeps as never);
    runCalibrationResolve.mockResolvedValue({ ran: false, skipReason: 'flag-off' });
    await calibrationResolveOp.run({ k: 1 }, ctx({ harnessSlug: undefined }) as never);
    const [arg0, arg1] = runCalibrationResolve.mock.calls[0];
    expect(arg0).toMatchObject({ workspaceId: 'ws-1', installSlug: 'op', payload: { k: 1 } });
    expect(arg1).toBe(fakeDeps);
  });

  it('logs via ctx.log', async () => {
    runCalibrationResolve.mockResolvedValue({ ran: false, skipReason: 'flag-off' });
    const c = ctx();
    await calibrationResolveOp.run({}, c as never);
    expect(c.log).toHaveBeenCalledWith(expect.stringContaining('calibration:resolve'));
  });
});
