/**
 * WI-3818: listFleetRosterDiagnosed / listFleetRoster's bounded fan-out — a slow/
 * hanging sub-read (presence, Tier-1, assignments, wakeability) must degrade to an
 * empty fallback within FLEET_ROSTER_SUBREAD_TIMEOUT_MS instead of hanging the whole
 * roster read. Unlike fleet-roster.test.ts (deliberately PG-free, pure-fold-only),
 * this file exercises the IO-seam wrapper itself: `readPresence` is injected (the
 * existing DI seam); `fetchPresenceTier1` / `listFleetAssignments` / `fetchWakeability`
 * are module-mocked since they aren't injectable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PresenceTier1Joins } from '../agent-tools/coordination/presence-tier1';
import type { WakeabilitySignals } from '../agent-tools/coordination/presence-wakeability';
import type { FleetAssignmentRow } from './assignments';
import type { FleetFoldPresence } from './fleet-roster';

const { fetchPresenceTier1Mock, fetchWakeabilityMock, listFleetAssignmentsMock } = vi.hoisted(() => ({
  fetchPresenceTier1Mock: vi.fn(),
  fetchWakeabilityMock: vi.fn(),
  listFleetAssignmentsMock: vi.fn(),
}));

vi.mock('../agent-tools/coordination/presence-tier1', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-tools/coordination/presence-tier1')>();
  return { ...actual, fetchPresenceTier1: fetchPresenceTier1Mock };
});
vi.mock('../agent-tools/coordination/presence-wakeability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-tools/coordination/presence-wakeability')>();
  return { ...actual, fetchWakeability: fetchWakeabilityMock };
});
vi.mock('./assignments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./assignments')>();
  return { ...actual, listFleetAssignments: listFleetAssignmentsMock };
});

// Imported AFTER the mocks so the mocked bindings are the ones wired in.
const { listFleetRosterDiagnosed, listFleetRoster, FLEET_ROSTER_SUBREAD_TIMEOUT_MS } = await import(
  './fleet-roster'
);

function pres(ownerId: string): FleetFoldPresence {
  return {
    ownerId,
    ownerLabel: null,
    source: 'omp-hook-session',
    intent: '',
    currentPlanSlug: null,
    host: null,
    startedAt: null,
    heartbeatAt: '2026-07-10T10:00:00Z',
    lastActiveAt: '2026-07-10T10:00:00Z',
    agentRole: null,
    fleetSlug: 'p2p-parity-lanes',
    fleetRole: 'member',
    userId: null,
    stale: false,
  };
}

const neverSettles = <T>(): Promise<T> => new Promise<T>(() => {});

describe('listFleetRosterDiagnosed (WI-3818 bounded fan-out)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchPresenceTier1Mock.mockReset();
    fetchWakeabilityMock.mockReset();
    listFleetAssignmentsMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with a full roster + no degraded legs when every sub-read answers in time', async () => {
    fetchPresenceTier1Mock.mockResolvedValue(new Map<string, PresenceTier1Joins>());
    fetchWakeabilityMock.mockResolvedValue(new Map<string, WakeabilitySignals>());
    listFleetAssignmentsMock.mockResolvedValue([] as FleetAssignmentRow[]);

    const resultPromise = listFleetRosterDiagnosed({
      fleetSlug: 'p2p-parity-lanes',
      readPresence: async () => [pres('su-1')],
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;
    expect(result.degradedLegs).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].agentId).toBe('su-1');
  });

  it('degrades to an EMPTY roster (not a hang) when presence itself never resolves, reporting the leg', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchPresenceTier1Mock.mockResolvedValue(new Map<string, PresenceTier1Joins>());
    fetchWakeabilityMock.mockResolvedValue(new Map<string, WakeabilitySignals>());
    listFleetAssignmentsMock.mockResolvedValue([] as FleetAssignmentRow[]);

    const resultPromise = listFleetRosterDiagnosed({
      fleetSlug: 'p2p-parity-lanes',
      readPresence: () => neverSettles<FleetFoldPresence[]>(),
    });
    await vi.advanceTimersByTimeAsync(FLEET_ROSTER_SUBREAD_TIMEOUT_MS);
    const result = await resultPromise;
    expect(result.degradedLegs).toContain('presence');
    expect(result.entries).toEqual([]);
    warnSpy.mockRestore();
  });

  it('degrades to a SLIM-BUT-USABLE roster (identity present, work-detail empty) when only assignments hangs', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchPresenceTier1Mock.mockResolvedValue(new Map<string, PresenceTier1Joins>());
    fetchWakeabilityMock.mockResolvedValue(new Map<string, WakeabilitySignals>());
    listFleetAssignmentsMock.mockReturnValue(neverSettles<FleetAssignmentRow[]>());

    const resultPromise = listFleetRosterDiagnosed({
      fleetSlug: 'p2p-parity-lanes',
      readPresence: async () => [pres('su-1')],
    });
    await vi.advanceTimersByTimeAsync(FLEET_ROSTER_SUBREAD_TIMEOUT_MS);
    const result = await resultPromise;
    expect(result.degradedLegs).toEqual(['assignments']);
    // The whole point of WI-3818: presence still answered, so the caller gets a
    // usable roster with the member's identity/liveness — just no doing/queued/load
    // detail (the "drop queued detail first" fallback happening at the fold level).
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual(
      expect.objectContaining({ agentId: 'su-1', doing: null, queued: [], load: 0 }),
    );
    warnSpy.mockRestore();
  });

  it('degrades tier1 + wakeability independently while assignments answers', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchPresenceTier1Mock.mockReturnValue(neverSettles<Map<string, PresenceTier1Joins>>());
    fetchWakeabilityMock.mockReturnValue(neverSettles<Map<string, WakeabilitySignals>>());
    listFleetAssignmentsMock.mockResolvedValue([] as FleetAssignmentRow[]);

    const resultPromise = listFleetRosterDiagnosed({
      fleetSlug: 'p2p-parity-lanes',
      readPresence: async () => [pres('su-1')],
    });
    await vi.advanceTimersByTimeAsync(FLEET_ROSTER_SUBREAD_TIMEOUT_MS);
    const result = await resultPromise;
    expect(result.degradedLegs.sort()).toEqual(['tier1', 'wakeability']);
    expect(result.entries).toHaveLength(1);
    warnSpy.mockRestore();
  });

  it('listFleetRoster (back-compat wrapper) still resolves promptly with just the entries array', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchPresenceTier1Mock.mockResolvedValue(new Map<string, PresenceTier1Joins>());
    fetchWakeabilityMock.mockReturnValue(neverSettles<Map<string, WakeabilitySignals>>());
    listFleetAssignmentsMock.mockResolvedValue([] as FleetAssignmentRow[]);

    const resultPromise = listFleetRoster({
      fleetSlug: 'p2p-parity-lanes',
      readPresence: async () => [pres('su-1')],
    });
    await vi.advanceTimersByTimeAsync(FLEET_ROSTER_SUBREAD_TIMEOUT_MS);
    const entries = await resultPromise;
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(1);
    warnSpy.mockRestore();
  });
});
