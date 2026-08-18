// learning.improvements resolver GATE (precompute-sync-reads-phase2-compute-latency
// -2026-07-19 P-003 / WI-5460 follow-up). The Learning tab mounts with {} (the
// DEFAULT variant), and that view is now served from a precomputed snapshot (a
// `system:precompute-derived-reads` producer; see derived-reads/producers.ts) — a
// plain SELECT, not the 0.4-0.5s buildDigest + human-queue ranking + flow-metrics
// over the whole improvement corpus it used to run on every read.
//
// Snapshots key on (workspace_id, harness_slug, key) with no ARG dimension, so a
// NON-default view (a state filter or a custom limit) MUST fall through to the
// live inline compute (computeLearningImprovementsSnapshot).
//
// WI-7432: the per-Hive lens is the EXCEPTION, and it is the variant the owner is
// actually in — the Learning tab inherits the pot lens from the top-bar selector,
// so a normal desktop mount carries `hive: '<slug>'`. It used to fall through here
// and pay a full live compute on EVERY mount (0.35-0.52s warm, 1.56-3.19s cold,
// 300,440 B), which meant the precomputed fast path served only the All-Pots case
// — the case nobody is in. It needs no arg dimension: harness_slug IS the pot
// dimension, so a sibling producer (`learning.improvements.hive`) precomputes the
// lensed digest per pot. These tests pin BOTH legs: the snapshot HIT serves without
// computing, and a MISS still falls through to the live compute so the path is
// never worse than it was before.
// The `recordQueueExposure` owner-preference side-effect MUST fire on the REAL
// read in BOTH branches (never the precompute routine), keyed off whatever
// humanQueue the read returned. These tests pin exactly those invariants.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { knownQueryNamesV2 } from './index';
// TYPE-ONLY (erased at runtime, so it is safe in a file that vi.mock's this
// module). It pins readDerivedSnapshotMock to the REAL result shape instead of
// letting inference derive one from the default literal below — see WI-7495.
import type { DerivedSnapshotResult } from '../derived-reads/registry';

const {
  readDerivedSnapshotRowsMock,
  readDerivedSnapshotMock,
  registerDerivedReadMock,
  computeSnapshotMock,
  recordQueueExposureMock,
} = vi.hoisted(() => ({
  readDerivedSnapshotRowsMock: vi.fn(async (_key: string) => [] as unknown[]),
  // Defaults to a MISS — the shape readDerivedSnapshot returns for a cold pot
  // (payload null + meta.missing). A test that wants a HIT overrides it.
  //
  // WI-7495 — the return type is ANNOTATED, not inferred, and that is load-bearing.
  // Inferred from this literal alone, `computedAt`/`computeMs` take the literal type
  // `null`, so a HIT override (`computedAt: 123`) is not assignable and the file goes
  // +1 over its tsc baseline — which red-pinned the fleet gate's lint:tsc leg while
  // every vitest run stayed green (vitest transforms via esbuild and never typechecks).
  // Naming the real exported shape also means this mock cannot silently drift from
  // readDerivedSnapshot again the way hand-rolled factories do (cf. WI-7187).
  readDerivedSnapshotMock: vi.fn(
    async (_key: string, _opts?: { harnessSlug?: string }): Promise<DerivedSnapshotResult<unknown>> => ({
      payload: null,
      meta: { computedAt: null, computeMs: null, missing: true, stale: false, error: null, precomputed: false },
    }),
  ),
  registerDerivedReadMock: vi.fn(),
  computeSnapshotMock: vi.fn(async (_a: unknown) => [] as unknown[]),
  recordQueueExposureMock: vi.fn(async (_ids: string[]) => {}),
}));

