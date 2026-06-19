/**
 * Unit coverage for the `fleet-ekg:scan` CoordOp wrapper. The runner
 * (runFleetEkgScan, fleet-ekg/run.test.ts) is tested separately and mocked here.
 * Under test: the workspaceId guard, the gate-vs-ran projection (ran spreads the
 * embedding + EKG status fields incl the status enum and findings/attributed/…;
 * skip leaves them undefined), installSlug default, payload + deps threading, and
 * registration.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/blueprint-steps/ops/fleet-ekg-scan.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { registerCoordOp, runFleetEkgScan } = vi.hoisted(() => ({
  registerCoordOp: vi.fn(),
  runFleetEkgScan: vi.fn(),
}));
vi.mock('../../coord-ops/registry.js', () => ({ registerCoordOp }));
vi.mock('../../fleet-ekg/run.js', () => ({ runFleetEkgScan }));

import { fleetEkgScanOp, setFleetEkgScanDeps } from './fleet-ekg-scan';

const ctx = (over: Record<string, unknown> = {}) => ({ workspaceId: 'ws-1', harnessSlug: 'h1', log: vi.fn(), ...over });

afterEach(() => {
  runFleetEkgScan.mockReset();
  setFleetEkgScanDeps(null);
});

describe('fleetEkgScanOp', () => {
  it('declares its name + schemas and is registered on import', () => {
    expect(fleetEkgScanOp.name).toBe('fleet-ekg:scan');
    expect(fleetEkgScanOp.argsSchema.safeParse({}).success).toBe(true);
    expect(registerCoordOp).toHaveBeenCalledWith(fleetEkgScanOp);
  });

  it('throws without a workspaceId', async () => {
    await expect(fleetEkgScanOp.run({}, ctx({ workspaceId: undefined }) as never)).rejects.toThrow(/workspaceId/);
  });

  it('a ran tick spreads the embedding + EKG status fields', async () => {
    runFleetEkgScan.mockResolvedValue({
      ran: true,
      result: {
        embedded: 30, skippedSmall: 2, status: 'ok', windowSessions: 50, baselineSessions: 200,
        findings: 4, attributed: 3, unattributable: 1, alarmed: 1,
      },
    });
    const r = await fleetEkgScanOp.run({}, ctx() as never);
    expect(r).toEqual({
      ran: true, skipReason: undefined, governorReason: undefined,
      embedded: 30, skippedSmall: 2, status: 'ok', windowSessions: 50, baselineSessions: 200,
      findings: 4, attributed: 3, unattributable: 1, alarmed: 1,
    });
  });

  it('carries the insufficient-window status through', async () => {
    runFleetEkgScan.mockResolvedValue({ ran: true, result: { status: 'insufficient-window', windowSessions: 3 } });
    const r = await fleetEkgScanOp.run({}, ctx() as never);
    expect(r.status).toBe('insufficient-window');
    expect(r.windowSessions).toBe(3);
  });

  it('a skip leaves all result-derived fields undefined', async () => {
    runFleetEkgScan.mockResolvedValue({ ran: false, skipReason: 'flag-off' });
    const r = await fleetEkgScanOp.run({}, ctx() as never);
    expect(r).toMatchObject({ ran: false, skipReason: 'flag-off' });
    expect(r.embedded).toBeUndefined();
    expect(r.status).toBeUndefined();
    expect(r.findings).toBeUndefined();
  });

  it('threads payload + injected deps, defaults installSlug to "op"', async () => {
    const fakeDeps = { foo: 1 };
    setFleetEkgScanDeps(fakeDeps as never);
    runFleetEkgScan.mockResolvedValue({ ran: false, skipReason: 'flag-off' });
    await fleetEkgScanOp.run({ k: 1 }, ctx({ harnessSlug: undefined }) as never);
    const [arg0, arg1] = runFleetEkgScan.mock.calls[0];
    expect(arg0).toMatchObject({ workspaceId: 'ws-1', installSlug: 'op', payload: { k: 1 } });
    expect(arg1).toBe(fakeDeps);
  });

  it('logs via ctx.log', async () => {
    runFleetEkgScan.mockResolvedValue({ ran: false, skipReason: 'flag-off' });
    const c = ctx();
    await fleetEkgScanOp.run({}, c as never);
    expect(c.log).toHaveBeenCalledWith(expect.stringContaining('fleet-ekg:scan'));
  });
});
