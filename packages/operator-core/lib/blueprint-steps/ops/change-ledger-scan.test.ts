import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { changeLedgerScanOp, setChangeLedgerScanDeps } from './change-ledger-scan';
import { runChangeLedgerScan } from '../../change-ledger/scan-loop.js';

// Unit: runChangeLedgerScan has its own suite; this pins the deterministic-step
// WRAPPER — workspaceId guard, installSlug default, deps seam, outcome→result
// flattening (deterministic-blueprints-migration P-004, D-004).
vi.mock('../../coord-ops/registry.js', () => ({ registerCoordOp: vi.fn() }));
vi.mock('../../change-ledger/scan-loop.js', () => ({ runChangeLedgerScan: vi.fn() }));

const mockRun = vi.mocked(runChangeLedgerScan);
const run = (a: Record<string, unknown>, ctx: Record<string, unknown>) =>
  (changeLedgerScanOp.run as (a: unknown, c: unknown) => Promise<Record<string, unknown>>)(a, ctx);

describe('change-ledger:scan deterministic step op', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRun.mockResolvedValue({ ran: true, edits: 4, recorded: 3 } as unknown as Awaited<
      ReturnType<typeof runChangeLedgerScan>
    >);
  });
  afterEach(() => setChangeLedgerScanDeps(null));

  it('throws when ctx.workspaceId is absent', async () => {
    await expect(run({}, {})).rejects.toThrow(/requires ctx.workspaceId/);
  });

  it('defaults installSlug to "op" and forwards args as payload', async () => {
    await run({ sinceDays: 30 }, { workspaceId: 'ws-1' });
    expect(mockRun).toHaveBeenCalledWith({ workspaceId: 'ws-1', installSlug: 'op', payload: { sinceDays: 30 } }, {});
  });

  it('threads injected deps through the set-seam', async () => {
    const deps = { flag: async () => false };
    setChangeLedgerScanDeps(deps as never);
    await run({}, { workspaceId: 'ws-1' });
    expect(mockRun).toHaveBeenCalledWith(expect.anything(), deps);
  });

  it('flattens edits/recorded into the declared output shape', async () => {
    const out = await run({}, { workspaceId: 'ws-1' });
    expect(out).toEqual({ ran: true, skipReason: undefined, edits: 4, recorded: 3 });
  });
});
