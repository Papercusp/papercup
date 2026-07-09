import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The module registers a system action at import time — neutralize it.
vi.mock('./system-actions', () => ({ registerSystemAction: vi.fn() }));
vi.mock('../../cross-hive-boundary-boot', () => ({
  ensureCrossHiveBoundariesWired: vi.fn(),
  listWiredCrossHiveBoundaries: vi.fn(),
}));

import { runCrossHiveDrainTick } from './cross-hive-drain-action';
import { ensureCrossHiveBoundariesWired, listWiredCrossHiveBoundaries } from '../../cross-hive-boundary-boot';

const mkBoundary = (
  workspaceId: string,
  potSlug: string,
  drainImpl: () => Promise<{ delivered: number; pending: number; failedPeers: string[]; backedOffPeers: string[] }>,
) => ({ workspaceId, potSlug, drain: vi.fn(drainImpl) });

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('runCrossHiveDrainTick', () => {
  it('is a clean, console-silent no-op when nothing is wired (ships ACTIVE)', async () => {
    // No spy: operator-core is fail-on-console, so this asserts the no-op path never logs.
    vi.mocked(ensureCrossHiveBoundariesWired).mockResolvedValue({ wired: [], closed: [] } as never);
    vi.mocked(listWiredCrossHiveBoundaries).mockReturnValue([] as never);
    const out = await runCrossHiveDrainTick({ workspaceId: 'ws-1', payloadTemplate: {} });
    expect(out).toEqual({ delivered: 0, pendingTotal: 0, drainedBoundaries: 0 });
  });

  it('drains every wired boundary, aggregates totals, and threads the backoff tunables', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(ensureCrossHiveBoundariesWired).mockResolvedValue({ wired: ['a'], closed: [] } as never);
    const a = mkBoundary('ws-1', 'hive-a', async () => ({ delivered: 2, pending: 1, failedPeers: [], backedOffPeers: [] }));
    const b = mkBoundary('ws-2', 'hive-b', async () => ({ delivered: 0, pending: 0, failedPeers: [], backedOffPeers: [] }));
    vi.mocked(listWiredCrossHiveBoundaries).mockReturnValue([a, b] as never);

    const out = await runCrossHiveDrainTick({
      workspaceId: 'ws-1',
      payloadTemplate: { baseBackoffMs: 30_000, capBackoffMs: 1_800_000 },
    });

    expect(out).toEqual({ delivered: 2, pendingTotal: 1, drainedBoundaries: 2 });
    expect(a.drain).toHaveBeenCalledWith({ baseMs: 30_000, capMs: 1_800_000 });
    expect(b.drain).toHaveBeenCalledWith({ baseMs: 30_000, capMs: 1_800_000 });
  });

  it('a boundary that throws is caught — the loop continues and counts only successful drains', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(ensureCrossHiveBoundariesWired).mockResolvedValue({ wired: [], closed: [] } as never);
    const bad = mkBoundary('ws-1', 'hive-bad', async () => {
      throw new Error('peer offline');
    });
    const good = mkBoundary('ws-2', 'hive-good', async () => ({ delivered: 1, pending: 0, failedPeers: [], backedOffPeers: [] }));
    vi.mocked(listWiredCrossHiveBoundaries).mockReturnValue([bad, good] as never);

    const out = await runCrossHiveDrainTick({ workspaceId: 'ws-1', payloadTemplate: {} });

    expect(out).toEqual({ delivered: 1, pendingTotal: 0, drainedBoundaries: 1 });
    expect(good.drain).toHaveBeenCalled();
  });

  it('omits the backoff tunables from the drain call when the payload template has none', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(ensureCrossHiveBoundariesWired).mockResolvedValue({ wired: [], closed: [] } as never);
    const a = mkBoundary('ws-1', 'hive-a', async () => ({ delivered: 0, pending: 0, failedPeers: [], backedOffPeers: [] }));
    vi.mocked(listWiredCrossHiveBoundaries).mockReturnValue([a] as never);

    await runCrossHiveDrainTick({ workspaceId: 'ws-1', payloadTemplate: {} });

    expect(a.drain).toHaveBeenCalledWith({});
  });
});
