import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { negativeSpaceScanOp, setNegativeSpaceScanDeps } from './negative-space-scan';
import { runNegativeSpaceMine } from '../../negative-space/mine.js';

// Unit: runNegativeSpaceMine has its own suite; this pins the deterministic-step
// WRAPPER — workspaceId guard, installSlug default, deps seam, outcome→result
// flattening (deterministic-blueprints-migration P-010, D-004).
vi.mock('../../coord-ops/registry.js', () => ({ registerCoordOp: vi.fn() }));
vi.mock('../../negative-space/mine.js', () => ({ runNegativeSpaceMine: vi.fn() }));

const mockRun = vi.mocked(runNegativeSpaceMine);
const run = (a: Record<string, unknown>, ctx: Record<string, unknown>) =>
  (negativeSpaceScanOp.run as (a: unknown, c: unknown) => Promise<Record<string, unknown>>)(a, ctx);

describe('negative-space:scan deterministic step op', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRun.mockResolvedValue({
      ran: true,
      result: { scanned: 7, demandEntries: 3, filed: ['q1'], declined: 0 },
    } as unknown as Awaited<ReturnType<typeof runNegativeSpaceMine>>);
  });
  afterEach(() => setNegativeSpaceScanDeps(null));

  it('throws when ctx.workspaceId is absent', async () => {
    await expect(run({}, {})).rejects.toThrow(/requires ctx.workspaceId/);
  });

  it('defaults installSlug to "op" and forwards args as payload', async () => {
    await run({ minMisses: 5 }, { workspaceId: 'ws-1' });
    expect(mockRun).toHaveBeenCalledWith({ workspaceId: 'ws-1', installSlug: 'op', payload: { minMisses: 5 } }, {});
  });

  it('threads injected deps through the set-seam', async () => {
    const deps = { governorGate: async () => ({ allow: false, reason: 'x' }) };
    setNegativeSpaceScanDeps(deps as never);
    await run({}, { workspaceId: 'ws-1', harnessSlug: 'h' });
    expect(mockRun).toHaveBeenCalledWith(expect.objectContaining({ installSlug: 'h' }), deps);
  });

  it('flattens the tick result into the declared output shape', async () => {
    const out = await run({}, { workspaceId: 'ws-1' });
    expect(out).toMatchObject({ ran: true, scanned: 7, demandEntries: 3, filed: ['q1'], declined: 0 });
  });
});
