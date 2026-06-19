/**
 * Unit coverage for the `graduation:scan` CoordOp wrapper. The runner
 * (runGraduationScan, graduation/scan-loop.test.ts) is tested separately and mocked
 * here. Under test: the workspaceId guard, the gate-vs-ran projection (ran spreads
 * classes + the eligible/filed arrays + declined; skip leaves them undefined),
 * installSlug default, payload + deps threading, and registration.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/blueprint-steps/ops/graduation-scan.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { registerCoordOp, runGraduationScan } = vi.hoisted(() => ({
  registerCoordOp: vi.fn(),
  runGraduationScan: vi.fn(),
}));
vi.mock('../../coord-ops/registry.js', () => ({ registerCoordOp }));
vi.mock('../../graduation/scan-loop.js', () => ({ runGraduationScan }));

import { graduationScanOp, setGraduationScanDeps } from './graduation-scan';

const ctx = (over: Record<string, unknown> = {}) => ({ workspaceId: 'ws-1', harnessSlug: 'h1', log: vi.fn(), ...over });

afterEach(() => {
  runGraduationScan.mockReset();
  setGraduationScanDeps(null);
});

describe('graduationScanOp', () => {
  it('declares its name + schemas and is registered on import', () => {
    expect(graduationScanOp.name).toBe('graduation:scan');
    expect(graduationScanOp.argsSchema.safeParse({}).success).toBe(true);
    expect(registerCoordOp).toHaveBeenCalledWith(graduationScanOp);
  });

  it('throws without a workspaceId', async () => {
    await expect(graduationScanOp.run({}, ctx({ workspaceId: undefined }) as never)).rejects.toThrow(/workspaceId/);
  });

  it('a ran tick spreads classes + the eligible/filed arrays + declined', async () => {
    runGraduationScan.mockResolvedValue({
      ran: true, result: { classes: 5, eligible: ['a', 'b'], filed: ['F-1'], declined: 1 },
    });
    const r = await graduationScanOp.run({}, ctx() as never);
    expect(r).toEqual({
      ran: true, skipReason: undefined, governorReason: undefined,
      classes: 5, eligible: ['a', 'b'], filed: ['F-1'], declined: 1,
    });
  });

  it('a skip leaves all result-derived fields undefined', async () => {
    runGraduationScan.mockResolvedValue({ ran: false, skipReason: 'flag-off' });
    const r = await graduationScanOp.run({}, ctx() as never);
    expect(r).toMatchObject({ ran: false, skipReason: 'flag-off' });
    expect(r.classes).toBeUndefined();
    expect(r.eligible).toBeUndefined();
    expect(r.filed).toBeUndefined();
  });

  it('threads payload + injected deps, defaults installSlug to "op"', async () => {
    const fakeDeps = { foo: 1 };
    setGraduationScanDeps(fakeDeps as never);
    runGraduationScan.mockResolvedValue({ ran: false, skipReason: 'flag-off' });
    await graduationScanOp.run({ some: 'knob' }, ctx({ harnessSlug: undefined }) as never);
    const [arg0, arg1] = runGraduationScan.mock.calls[0];
    expect(arg0).toMatchObject({ workspaceId: 'ws-1', installSlug: 'op', payload: { some: 'knob' } });
    expect(arg1).toBe(fakeDeps);
  });

  it('logs via ctx.log', async () => {
    runGraduationScan.mockResolvedValue({ ran: false, skipReason: 'flag-off' });
    const c = ctx();
    await graduationScanOp.run({}, c as never);
    expect(c.log).toHaveBeenCalledWith(expect.stringContaining('graduation:scan'));
  });
});
