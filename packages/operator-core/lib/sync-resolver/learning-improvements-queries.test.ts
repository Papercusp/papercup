// learning.improvements resolver GATE (precompute-sync-reads-phase2-compute-latency
// -2026-07-19 P-003 / WI-5460 follow-up). The Learning tab mounts with {} (the
// DEFAULT variant), and that view is now served from a precomputed snapshot (a
// `system:precompute-derived-reads` producer; see derived-reads/producers.ts) — a
// plain SELECT, not the 0.4-0.5s buildDigest + human-queue ranking + flow-metrics
// over the whole improvement corpus it used to run on every read.
//
// Snapshots key on (workspace_id, harness_slug, key) with NO arg dimension, so a
// NON-default view (a state filter, a custom limit, or the per-Hive lens) MUST
// fall through to the live inline compute (computeLearningImprovementsSnapshot).
// The `recordQueueExposure` owner-preference side-effect MUST fire on the REAL
// read in BOTH branches (never the precompute routine), keyed off whatever
// humanQueue the read returned. These tests pin exactly those invariants.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { knownQueryNamesV2 } from './index';

const {
  readDerivedSnapshotRowsMock,
  registerDerivedReadMock,
  computeSnapshotMock,
  recordQueueExposureMock,
} = vi.hoisted(() => ({
  readDerivedSnapshotRowsMock: vi.fn(async (_key: string) => [] as unknown[]),
  registerDerivedReadMock: vi.fn(),
  computeSnapshotMock: vi.fn(async (_a: unknown) => [] as unknown[]),
  recordQueueExposureMock: vi.fn(async (_ids: string[]) => {}),
}));

vi.mock('../derived-reads/registry', () => ({
  readDerivedSnapshotRows: readDerivedSnapshotRowsMock,
  registerDerivedRead: registerDerivedReadMock,
}));
vi.mock('../harness/improvements/learning-digest-snapshot', () => ({
  computeLearningImprovementsSnapshot: computeSnapshotMock,
}));
vi.mock('../owner-preference/interactions', () => ({
  recordQueueExposure: recordQueueExposureMock,
}));

// Let a fire-and-forget `void import(...).then(...)` microtask settle.
const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

describe('learning.improvements resolver gate', () => {
  it('registers the learning.improvements query name', () => {
    expect(knownQueryNamesV2()).toContain('learning.improvements');
  });

  describe('default vs non-default routing + exposure side-effect', () => {
    beforeEach(() => {
      vi.resetModules();
      for (const m of [readDerivedSnapshotRowsMock, computeSnapshotMock, recordQueueExposureMock]) m.mockClear();
    });
    afterEach(() => vi.resetModules());

    it('DEFAULT variant ({}) reads the precomputed snapshot — never the inline compute — and records exposure from the snapshot humanQueue', async () => {
      const snap = { humanQueue: [{ id: 'EI-1' }, { id: 'EI-2' }], flow: {}, recurringSignatures: [] };
      readDerivedSnapshotRowsMock.mockImplementation(async () => [snap]);
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('learning.improvements', {})) as unknown[];
      expect(rows).toEqual([snap]);
      expect(readDerivedSnapshotRowsMock).toHaveBeenCalledWith('learning.improvements');
      // The point of P-003: the read path runs NO digest compute.
      expect(computeSnapshotMock).not.toHaveBeenCalled();
      await flushMicrotasks();
      // Exposure fires on the real read, keyed off the snapshot's humanQueue ids.
      expect(recordQueueExposureMock).toHaveBeenCalledWith(['EI-1', 'EI-2']);
    });

    it('a NON-default STATE arg falls through to the live inline compute (no snapshot)', async () => {
      computeSnapshotMock.mockImplementation(async () => [{ humanQueue: [{ id: 'EI-9' }], flow: {} }]);
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('learning.improvements', { state: 'resolved' })) as unknown[];
      expect(rows).toHaveLength(1);
      expect(readDerivedSnapshotRowsMock).not.toHaveBeenCalled();
      expect(computeSnapshotMock).toHaveBeenCalledWith({ state: 'resolved' });
      await flushMicrotasks();
      expect(recordQueueExposureMock).toHaveBeenCalledWith(['EI-9']);
    });

    it('the per-Hive lens falls through to inline compute (snapshot has no per-hive variant)', async () => {
      computeSnapshotMock.mockImplementation(async () => [{ humanQueue: [], flow: {} }]);
      const { resolveNamedQueryV2: r } = await import('./index');
      await r('learning.improvements', { hive: 'alpha-hive' });
      expect(readDerivedSnapshotRowsMock).not.toHaveBeenCalled();
      expect(computeSnapshotMock).toHaveBeenCalledWith({ hive: 'alpha-hive' });
      await flushMicrotasks();
      // Empty humanQueue ⇒ no exposure row written (nothing was shown).
      expect(recordQueueExposureMock).not.toHaveBeenCalled();
    });

    it('an empty snapshot (cold DB / miss) returns [] and records no exposure', async () => {
      readDerivedSnapshotRowsMock.mockImplementation(async () => []);
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('learning.improvements', {})) as unknown[];
      expect(rows).toEqual([]);
      await flushMicrotasks();
      expect(recordQueueExposureMock).not.toHaveBeenCalled();
    });
  });
});
