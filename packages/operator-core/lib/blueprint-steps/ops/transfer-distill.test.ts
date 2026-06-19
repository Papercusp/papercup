/**
 * Unit coverage for the `transfer:distill` CoordOp wrapper (transfer-distill.ts).
 * The orchestration (runTransferDistill, transfer/run.test.ts) is tested separately
 * and mocked here. Under test is THIS file's surface: the workspaceId guard, the
 * gate-vs-ran projection (a skipped tick leaves every result field undefined via
 * `r?.`; a ran tick spreads transcriptsScanned/lessons/tested/passed/retired/…),
 * installSlug default, deps-seam threading, and registration.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/blueprint-steps/ops/transfer-distill.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { registerCoordOp, runTransferDistill } = vi.hoisted(() => ({
  registerCoordOp: vi.fn(),
  runTransferDistill: vi.fn(),
}));
vi.mock('../../coord-ops/registry.js', () => ({ registerCoordOp }));
vi.mock('../../transfer/run.js', () => ({ runTransferDistill }));

import { transferDistillOp, setTransferDistillDeps } from './transfer-distill';

const ctx = (over: Record<string, unknown> = {}) => ({ workspaceId: 'ws-1', harnessSlug: 'h1', log: vi.fn(), ...over });

afterEach(() => {
  runTransferDistill.mockReset();
  setTransferDistillDeps(null);
});

describe('transferDistillOp metadata', () => {
  it('declares its name + schemas and is registered on import', () => {
    expect(transferDistillOp.name).toBe('transfer:distill');
    expect(transferDistillOp.argsSchema.safeParse({}).success).toBe(true);
    expect(transferDistillOp.argsSchema.safeParse({ maxTestsPerTick: -1 }).success).toBe(false); // nonnegative int
    expect(registerCoordOp).toHaveBeenCalledWith(transferDistillOp);
  });
});

describe('transferDistillOp.run', () => {
  it('throws without a workspaceId', async () => {
    await expect(transferDistillOp.run({}, ctx({ workspaceId: undefined }) as never)).rejects.toThrow(/workspaceId/);
  });

  it('a ran tick spreads the distill result; no skip fields', async () => {
    runTransferDistill.mockResolvedValue({
      ran: true,
      result: {
        transcriptsScanned: 12, lessonsDistilled: 6, lessonsAdmitted: 4,
        tested: 5, passed: 3, failed: 1, retired: 1, errors: 0,
        testingSkippedNoReplay: false, costUsd: 2.5,
      },
    });
    const r = await transferDistillOp.run({}, ctx() as never);
    expect(r).toEqual({
      ran: true, skipReason: undefined, governorReason: undefined,
      transcriptsScanned: 12, lessonsDistilled: 6, lessonsAdmitted: 4,
      tested: 5, passed: 3, failed: 1, retired: 1, errors: 0,
      testingSkippedNoReplay: false, costUsd: 2.5,
    });
  });

  it('a skip leaves all result-derived fields undefined', async () => {
    runTransferDistill.mockResolvedValue({ ran: false, skipReason: 'flag-off' });
    const r = await transferDistillOp.run({}, ctx() as never);
    expect(r).toMatchObject({ ran: false, skipReason: 'flag-off' });
    expect(r.transcriptsScanned).toBeUndefined();
    expect(r.passed).toBeUndefined();
    expect(r.costUsd).toBeUndefined();
  });

  it('threads payload, defaults installSlug to "op", and passes injected deps', async () => {
    const fakeDeps = { foo: 1 };
    setTransferDistillDeps(fakeDeps as never);
    runTransferDistill.mockResolvedValue({ ran: false, skipReason: 'flag-off' });
    await transferDistillOp.run({ windowHours: 12 }, ctx({ harnessSlug: undefined }) as never);
    const [arg0, arg1] = runTransferDistill.mock.calls[0];
    expect(arg0).toMatchObject({ workspaceId: 'ws-1', installSlug: 'op', payload: { windowHours: 12 } });
    expect(arg1).toBe(fakeDeps);
  });

  it('logs the action via ctx.log', async () => {
    runTransferDistill.mockResolvedValue({ ran: false, skipReason: 'flag-off' });
    const c = ctx();
    await transferDistillOp.run({}, c as never);
    expect(c.log).toHaveBeenCalledWith(expect.stringMatching(/transfer:distill ran=false/));
  });
});
