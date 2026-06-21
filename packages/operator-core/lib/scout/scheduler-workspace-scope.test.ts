/**
 * scheduler-workspace-scope.test.ts — P-002 (workspace-scoped-coordination-2026-06-20,
 * D-006): the K1 workspace-sentinel keying the production Scout tick-deps
 * (buildScoutTickDeps) apply when FLAGS.WORKSPACE_COORDINATION is ON:
 *   - tick observability (scout_ticks) rolls up under the workspace sentinel
 *     (install_slug = workspaceId) — ONE coherent tick stream per workspace brain,
 *     the same sentinel keying the lens-weights already use (routed-ledger), and
 *   - the idea-pipeline drain signal (the `ideas-drained` cadence trigger) spans the
 *     WHOLE workspace's routed ideas rather than just this install's.
 * OFF ⇒ per-install, byte-identical to today.
 *
 * Hermetic: the PG/flag edges are mocked, so this pins the KEYING DECISION (not the
 * DB) — the tick + cadence companion to routed-ledger's lens-weight K1 coverage. The
 * pure sentinel math itself is covered in ../workspace-brain-scope.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  recordScoutTick: vi.fn(async (_: unknown) => {}),
  readIdeaQueueStatus: vi.fn(async (_: unknown) => ({ total: 0, pending: 0 })),
  isWorkspaceCoordinationOn: vi.fn(async () => false),
}));

vi.mock('./tick-ledger', () => ({ recordScoutTick: h.recordScoutTick }));
vi.mock('./routed-ledger', () => ({
  recordRoutedIdea: vi.fn(async () => {}),
  refreshScoutOutcomes: vi.fn(async () => ({})),
  readIdeaQueueStatus: h.readIdeaQueueStatus,
}));
vi.mock('../autoloop', () => ({
  readFireState: vi.fn(async () => null),
  checkFireGate: vi.fn(async () => ({ allow: true })),
  recordFire: vi.fn(async () => {}),
  claimFire: vi.fn(async () => true),
}));
// Keep the REAL pure sentinel math (workspaceBrainScopeKey); only stub the flag read.
vi.mock('../workspace-brain-scope', async (importActual) => {
  const actual = await importActual<typeof import('../workspace-brain-scope')>();
  return { ...actual, isWorkspaceCoordinationOn: h.isWorkspaceCoordinationOn };
});

import { buildScoutTickDeps } from './scheduler';

const HIVE = 'hive-a';
const WS = 'papercusp-workspace';

function deps(workspaceId?: string) {
  return buildScoutTickDeps({
    harnessSlug: HIVE,
    runCycle: async () => ({ provenance: [] }),
    readIdleRatio: async () => 1,
    readFrictionSignals: async () => 0,
    ...(workspaceId ? { workspaceId } : {}),
  });
}

beforeEach(() => {
  h.recordScoutTick.mockClear();
  h.readIdeaQueueStatus.mockClear();
  h.isWorkspaceCoordinationOn.mockReset().mockResolvedValue(false);
});

describe('recordTick — K1 workspace-sentinel keying (P-002)', () => {
  it('flag OFF → tick recorded under the per-install slug (byte-identical to today)', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(false);
    await deps(WS).recordTick!({ status: 'gated', gate: 'min-interval' });
    expect(h.recordScoutTick).toHaveBeenCalledWith(
      expect.objectContaining({ installSlug: HIVE, workspaceId: WS }),
    );
  });

  it('flag ON → tick rolls up under the workspace sentinel (install_slug = workspaceId)', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    await deps(WS).recordTick!({ status: 'ran', ideasRouted: 2 });
    expect(h.recordScoutTick).toHaveBeenCalledWith(
      expect.objectContaining({ installSlug: WS, workspaceId: WS }),
    );
  });

  it('flag ON but no workspaceId → keeps the per-install slug (dark/legacy fallback)', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    await deps(undefined).recordTick!({ status: 'gated', gate: 'circuit' });
    expect(h.recordScoutTick).toHaveBeenCalledWith(expect.objectContaining({ installSlug: HIVE }));
  });
});

describe('readCadenceState — K1 workspace-wide idea-pipeline drain signal (P-002)', () => {
  it('flag OFF → idea-queue read is per-install (harnessSlug filter present)', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(false);
    await deps(WS).readCadenceState();
    expect(h.readIdeaQueueStatus).toHaveBeenCalledWith(
      expect.objectContaining({ harnessSlug: HIVE, workspaceId: WS }),
    );
  });

  it('flag ON → idea-queue read spans the whole workspace (no harness filter)', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    await deps(WS).readCadenceState();
    const arg = (h.readIdeaQueueStatus.mock.calls.at(-1)?.[0] ?? {}) as Record<string, unknown>;
    expect(arg).not.toHaveProperty('harnessSlug');
    expect(arg).toMatchObject({ workspaceId: WS });
  });
});
