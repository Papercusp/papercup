/**
 * Unit coverage for the `deferral-interest:refit` CoordOp wrapper. The runner
 * (runDeferralInterestRefitGated, deferral-interest/refit-loop.test.ts) is tested
 * separately and mocked here. Under test: the workspaceId guard, the gate-vs-ran
 * projection (skip leaves every `result?.`-derived field undefined; ran spreads
 * candidates/deferrals/decided/stillOpen/globalRatePerWeek/weak), installSlug
 * default, deps-seam threading (no payload — the refit is a full-corpus recompute),
 * and registration.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/blueprint-steps/ops/deferral-interest-refit.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { registerCoordOp, runDeferralInterestRefitGated } = vi.hoisted(() => ({
  registerCoordOp: vi.fn(),
  runDeferralInterestRefitGated: vi.fn(),
}));
vi.mock('../../coord-ops/registry.js', () => ({ registerCoordOp }));
vi.mock('../../deferral-interest/refit-loop.js', () => ({ runDeferralInterestRefitGated }));

import { deferralInterestRefitOp, setDeferralRefitGateDeps } from './deferral-interest-refit';

const ctx = (over: Record<string, unknown> = {}) => ({ workspaceId: 'ws-1', harnessSlug: 'h1', log: vi.fn(), ...over });

afterEach(() => {
  runDeferralInterestRefitGated.mockReset();
  setDeferralRefitGateDeps(null);
});

describe('deferralInterestRefitOp', () => {
  it('declares its name + schemas and is registered on import', () => {
    expect(deferralInterestRefitOp.name).toBe('deferral-interest:refit');
    expect(deferralInterestRefitOp.argsSchema.safeParse({}).success).toBe(true);
    expect(registerCoordOp).toHaveBeenCalledWith(deferralInterestRefitOp);
  });

  it('throws without a workspaceId', async () => {
    await expect(deferralInterestRefitOp.run({}, ctx({ workspaceId: undefined }) as never)).rejects.toThrow(/workspaceId/);
  });

  it('a ran tick spreads the refit result (incl the weak flag)', async () => {
    runDeferralInterestRefitGated.mockResolvedValue({
      ran: true,
      result: { candidates: 10, deferrals: 4, decided: 3, stillOpen: 1, globalRatePerWeek: 2.5, weak: true },
    });
    const r = await deferralInterestRefitOp.run({}, ctx() as never);
    expect(r).toEqual({
      ran: true, skipReason: undefined, governorReason: undefined,
      candidates: 10, deferrals: 4, decided: 3, stillOpen: 1, globalRatePerWeek: 2.5, weak: true,
    });
  });

  it('a skip leaves all result-derived fields undefined', async () => {
    runDeferralInterestRefitGated.mockResolvedValue({ ran: false, skipReason: 'governor-refused', governorReason: 'cap' });
    const r = await deferralInterestRefitOp.run({}, ctx() as never);
    expect(r).toMatchObject({ ran: false, skipReason: 'governor-refused', governorReason: 'cap' });
    expect(r.candidates).toBeUndefined();
    expect(r.weak).toBeUndefined();
  });

  it('threads scope (no payload) + injected deps, defaults installSlug to "op"', async () => {
    const fakeDeps = { foo: 1 };
    setDeferralRefitGateDeps(fakeDeps as never);
    runDeferralInterestRefitGated.mockResolvedValue({ ran: false, skipReason: 'flag-off' });
    await deferralInterestRefitOp.run({}, ctx({ harnessSlug: undefined }) as never);
    const [arg0, arg1] = runDeferralInterestRefitGated.mock.calls[0];
    expect(arg0).toEqual({ workspaceId: 'ws-1', installSlug: 'op' }); // no payload key
    expect(arg1).toBe(fakeDeps);
  });

  it('logs via ctx.log', async () => {
    runDeferralInterestRefitGated.mockResolvedValue({ ran: false, skipReason: 'flag-off' });
    const c = ctx();
    await deferralInterestRefitOp.run({}, c as never);
    expect(c.log).toHaveBeenCalledWith(expect.stringContaining('deferral-interest:refit'));
  });
});