vi.mock('../derived-reads/registry', () => ({
  readDerivedSnapshotRows: readDerivedSnapshotRowsMock,
  readDerivedSnapshot: readDerivedSnapshotMock,
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
      for (const m of [
        readDerivedSnapshotRowsMock,
        readDerivedSnapshotMock,
        computeSnapshotMock,
        recordQueueExposureMock,
      ])
        m.mockClear();
    });
    afterEach(() => vi.resetModules());

    it('DEFAULT variant ({}) reads the precomputed snapshot — never the inline compute — and records exposure from the snapshot humanQueue', async () => {
      const snap = { humanQueue: [{ id: 'EI-1' }, { id: 'EI-2' }], flow: {}, recurringSignatures: [] } as Record<string, unknown>;
      // WI-39773: the DEFAULT variant reads via readDerivedSnapshot (meta-carrying),
      // no longer readDerivedSnapshotRows — same contract as the hive lens below.
      readDerivedSnapshotMock.mockImplementation(async () => ({
        payload: [snap] as unknown,
        meta: { computedAt: 123, computeMs: 4, missing: false, stale: false, error: null, precomputed: true },
      }));
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('learning.improvements', {})) as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0].humanQueue).toEqual([{ id: 'EI-1' }, { id: 'EI-2' }]);
      expect(readDerivedSnapshotMock).toHaveBeenCalledWith('learning.improvements');
      // The point of P-003: the read path runs NO digest compute.
      expect(computeSnapshotMock).not.toHaveBeenCalled();
      // Staleness meta rides along so the panel can show "as of HH:MM" (WI-39773).
      expect((rows[0]._meta as { derivedRead?: { precomputed?: boolean } })?.derivedRead?.precomputed).toBe(true);
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

    // WI-7432 — the owner's actual variant. Both legs are pinned: a HIT must not
    // compute (that IS the fix), and a MISS must still compute (so the fix can
    // never make a cold pot worse than it was).
    it('the per-Hive lens is SERVED from the per-pot snapshot — keyed by harnessSlug, never the inline compute', async () => {
      const snap = { humanQueue: [{ id: 'EI-7' }], flow: {}, recurringSignatures: [] };
      readDerivedSnapshotMock.mockImplementation(async () => ({
        payload: [snap] as unknown,
        meta: { computedAt: 123, computeMs: 4, missing: false, stale: false, error: null, precomputed: true },
      }));
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('learning.improvements', { hive: 'alpha-hive' })) as Array<Record<string, unknown>>;
      // The pot dimension IS harness_slug — no new arg dimension was needed.
      expect(readDerivedSnapshotMock).toHaveBeenCalledWith('learning.improvements.hive', {
        harnessSlug: 'alpha-hive',
      });
      // The whole point: the owner's every-mount live compute is gone.
      expect(computeSnapshotMock).not.toHaveBeenCalled();
      expect(rows).toHaveLength(1);
      // Staleness meta rides along so the panel can show "as of HH:MM", same
      // contract as the default variant.
      expect((rows[0]._meta as { derivedRead?: { precomputed?: boolean } })?.derivedRead?.precomputed).toBe(true);
      await flushMicrotasks();
      expect(recordQueueExposureMock).toHaveBeenCalledWith(['EI-7']);
    });

    it('a per-Hive snapshot MISS (cold pot) falls through to the live compute — never worse than pre-WI-7432', async () => {
      // The hoisted default is already a miss; be explicit about what is under test.
      readDerivedSnapshotMock.mockImplementation(async () => ({
        payload: null as unknown,
        meta: { computedAt: null, computeMs: null, missing: true, stale: false, error: null, precomputed: false },
      }));
      computeSnapshotMock.mockImplementation(async () => [{ humanQueue: [{ id: 'EI-8' }], flow: {} }]);
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('learning.improvements', { hive: 'alpha-hive' })) as unknown[];
      expect(readDerivedSnapshotMock).toHaveBeenCalled();
      // A miss must NOT render the pot blank — it serves live data while the
      // background fill readDerivedSnapshot kicked warms the pot for next time.
      expect(computeSnapshotMock).toHaveBeenCalledWith({ hive: 'alpha-hive' });
      expect(rows).toHaveLength(1);
      await flushMicrotasks();
      expect(recordQueueExposureMock).toHaveBeenCalledWith(['EI-8']);
    });

    it('scope:"all" with a hive is a different POPULATION — it must not be served from the per-pot snapshot', async () => {
      computeSnapshotMock.mockImplementation(async () => [{ humanQueue: [], flow: {} }]);
      const { resolveNamedQueryV2: r } = await import('./index');
      await r('learning.improvements', { hive: 'alpha-hive', scope: 'all' });
      expect(readDerivedSnapshotMock).not.toHaveBeenCalled();
      expect(readDerivedSnapshotRowsMock).not.toHaveBeenCalled();
      expect(computeSnapshotMock).toHaveBeenCalledWith({ hive: 'alpha-hive', scope: 'all' });
      await flushMicrotasks();
      // Empty humanQueue ⇒ no exposure row written (nothing was shown).
      expect(recordQueueExposureMock).not.toHaveBeenCalled();
    });

    it('a DEFAULT-variant snapshot MISS (cold pot) falls through to the live compute — never a blank landing view (WI-39773)', async () => {
      // The hoisted default is already a miss; be explicit about what is under test.
      readDerivedSnapshotMock.mockImplementation(async () => ({
        payload: null as unknown,
        meta: { computedAt: null, computeMs: null, missing: true, stale: false, error: null, precomputed: false },
      }));
      computeSnapshotMock.mockImplementation(async () => []);
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('learning.improvements', {})) as unknown[];
      expect(readDerivedSnapshotMock).toHaveBeenCalledWith('learning.improvements');
      // WI-39773: a miss must NOT flatten to [] — it serves the live compute while
      // the background fill warms the pot (the pre-WI-39773 `...Rows` read served
      // an EMPTY digest for ~2 min after every producerVersion bump).
      expect(computeSnapshotMock).toHaveBeenCalledWith({});
      // Cold DB: the live compute is empty too ⇒ [] and no exposure row written.
      expect(rows).toEqual([]);
      await flushMicrotasks();
      expect(recordQueueExposureMock).not.toHaveBeenCalled();
    });
  });
});
