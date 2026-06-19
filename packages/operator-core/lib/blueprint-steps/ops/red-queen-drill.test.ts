/**
 * Unit coverage for the `red-queen:drill` CoordOp wrapper (red-queen-drill.ts).
 * The orchestration (runRedQueenDrill, red-queen/run.test.ts) is tested separately
 * and mocked here. Under test is THIS file's surface: the workspaceId guard, the
 * gate-vs-ran projection (a skipped tick carries skipReason/governorReason and
 * leaves every result-derived field undefined via `r?.`; a ran tick spreads the
 * result sub-object — including the nested `cycle.status`), installSlug default,
 * deps-seam threading, and registration.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/blueprint-steps/ops/red-queen-drill.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { registerCoordOp, runRedQueenDrill } = vi.hoisted(() => ({
  registerCoordOp: vi.fn(),
  runRedQueenDrill: vi.fn(),
}));
vi.mock('../../coord-ops/registry.js', () => ({ registerCoordOp }));
vi.mock('../../red-queen/run.js', () => ({ runRedQueenDrill }));

import { redQueenDrillOp, setRedQueenDrillDeps } from './red-queen-drill';

const ctx = (over: Record<string, unknown> = {}) => ({ workspaceId: 'ws-1', harnessSlug: 'h1', log: vi.fn(), ...over });

afterEach(() => {
  runRedQueenDrill.mockReset();
  setRedQueenDrillDeps(null);
});

describe('redQueenDrillOp metadata', () => {
  it('declares its name + schemas and is registered on import', () => {
    expect(redQueenDrillOp.name).toBe('red-queen:drill');
    expect(redQueenDrillOp.argsSchema.safeParse({}).success).toBe(true);
    expect(redQueenDrillOp.resultSchema).toBeTruthy();
    expect(registerCoordOp).toHaveBeenCalledWith(redQueenDrillOp);
  });
});

describe('redQueenDrillOp.run', () => {
  it('throws without a workspaceId', async () => {
    await expect(redQueenDrillOp.run({}, ctx({ workspaceId: undefined }) as never)).rejects.toThrow(/workspaceId/);
  });

  it('a ran tick spreads the result (incl nested cycle.status); no skip fields', async () => {
    runRedQueenDrill.mockResolvedValue({
      ran: true,
      result: { status: 'healed', drillClass: 'cls-1', cycle: { status: 'ok' }, expired: 2 },
    });
    const r = await redQueenDrillOp.run({}, ctx() as never);
    expect(r).toEqual({
      ran: true,
      skipReason: undefined,
      governorReason: undefined,
      status: 'healed',
      drillClass: 'cls-1',
      cycleStatus: 'ok',
      expired: 2,
    });
  });

  it('a flag-off skip leaves all result-derived fields undefined', async () => {
    runRedQueenDrill.mockResolvedValue({ ran: false, skipReason: 'flag-off' });
    const r = await redQueenDrillOp.run({}, ctx() as never);
    expect(r).toMatchObject({ ran: false, skipReason: 'flag-off' });
    expect(r.status).toBeUndefined();
    expect(r.drillClass).toBeUndefined();
    expect(r.cycleStatus).toBeUndefined();
    expect(r.expired).toBeUndefined();
  });

  it('a governor-refused skip carries the governorReason', async () => {
    runRedQueenDrill.mockResolvedValue({ ran: false, skipReason: 'governor-refused', governorReason: 'cap hit' });
    const r = await redQueenDrillOp.run({}, ctx() as never);
    expect(r).toMatchObject({ ran: false, skipReason: 'governor-refused', governorReason: 'cap hit' });
  });

  it('threads payload, defaults installSlug to "op", and passes injected deps', async () => {
    const fakeDeps = { foo: 1 };
    setRedQueenDrillDeps(fakeDeps as never);
    runRedQueenDrill.mockResolvedValue({ ran: false, skipReason: 'flag-off' });
    await redQueenDrillOp.run({ classId: 'c9' }, ctx({ harnessSlug: undefined }) as never);
    const [arg0, arg1] = runRedQueenDrill.mock.calls[0];
    expect(arg0).toMatchObject({ workspaceId: 'ws-1', installSlug: 'op', payload: { classId: 'c9' } });
    expect(arg1).toBe(fakeDeps);
  });

  it('logs the action via ctx.log', async () => {
    runRedQueenDrill.mockResolvedValue({ ran: false, skipReason: 'flag-off' });
    const c = ctx();
    await redQueenDrillOp.run({}, c as never);
    expect(c.log).toHaveBeenCalledWith(expect.stringMatching(/red-queen:drill ran=false/));
  });
});
