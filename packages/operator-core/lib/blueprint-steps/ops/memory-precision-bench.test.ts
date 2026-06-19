/**
 * Unit coverage for the `memory-precision:bench` CoordOp wrapper
 * (memory-precision-bench.ts). The monitor (runMemoryPrecisionMonitor,
 * memory/bench/precision-monitor.test.ts) is tested separately and mocked here.
 * Under test is THIS file's surface: the workspaceId guard, the ran→metrics vs
 * skip→{skipReason,error} projection (the `'error' in outcome` branch), installSlug
 * default, deps-seam threading (`_deps ?? {}`), and registration.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/blueprint-steps/ops/memory-precision-bench.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { registerCoordOp, runMemoryPrecisionMonitor } = vi.hoisted(() => ({
  registerCoordOp: vi.fn(),
  runMemoryPrecisionMonitor: vi.fn(),
}));
vi.mock('../../coord-ops/registry.js', () => ({ registerCoordOp }));
vi.mock('../../memory/bench/precision-monitor.js', () => ({ runMemoryPrecisionMonitor }));

import { memoryPrecisionBenchOp, setMemoryPrecisionBenchDeps } from './memory-precision-bench';

const ctx = (over: Record<string, unknown> = {}) => ({ workspaceId: 'ws-1', harnessSlug: 'h1', log: vi.fn(), ...over });

afterEach(() => {
  runMemoryPrecisionMonitor.mockReset();
  setMemoryPrecisionBenchDeps(null);
});

describe('memoryPrecisionBenchOp metadata', () => {
  it('declares its name + schemas and is registered on import', () => {
    expect(memoryPrecisionBenchOp.name).toBe('memory-precision:bench');
    expect(memoryPrecisionBenchOp.argsSchema.safeParse({}).success).toBe(true);
    expect(registerCoordOp).toHaveBeenCalledWith(memoryPrecisionBenchOp);
  });
});

describe('memoryPrecisionBenchOp.run', () => {
  it('throws without a workspaceId', async () => {
    await expect(memoryPrecisionBenchOp.run({}, ctx({ workspaceId: undefined }) as never)).rejects.toThrow(/workspaceId/);
  });

  it('a ran outcome projects the metrics (fp@5/r@10/p@5) + rowId', async () => {
    runMemoryPrecisionMonitor.mockResolvedValue({
      ran: true, rowId: 42, metrics: { fpAt5: 0.1, rAt10: 0.8, pAt5: 0.9 },
    });
    const r = await memoryPrecisionBenchOp.run({}, ctx() as never);
    expect(r).toEqual({ ran: true, rowId: 42, fpAt5: 0.1, rAt10: 0.8, pAt5: 0.9 });
  });

  it('a flag-off skip → {ran:false, skipReason} with no error', async () => {
    runMemoryPrecisionMonitor.mockResolvedValue({ ran: false, skipReason: 'flag-off' });
    const r = await memoryPrecisionBenchOp.run({}, ctx() as never);
    expect(r).toEqual({ ran: false, skipReason: 'flag-off', error: undefined });
  });

  it('a failed skip surfaces the error via the `error in outcome` branch', async () => {
    runMemoryPrecisionMonitor.mockResolvedValue({ ran: false, skipReason: 'failed', error: 'bench threw' });
    const r = await memoryPrecisionBenchOp.run({}, ctx() as never);
    expect(r).toEqual({ ran: false, skipReason: 'failed', error: 'bench threw' });
  });

  it('defaults installSlug to "op" and passes injected deps (no payload key)', async () => {
    const fakeDeps = { foo: 1 };
    setMemoryPrecisionBenchDeps(fakeDeps as never);
    runMemoryPrecisionMonitor.mockResolvedValue({ ran: false, skipReason: 'flag-off' });
    await memoryPrecisionBenchOp.run({}, ctx({ harnessSlug: undefined }) as never);
    const [arg0, arg1] = runMemoryPrecisionMonitor.mock.calls[0];
    expect(arg0).toEqual({ workspaceId: 'ws-1', installSlug: 'op' });
    expect(arg1).toBe(fakeDeps);
  });

  it('logs the action via ctx.log', async () => {
    runMemoryPrecisionMonitor.mockResolvedValue({ ran: false, skipReason: 'flag-off' });
    const c = ctx();
    await memoryPrecisionBenchOp.run({}, c as never);
    expect(c.log).toHaveBeenCalledWith(expect.stringMatching(/memory-precision:bench ran=false/));
  });
});
