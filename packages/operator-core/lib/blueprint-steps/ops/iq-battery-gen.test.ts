/**
 * Unit coverage for the `iq-battery:gen` CoordOp wrapper (iq-battery-gen.ts) — the
 * twin of hive-eval-gen, whose op test this mirrors. The shared orchestration
 * (runIqBatteryGen, gen-loop.test.ts) is tested separately and mocked here (no PG /
 * git / LLM); what's under test is THIS file's surface: the workspaceId guard, the
 * discriminated outcome→result MAPPING (each field belongs to exactly the actions
 * that own it), the installSlug default, the deps-seam threading (`_deps ?? {}`),
 * and that the op registers on import.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/blueprint-steps/ops/iq-battery-gen.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above module-scope consts → declare the mock fns
// via vi.hoisted so they exist when the factory runs.
const { registerCoordOp, runIqBatteryGen } = vi.hoisted(() => ({
  registerCoordOp: vi.fn(),
  runIqBatteryGen: vi.fn(),
}));
vi.mock('../../coord-ops/registry.js', () => ({ registerCoordOp }));
vi.mock('../../iq-battery/gen-loop.js', () => ({ runIqBatteryGen }));

import { iqBatteryGenOp, setIqBatteryGenDeps } from './iq-battery-gen';

const ctx = (over: Record<string, unknown> = {}) => ({ workspaceId: 'ws-1', harnessSlug: 'h1', log: vi.fn(), ...over });

afterEach(() => {
  runIqBatteryGen.mockReset();
  setIqBatteryGenDeps(null);
});

describe('iqBatteryGenOp metadata', () => {
  it('declares its name + schemas and is registered on import', () => {
    expect(iqBatteryGenOp.name).toBe('iq-battery:gen');
    expect(iqBatteryGenOp.argsSchema).toBeTruthy();
    expect(iqBatteryGenOp.resultSchema).toBeTruthy();
    expect(registerCoordOp).toHaveBeenCalledWith(iqBatteryGenOp);
  });

  it('argsSchema rejects a non-positive budgetUsd / non-int repeats, accepts the empty cadence payload', () => {
    expect(iqBatteryGenOp.argsSchema.safeParse({}).success).toBe(true);
    expect(iqBatteryGenOp.argsSchema.safeParse({ budgetUsd: -1 }).success).toBe(false);
    expect(iqBatteryGenOp.argsSchema.safeParse({ repeats: 1.5 }).success).toBe(false); // int only
  });
});

describe('iqBatteryGenOp.run — guard + outcome mapping', () => {
  it('throws without a workspaceId (never runs a budgeted battery unscoped)', async () => {
    await expect(iqBatteryGenOp.run({}, ctx({ workspaceId: undefined }) as never)).rejects.toThrow(/workspaceId/);
  });

  it("maps a 'ran' outcome to { action, codeSha, capUsd } — no reason/error", async () => {
    runIqBatteryGen.mockResolvedValue({ action: 'ran', codeSha: 'abc123', capUsd: 5 });
    const r = await iqBatteryGenOp.run({ budgetUsd: 5 }, ctx() as never);
    expect(r).toEqual({ action: 'ran', codeSha: 'abc123', capUsd: 5, reason: undefined, error: undefined });
  });

  it("maps a 'refused' outcome to { action, reason } — no capUsd/error", async () => {
    runIqBatteryGen.mockResolvedValue({ action: 'refused', reason: 'no budgetUsd' });
    const r = await iqBatteryGenOp.run({}, ctx() as never);
    expect(r).toMatchObject({ action: 'refused', reason: 'no budgetUsd' });
    expect(r.capUsd).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  it("maps a 'skipped' outcome (carries codeSha + reason, not capUsd)", async () => {
    runIqBatteryGen.mockResolvedValue({ action: 'skipped', codeSha: 'sha9', reason: 'sha unchanged' });
    const r = await iqBatteryGenOp.run({}, ctx() as never);
    expect(r).toMatchObject({ action: 'skipped', codeSha: 'sha9', reason: 'sha unchanged' });
    expect(r.capUsd).toBeUndefined();
  });

  it("maps a 'failed' outcome to { action, error } — no reason/capUsd", async () => {
    runIqBatteryGen.mockResolvedValue({ action: 'failed', error: 'runner threw' });
    const r = await iqBatteryGenOp.run({}, ctx() as never);
    expect(r).toMatchObject({ action: 'failed', error: 'runner threw' });
    expect(r.reason).toBeUndefined();
    expect(r.capUsd).toBeUndefined();
  });

  it('threads workspaceId + payload into runIqBatteryGen, defaults installSlug to "op", and passes the injected deps', async () => {
    const fakeDeps = { currentCodeSha: async () => 'x' };
    setIqBatteryGenDeps(fakeDeps as never);
    runIqBatteryGen.mockResolvedValue({ action: 'refused', reason: 'r' });
    await iqBatteryGenOp.run({ budgetUsd: 9 }, ctx({ harnessSlug: undefined }) as never);
    expect(runIqBatteryGen).toHaveBeenCalledTimes(1);
    const [arg0, arg1] = runIqBatteryGen.mock.calls[0];
    expect(arg0).toMatchObject({ workspaceId: 'ws-1', installSlug: 'op', payload: { budgetUsd: 9 } });
    expect(arg1).toBe(fakeDeps);
  });

  it('passes an empty deps object ({}) when no deps are injected', async () => {
    runIqBatteryGen.mockResolvedValue({ action: 'refused', reason: 'r' });
    await iqBatteryGenOp.run({}, ctx() as never);
    expect(runIqBatteryGen.mock.calls[0]![1]).toEqual({}); // `_deps ?? {}` fallback
  });

  it('logs the action via ctx.log', async () => {
    runIqBatteryGen.mockResolvedValue({ action: 'ran', codeSha: 's', capUsd: 2 });
    const c = ctx();
    await iqBatteryGenOp.run({ budgetUsd: 2 }, c as never);
    expect(c.log).toHaveBeenCalledWith(expect.stringMatching(/iq-battery:gen action=ran/));
  });
});
