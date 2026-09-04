// coord.history resolver GATE (precompute-sync-reads-phase2-compute-latency
// -2026-07-19 P-004). The legacy /coord history viewer mounts with the DEFAULT
// view (all sources, no filters, limit 200), and that view is now served from a
// precomputed snapshot (a `system:precompute-derived-reads` producer; see
// derived-reads/producers.ts) instead of loadCoordHistory's full scan of the
// whole coord corpus (all plan-events + messages + escalations + handoffs, then
// filter/sort/slice in JS — the 0.1-0.8s variable cost the plan flagged).
//
// Snapshots key on (workspace_id, harness_slug, key) with NO arg dimension, so any
// FILTERED or custom-limit view (kinds / planSlug / owner / sinceTs / limit≠200)
// MUST fall through to the live inline scan. These tests pin that gate.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { knownQueryNamesV2 } from './index';

const { readDerivedSnapshotRowsMock, registerDerivedReadMock, loadCoordHistoryMock } = vi.hoisted(() => ({
  readDerivedSnapshotRowsMock: vi.fn(async (_key: string) => [] as unknown[]),
  registerDerivedReadMock: vi.fn(),
  loadCoordHistoryMock: vi.fn(async (_args: unknown) => ({ items: [] as unknown[], total: 0, truncated: false })),
}));

vi.mock('../derived-reads/registry', () => ({
  readDerivedSnapshotRows: readDerivedSnapshotRowsMock,
  registerDerivedRead: registerDerivedReadMock,
}));
vi.mock('../endpoint-route/routes/coord', () => ({ loadCoordHistory: loadCoordHistoryMock }));

describe('coord.history resolver gate', () => {
  it('registers the coord.history query name', () => {
    expect(knownQueryNamesV2()).toContain('coord.history');
  });

  describe('default vs filtered routing', () => {
    beforeEach(() => {
      vi.resetModules();
      readDerivedSnapshotRowsMock.mockClear();
      loadCoordHistoryMock.mockClear();
    });
    afterEach(() => vi.resetModules());

    it('DEFAULT view (limit 200, no filters) reads the precomputed snapshot — never the inline scan', async () => {
      const snap = [{ source: 'message', msg_id: 'm1', ts: 't', kind: 'note' }];
      readDerivedSnapshotRowsMock.mockImplementation(async () => snap);
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('coord.history', { limit: 200 })) as unknown[];
      expect(rows).toEqual(snap);
      expect(readDerivedSnapshotRowsMock).toHaveBeenCalledWith('coord.history');
      expect(loadCoordHistoryMock).not.toHaveBeenCalled();
    });

    // WI-7297: `payload` is dropped at the SYNC boundary on BOTH branches. The
    // producer already strips it at compute time, so the snapshot branch is
    // normally a no-op — but a row stored before that bump (or by any other
    // writer) must not leak 160KB of payloads to the viewer either, so the
    // projection runs here regardless. Pinned with a payload-BEARING snapshot
    // row precisely because the healthy case cannot detect a missing pass.
    it('DEFAULT view strips `payload` even when the stored snapshot row still carries one', async () => {
      readDerivedSnapshotRowsMock.mockImplementation(async () => [
        { source: 'message', msg_id: 'm1', ts: 't', kind: 'note', payload: { body: 'heavy' } },
      ]);
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('coord.history', { limit: 200 })) as Record<string, unknown>[];
      expect(rows).toEqual([{ source: 'message', msg_id: 'm1', ts: 't', kind: 'note' }]);
      expect(rows[0]).not.toHaveProperty('payload');
    });

    it('a planSlug filter falls through to the live inline scan (no snapshot)', async () => {
      loadCoordHistoryMock.mockImplementation(async () => ({
        items: [{ source: 'plan_event', msg_id: 'p1', ts: 't', kind: 'x', payload: { body: 'heavy' } }],
        total: 1,
        truncated: false,
      }));
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('coord.history', { planSlug: 'some-plan', limit: 200 })) as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      // WI-7297: the FILTERED branch has no snapshot to have been stripped at
      // compute time, so this is where the projection is load-bearing — the
      // filtered view must not ship the payloads the default view just stopped
      // shipping.
      expect(rows[0]).not.toHaveProperty('payload');
      expect(rows[0]).toEqual({ source: 'plan_event', msg_id: 'p1', ts: 't', kind: 'x' });
      expect(readDerivedSnapshotRowsMock).not.toHaveBeenCalled();
      expect(loadCoordHistoryMock).toHaveBeenCalledWith(expect.objectContaining({ planSlug: 'some-plan' }));
    });

    it('a source (kinds) filter falls through to inline', async () => {
      const { resolveNamedQueryV2: r } = await import('./index');
      await r('coord.history', { kinds: ['message'], limit: 200 });
      expect(readDerivedSnapshotRowsMock).not.toHaveBeenCalled();
      expect(loadCoordHistoryMock).toHaveBeenCalledWith(expect.objectContaining({ kinds: ['message'] }));
    });

    it('a non-default limit falls through to inline (the snapshot only holds the 200-row default)', async () => {
      const { resolveNamedQueryV2: r } = await import('./index');
      await r('coord.history', { limit: 50 });
      expect(readDerivedSnapshotRowsMock).not.toHaveBeenCalled();
      expect(loadCoordHistoryMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
    });
  });
});
