/**
 * scheduler-scout-code-hash.test.ts — buildScoutTickDeps().recordTick stamps the
 * RUNNING scout code's content identity onto every persisted tick row (WI-5397), so
 * the soak-method readers (tick-ledger.ts's readNewestScoutCodeHash /
 * readScoutTicksByCodeHash) can aggregate ticks across bg-host restarts that loaded
 * byte-identical code. Kept in its OWN file (rather than folded into scheduler.test.ts)
 * so its module-level mocks of tick-ledger/scout-code-identity/workspace-brain-scope
 * never leak into that file's unmocked-by-design fixtures.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  recordScoutTick: vi.fn(async (_input: Record<string, unknown>) => {}),
  currentScoutCodeHash: vi.fn<() => string | null>(() => 'hash-live-123'),
}));

vi.mock('./tick-ledger', () => ({ recordScoutTick: mocks.recordScoutTick }));
vi.mock('./scout-code-identity', () => ({ currentScoutCodeHash: mocks.currentScoutCodeHash }));
vi.mock('../workspace-brain-scope', () => ({
  isWorkspaceCoordinationOn: async () => false,
  workspaceBrainScopeKey: (workspaceId: string) => workspaceId,
}));

const { buildScoutTickDeps } = await import('./scheduler');

describe("buildScoutTickDeps().recordTick — scoutCodeHash stamp (WI-5397)", () => {
  beforeEach(() => {
    mocks.recordScoutTick.mockClear();
  });

  const deps = () =>
    buildScoutTickDeps({
      harnessSlug: 'papercup',
      runCycle: async () => ({ provenance: [] }),
      readIdleRatio: async () => 1,
      readFrictionSignals: async () => 0,
    });

  it('stamps detail.scoutCodeHash on a "ran" tick when currentScoutCodeHash() resolves', async () => {
    mocks.currentScoutCodeHash.mockReturnValue('hash-live-123');
    await deps().recordTick!({ status: 'ran', ideasGenerated: 2, ideasRouted: 1, detail: { cycleId: 'c1' } });
    expect(mocks.recordScoutTick).toHaveBeenCalledOnce();
    const call = mocks.recordScoutTick.mock.calls[0]![0] as { detail?: Record<string, unknown> };
    expect(call.detail).toMatchObject({ cycleId: 'c1', scoutCodeHash: 'hash-live-123' });
  });

  it('stamps the hash on a GATED tick too — a gated tick still proves the classifier code was live', async () => {
    mocks.currentScoutCodeHash.mockReturnValue('hash-live-123');
    await deps().recordTick!({ status: 'gated', gate: 'min-interval' });
    const call = mocks.recordScoutTick.mock.calls[0]![0] as { detail?: Record<string, unknown> };
    expect(call.detail).toMatchObject({ scoutCodeHash: 'hash-live-123' });
  });

  it('preserves any EXISTING detail keys alongside the stamp, never overwriting them', async () => {
    mocks.currentScoutCodeHash.mockReturnValue('hash-live-123');
    await deps().recordTick!({ status: 'ran', detail: { cycleId: 'c9', signalScore: 7, reason: 'signal-volume' } });
    const call = mocks.recordScoutTick.mock.calls[0]![0] as { detail?: Record<string, unknown> };
    expect(call.detail).toEqual({ cycleId: 'c9', signalScore: 7, reason: 'signal-volume', scoutCodeHash: 'hash-live-123' });
  });

  it('OMITS the key entirely (never stamps a misleading null) when currentScoutCodeHash() resolves null', async () => {
    mocks.currentScoutCodeHash.mockReturnValue(null);
    await deps().recordTick!({ status: 'ran', detail: { cycleId: 'c2' } });
    const call = mocks.recordScoutTick.mock.calls[0]![0] as { detail?: Record<string, unknown> };
    expect(call.detail).toEqual({ cycleId: 'c2' });
    expect(call.detail).not.toHaveProperty('scoutCodeHash');
  });

  it('OMITS the key on a tick with NO detail at all when the hash is null (no phantom detail object)', async () => {
    mocks.currentScoutCodeHash.mockReturnValue(null);
    await deps().recordTick!({ status: 'gated', gate: 'no-trigger' });
    const call = mocks.recordScoutTick.mock.calls[0]![0] as { detail?: Record<string, unknown> };
    expect(call.detail).toBeUndefined();
  });

  it('still creates a detail object carrying JUST the hash when none existed and the hash resolves', async () => {
    mocks.currentScoutCodeHash.mockReturnValue('hash-only');
    await deps().recordTick!({ status: 'gated', gate: 'no-trigger' });
    const call = mocks.recordScoutTick.mock.calls[0]![0] as { detail?: Record<string, unknown> };
    expect(call.detail).toEqual({ scoutCodeHash: 'hash-only' });
  });
});
