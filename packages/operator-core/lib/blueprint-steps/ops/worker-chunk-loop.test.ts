/**
 * Unit coverage for the `worker:chunk-loop` CoordOp wrapper (worker-chunk-loop.ts).
 * The loop execution (runWorkerChunkLoop, worker-chunk-loop-blueprint.test.ts) is
 * tested separately; here a fake runLoop is injected via setWorkerChunkLoopOpDeps,
 * so the op's discriminated ChunkLoopOutcome→result MAPPING is unit-tested without
 * agents/PG/a repo. Under test: the workspaceId + harnessSlug guards (both required —
 * a worker run is doubly scoped), each of the four outcome→result mappings
 * (completed / planning_failed / escalated / aborted), runLoop's (featureId, ctx)
 * call, and registration.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/blueprint-steps/ops/worker-chunk-loop.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { registerCoordOp } = vi.hoisted(() => ({ registerCoordOp: vi.fn() }));
vi.mock('../../coord-ops/registry.js', () => ({ registerCoordOp }));

import { workerChunkLoopOp, setWorkerChunkLoopOpDeps } from './worker-chunk-loop';

const ctx = (over: Record<string, unknown> = {}) => ({ workspaceId: 'ws-1', harnessSlug: 'h1', log: vi.fn(), ...over });
const withLoop = (outcome: unknown) => {
  const runLoop = vi.fn(async () => outcome);
  setWorkerChunkLoopOpDeps({ runLoop } as never);
  return runLoop;
};

afterEach(() => setWorkerChunkLoopOpDeps(null));

describe('workerChunkLoopOp metadata', () => {
  it('declares name + schemas (featureId required) and is registered', () => {
    expect(workerChunkLoopOp.name).toBe('worker:chunk-loop');
    expect(workerChunkLoopOp.argsSchema.safeParse({}).success).toBe(false); // featureId required
    expect(workerChunkLoopOp.argsSchema.safeParse({ featureId: 'F-1' }).success).toBe(true);
    expect(registerCoordOp).toHaveBeenCalledWith(workerChunkLoopOp);
  });
});

describe('workerChunkLoopOp.run — scope guards', () => {
  it('throws without a workspaceId', async () => {
    withLoop({ kind: 'completed', chunksCommitted: 0 });
    await expect(workerChunkLoopOp.run({ featureId: 'F-1' }, ctx({ workspaceId: undefined }) as never)).rejects.toThrow(/workspaceId/);
  });

  it('throws without a harnessSlug (a worker run is doubly scoped)', async () => {
    withLoop({ kind: 'completed', chunksCommitted: 0 });
    await expect(workerChunkLoopOp.run({ featureId: 'F-1' }, ctx({ harnessSlug: undefined }) as never)).rejects.toThrow(/harnessSlug/);
  });
});

describe('workerChunkLoopOp.run — ChunkLoopOutcome mapping', () => {
  it('completed → { outcome, chunksCommitted } and calls runLoop(featureId, ctx)', async () => {
    const runLoop = withLoop({ kind: 'completed', chunksCommitted: 4 });
    const c = ctx();
    const r = await workerChunkLoopOp.run({ featureId: 'F-7' }, c as never);
    expect(r).toEqual({ outcome: 'completed', chunksCommitted: 4 });
    expect(runLoop).toHaveBeenCalledWith('F-7', c);
  });

  it('planning_failed → { outcome, error }', async () => {
    withLoop({ kind: 'planning_failed', error: 'planner parse error' });
    const r = await workerChunkLoopOp.run({ featureId: 'F-1' }, ctx() as never);
    expect(r).toEqual({ outcome: 'planning_failed', error: 'planner parse error' });
  });

  it('escalated → { outcome, escalatedChunkId, reason, strikes }', async () => {
    withLoop({ kind: 'escalated', chunk: { id: 'CH-9' }, reason: 'out of strikes', strikes: 3 });
    const r = await workerChunkLoopOp.run({ featureId: 'F-1' }, ctx() as never);
    expect(r).toEqual({ outcome: 'escalated', escalatedChunkId: 'CH-9', reason: 'out of strikes', strikes: 3 });
  });

  it('aborted → { outcome, reason }', async () => {
    withLoop({ kind: 'aborted', reason: 'lock lost' });
    const r = await workerChunkLoopOp.run({ featureId: 'F-1' }, ctx() as never);
    expect(r).toEqual({ outcome: 'aborted', reason: 'lock lost' });
  });

  it('logs the outcome via ctx.log', async () => {
    withLoop({ kind: 'completed', chunksCommitted: 2 });
    const c = ctx();
    await workerChunkLoopOp.run({ featureId: 'F-3' }, c as never);
    expect(c.log).toHaveBeenCalledWith(expect.stringMatching(/worker:chunk-loop F-3 → completed/));
  });
});
