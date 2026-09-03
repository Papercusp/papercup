// insights.coordTokens resolver GATE (precompute-sync-reads-phase2-compute-latency
// -2026-07-19 P-002 / WI-5584). The Learnings → Tokens Coordination panel mounts
// with NO args, and that DEFAULT variant is now served from a precomputed snapshot
// (a `system:precompute-derived-reads` producer; see derived-reads/producers.ts) —
// a plain SELECT, not the 0.5-0.8s of GROUP BY/COUNT rollups over the two
// highest-volume telemetry tables it used to run on every read.
//
// Derived-read snapshots key on (workspace_id, harness_slug, key) with NO arg
// dimension, so ONLY the default (whole-workspace, default-window) view can come
// from the snapshot. A NON-default view (an explicit `harness` or `windowMs`)
// MUST fall through to the live inline compute. These tests pin exactly that
// gate — the P-002-specific logic — mirroring the dev.* precedent in
// sync-resolver/dev-glances.test.ts (EI-17139: hoisted vi.mock so the resolver's
// dynamic `await import()` can never observe the real DB-backed module).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { knownQueryNamesV2 } from './index';
import type { CoordTokenBreakdown, CoordPollVolume, ModelPricingBookRow } from '../harness-insights/load-token-rollups';

const {
  readDerivedSnapshotRowsMock,
  registerDerivedReadMock,
  loadModelPricingBookMock,
  loadCoordTokenBreakdownMock,
  loadCoordPollVolumeMock,
  routeWithWorkspaceMock,
  activeWorkspaceIdMock,
} = vi.hoisted(() => ({
  readDerivedSnapshotRowsMock: vi.fn(async (_key: string) => [] as unknown[]),
  registerDerivedReadMock: vi.fn(),
  loadModelPricingBookMock: vi.fn(async (): Promise<ModelPricingBookRow[]> => []),
  loadCoordTokenBreakdownMock: vi.fn(
    async (): Promise<CoordTokenBreakdown> => ({ windowMs: 0, byTrigger: [], triggerAttributionAvailable: false, attributedCostShare: 0, byRoleClass: [] }),
  ),
  loadCoordPollVolumeMock: vi.fn(
    async (): Promise<CoordPollVolume> => ({ windowMs: 0, tools: [], wakePollCalls: 0, wakePollRowSharePct: 0 }),
  ),
  // route-workspace just needs to run the callback with a stub tx; the loaders are
  // mocked so nothing actually touches tx.unsafe.
  routeWithWorkspaceMock: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ unsafe: async () => [] }),
  ),
  activeWorkspaceIdMock: vi.fn(() => 'ws-test'),
}));

vi.mock('../derived-reads/registry', () => ({
  readDerivedSnapshotRows: readDerivedSnapshotRowsMock,
  registerDerivedRead: registerDerivedReadMock,
}));
vi.mock('../harness-insights/load-token-rollups', () => ({
  loadModelPricingBook: loadModelPricingBookMock,
  loadCoordTokenBreakdown: loadCoordTokenBreakdownMock,
  loadCoordPollVolume: loadCoordPollVolumeMock,
}));
vi.mock('../route-workspace', () => ({ routeWithWorkspace: routeWithWorkspaceMock }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: activeWorkspaceIdMock }));

describe('insights.coordTokens resolver gate', () => {
  it('registers the insights.coordTokens query name', () => {
    expect(knownQueryNamesV2()).toContain('insights.coordTokens');
  });

  describe('default vs non-default routing', () => {
    beforeEach(() => {
      vi.resetModules();
      for (const m of [
        readDerivedSnapshotRowsMock,
        loadModelPricingBookMock,
        loadCoordTokenBreakdownMock,
        loadCoordPollVolumeMock,
        routeWithWorkspaceMock,
      ]) {
        m.mockClear();
      }
    });
    afterEach(() => vi.resetModules());

    it('DEFAULT variant (no args) reads the precomputed snapshot — never the inline loaders', async () => {
      const snap = { pricingBook: [{ modelId: 'opus' }], coordBreakdown: { byRoleClass: [] }, pollVolume: { tools: [] } };
      readDerivedSnapshotRowsMock.mockImplementation(async () => [snap]);
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('insights.coordTokens', {})) as unknown[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toBe(snap);
      expect(readDerivedSnapshotRowsMock).toHaveBeenCalledWith('insights.coordTokens');
      // The whole point of P-002: the read path does NO rollup compute.
      expect(loadModelPricingBookMock).not.toHaveBeenCalled();
      expect(loadCoordTokenBreakdownMock).not.toHaveBeenCalled();
      expect(loadCoordPollVolumeMock).not.toHaveBeenCalled();
    });

    it('a NON-default HARNESS arg falls through to the live inline compute (snapshot has no per-harness variant)', async () => {
      loadModelPricingBookMock.mockImplementation(async () => [{ modelId: 'sonnet' } as ModelPricingBookRow]);
      loadCoordTokenBreakdownMock.mockImplementation(async () => ({ windowMs: 604800000, byTrigger: [], triggerAttributionAvailable: false, attributedCostShare: 0, byRoleClass: [{ roleClass: 'fleet', tokens: 1, costUsd: 1, runs: 1 }] }));
      loadCoordPollVolumeMock.mockImplementation(async () => ({ windowMs: 86400000, tools: [], wakePollCalls: 3, wakePollRowSharePct: 75 }));
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('insights.coordTokens', { harness: 'papercusp' })) as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0].pricingBook).toEqual([{ modelId: 'sonnet' }]);
      // Inline path ran; the snapshot SELECT did NOT.
      expect(readDerivedSnapshotRowsMock).not.toHaveBeenCalled();
      expect(loadCoordTokenBreakdownMock).toHaveBeenCalledWith(
        expect.objectContaining({ workspace_id: 'ws-test', harness_slug: 'papercusp' }),
      );
    });

    it('a NON-default WINDOWMS arg falls through to the live inline compute', async () => {
      const { resolveNamedQueryV2: r } = await import('./index');
      await r('insights.coordTokens', { windowMs: 3600_000 });
      expect(readDerivedSnapshotRowsMock).not.toHaveBeenCalled();
      expect(loadCoordTokenBreakdownMock).toHaveBeenCalledWith(
        expect.objectContaining({ workspace_id: 'ws-test', windowMs: 3600_000 }),
      );
      expect(loadCoordPollVolumeMock).toHaveBeenCalledWith(
        expect.objectContaining({ workspace_id: 'ws-test', windowMs: 3600_000 }),
      );
    });
  });
});
