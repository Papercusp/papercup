/**
 * Unit coverage for the `regret:mine` CoordOp wrapper (regret-mine.ts). The
 * orchestration (runRegretMine, replay/regret/run-mine.test.ts) is tested
 * separately and mocked here. Under test is THIS file's surface: the workspaceId
 * guard, the gate-vs-ran projection (a skipped tick leaves every result field
 * undefined via `r?.`; a ran tick spreads scanned/mined/replayed/filed/…),
 * installSlug default, deps-seam threading, and registration.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/blueprint-steps/ops/regret-mine.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { registerCoordOp, runRegretMine } = vi.hoisted(() => ({
  registerCoordOp: vi.fn(),
  runRegretMine: vi.fn(),
}));
vi.mock('../../coord-ops/registry.js', () => ({ registerCoordOp }));
vi.mock('../../replay/regret/run-mine.js', () => ({ runRegretMine }));

import { regretMineOp, setRegretMineDeps } from './regret-mine';

const ctx = (over: Record<string, unknown> = {}) => ({ workspaceId: 'ws-1', harnessSlug: 'h1', log: vi.fn(), ...over });

afterEach(() => {
  runRegretMine.mockReset();
  setRegretMineDeps(null);
});

describe('regretMineOp metadata', () => {
  it('declares its name + schemas and is registered on import', () => {
    expect(regretMineOp.name).toBe('regret:mine');
    expect(regretMineOp.argsSchema.safeParse({}).success).toBe(true);
    expect(regretMineOp.argsSchema.safeParse({ windowDays: 1.5 }).success).toBe(false); // int only
    expect(registerCoordOp).toHaveBeenCalledWith(regretMineOp);
  });
});

describe('regretMineOp.run', () => {
  it('throws without a workspaceId', async () => {
    await expect(regretMineOp.run({}, ctx({ workspaceId: undefined }) as never)).rejects.toThrow(/workspaceId/);
  });

  it('a ran tick spreads the mining result; no skip fields', async () => {
    runRegretMine.mockResolvedValue({
      ran: true,
      result: {
        scanned: 20, candidates: 8, mined: 5, skippedKnown: 2,
        replayed: 3, replayCostUsd: 1.25, filed: ['rep-1', 'rep-2'], declined: 1,
      },
    });
    const r = await regretMineOp.run({}, ctx() as never);
    expect(r).toEqual({
      ran: true, skipReason: undefined, governorReason: undefined,
      scanned: 20, candidates: 8, mined: 5, skippedKnown: 2,
      replayed: 3, replayCostUsd: 1.25, filed: ['rep-1', 'rep-2'], declined: 1,
    });
  });

  it('a skip leaves all result-derived fields undefined', async () => {
    runRegretMine.mockResolvedValue({ ran: false, skipReason: 'governor-refused', governorReason: 'spend cap' });
    const r = await regretMineOp.run({}, ctx() as never);
    expect(r).toMatchObject({ ran: false, skipReason: 'governor-refused', governorReason: 'spend cap' });
    expect(r.scanned).toBeUndefined();
    expect(r.filed).toBeUndefined();
    expect(r.replayCostUsd).toBeUndefined();
  });

  it('threads payload, defaults installSlug to "op", and passes injected deps', async () => {
    const fakeDeps = { foo: 1 };
    setRegretMineDeps(fakeDeps as never);
    runRegretMine.mockResolvedValue({ ran: false, skipReason: 'flag-off' });
    await regretMineOp.run({ windowDays: 7 }, ctx({ harnessSlug: undefined }) as never);
    const [arg0, arg1] = runRegretMine.mock.calls[0];
    expect(arg0).toMatchObject({ workspaceId: 'ws-1', installSlug: 'op', payload: { windowDays: 7 } });
    expect(arg1).toBe(fakeDeps);
  });

  it('logs the action via ctx.log (with result counts when it ran)', async () => {
    runRegretMine.mockResolvedValue({ ran: true, result: { scanned: 1, mined: 0, replayed: 0, filed: [] } });
    const c = ctx();
    await regretMineOp.run({}, c as never);
    expect(c.log).toHaveBeenCalledWith(expect.stringMatching(/regret:mine ran=true/));
  });
});
