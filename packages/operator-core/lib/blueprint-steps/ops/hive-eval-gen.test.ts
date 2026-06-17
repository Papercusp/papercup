/**
 * Unit coverage for the `hive-eval:gen` CoordOp wrapper (hive-eval-gen.ts).
 *
 * The op delegates the orchestration to runHiveEvalGen (mocked here — no PG /
 * git / LLM); what's under test is THIS file's surface: the workspaceId guard,
 * the discriminated outcome→result MAPPING (a field belongs to exactly the
 * actions that own it), the installSlug default, and that the op is registered.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above module-scope consts → declare the mock
// fns via vi.hoisted so they exist when the factory runs.
const { registerCoordOp, runHiveEvalGen } = vi.hoisted(() => ({
  registerCoordOp: vi.fn(),
  runHiveEvalGen: vi.fn(),
}));
vi.mock('../../coord-ops/registry.js', () => ({ registerCoordOp }));
vi.mock('../../hive-eval/gen-loop.js', () => ({ runHiveEvalGen }));

import { hiveEvalGenOp, setHiveEvalGenDeps } from './hive-eval-gen';

const ctx = (over: Record<string, unknown> = {}) => ({ workspaceId: 'ws-1', harnessSlug: 'h1', log: vi.fn(), ...over });

afterEach(() => {
  runHiveEvalGen.mockReset();
  setHiveEvalGenDeps(null);
});

describe('hiveEvalGenOp metadata', () => {
  it('declares its name + schemas and is registered on import', () => {
    expect(hiveEvalGenOp.name).toBe('hive-eval:gen');
    expect(hiveEvalGenOp.argsSchema).toBeTruthy();
    expect(hiveEvalGenOp.resultSchema).toBeTruthy();
    expect(registerCoordOp).toHaveBeenCalledWith(hiveEvalGenOp);
  });

  it('argsSchema rejects a non-positive budgetUsd and accepts the empty cadence payload', () => {
    expect(hiveEvalGenOp.argsSchema.safeParse({}).success).toBe(true);
    expect(hiveEvalGenOp.argsSchema.safeParse({ budgetUsd: -1 }).success).toBe(false);
    expect(hiveEvalGenOp.argsSchema.safeParse({ repeats: 1.5 }).success).toBe(false); // int only
  });
});

describe('hiveEvalGenOp.run — guard + outcome mapping', () => {
  it('throws without a workspaceId (never runs a whole-Hive eval unscoped)', async () => {
    await expect(hiveEvalGenOp.run({}, ctx({ workspaceId: undefined }) as never)).rejects.toThrow(/workspaceId/);
  });

  it("maps a 'ran' outcome to { action, codeSha, capUsd } — no reason/error", async () => {
    runHiveEvalGen.mockResolvedValue({ action: 'ran', codeSha: 'abc123', capUsd: 5 });
    const r = await hiveEvalGenOp.run({ budgetUsd: 5 }, ctx() as never);
    expect(r).toEqual({ action: 'ran', codeSha: 'abc123', capUsd: 5, reason: undefined, error: undefined });
  });

  it("maps a 'refused' outcome to { action, reason } — no capUsd/error", async () => {
    runHiveEvalGen.mockResolvedValue({ action: 'refused', reason: 'no budgetUsd' });
    const r = await hiveEvalGenOp.run({}, ctx() as never);
    expect(r).toMatchObject({ action: 'refused', reason: 'no budgetUsd' });
    expect(r.capUsd).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  it("maps a 'skipped' outcome (carries codeSha + reason, not capUsd)", async () => {
    runHiveEvalGen.mockResolvedValue({ action: 'skipped', codeSha: 'sha9', reason: 'sha unchanged' });
    const r = await hiveEvalGenOp.run({}, ctx() as never);
    expect(r).toMatchObject({ action: 'skipped', codeSha: 'sha9', reason: 'sha unchanged' });
    expect(r.capUsd).toBeUndefined();
  });

  it("maps a 'failed' outcome to { action, error } — no reason/capUsd", async () => {
    runHiveEvalGen.mockResolvedValue({ action: 'failed', error: 'runner threw' });
    const r = await hiveEvalGenOp.run({}, ctx() as never);
    expect(r).toMatchObject({ action: 'failed', error: 'runner threw' });
    expect(r.reason).toBeUndefined();
    expect(r.capUsd).toBeUndefined();
  });

  it('threads workspaceId + payload + injected deps into runHiveEvalGen and defaults installSlug to "op"', async () => {
    const fakeDeps = { currentCodeSha: async () => 'x' };
    setHiveEvalGenDeps(fakeDeps as never);
    runHiveEvalGen.mockResolvedValue({ action: 'refused', reason: 'r' });
    await hiveEvalGenOp.run({ budgetUsd: 9 }, ctx({ harnessSlug: undefined }) as never);
    expect(runHiveEvalGen).toHaveBeenCalledTimes(1);
    const [arg0, arg1] = runHiveEvalGen.mock.calls[0];
    expect(arg0).toMatchObject({ workspaceId: 'ws-1', installSlug: 'op', payload: { budgetUsd: 9 } });
    expect(arg1).toBe(fakeDeps);
  });

  it('logs the action via ctx.log', async () => {
    runHiveEvalGen.mockResolvedValue({ action: 'ran', codeSha: 's', capUsd: 2 });
    const c = ctx();
    await hiveEvalGenOp.run({ budgetUsd: 2 }, c as never);
    expect(c.log).toHaveBeenCalledWith(expect.stringMatching(/hive-eval:gen action=ran/));
  });
});
