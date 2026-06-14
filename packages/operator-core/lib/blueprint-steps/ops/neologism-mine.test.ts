import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { neologismMineOp, setNeologismMineDeps } from './neologism-mine';
import { runNeologismMine } from '../../neologism/mine.js';

// Unit: runNeologismMine has its own suite; this pins the deterministic-step
// WRAPPER — the ctx.workspaceId guard, the installSlug default, the deps seam,
// and the outcome→result flattening (deterministic-blueprints-migration P-011, D-004).
vi.mock('../../coord-ops/registry.js', () => ({ registerCoordOp: vi.fn() }));
vi.mock('../../neologism/mine.js', () => ({ runNeologismMine: vi.fn() }));

const mockRun = vi.mocked(runNeologismMine);
const run = (a: Record<string, unknown>, ctx: Record<string, unknown>) =>
  (neologismMineOp.run as (a: unknown, c: unknown) => Promise<Record<string, unknown>>)(a, ctx);

describe('neologism:mine deterministic step op', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRun.mockResolvedValue({
      ran: true,
      result: { scannedRows: 10, insightDocs: 2, terms: 5, overBars: 3, filed: ['a'], declined: 1 },
    } as unknown as Awaited<ReturnType<typeof runNeologismMine>>);
  });
  afterEach(() => setNeologismMineDeps(null));

  it('throws when ctx.workspaceId is absent (misconfigured fire fails loud)', async () => {
    await expect(run({}, {})).rejects.toThrow(/requires ctx.workspaceId/);
  });

  it('defaults installSlug to "op" and forwards the args as payload', async () => {
    await run({ windowDays: 30 }, { workspaceId: 'ws-1' });
    expect(mockRun).toHaveBeenCalledWith({ workspaceId: 'ws-1', installSlug: 'op', payload: { windowDays: 30 } }, {});
  });

  it('uses ctx.harnessSlug as installSlug when present', async () => {
    await run({}, { workspaceId: 'ws-1', harnessSlug: 'my-hive' });
    expect(mockRun).toHaveBeenCalledWith(expect.objectContaining({ installSlug: 'my-hive' }), {});
  });

  it('threads injected deps through the set-seam', async () => {
    const deps = { flag: async () => false };
    setNeologismMineDeps(deps as never);
    await run({}, { workspaceId: 'ws-1' });
    expect(mockRun).toHaveBeenCalledWith(expect.anything(), deps);
  });

  it('flattens the tick result into the declared output shape', async () => {
    const out = await run({}, { workspaceId: 'ws-1' });
    expect(out).toEqual({ ran: true, skipReason: undefined, governorReason: undefined, scannedRows: 10, insightDocs: 2, terms: 5, overBars: 3, filed: ['a'], declined: 1 });
  });

  it('passes a gate-skip outcome through (no result fields)', async () => {
    mockRun.mockResolvedValue({ ran: false, skipReason: 'governor-refused', governorReason: 'cap' } as unknown as Awaited<
      ReturnType<typeof runNeologismMine>
    >);
    const out = await run({}, { workspaceId: 'ws-1' });
    expect(out).toMatchObject({ ran: false, skipReason: 'governor-refused', governorReason: 'cap' });
  });
});
