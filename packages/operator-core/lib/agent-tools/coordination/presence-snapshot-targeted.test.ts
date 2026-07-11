/**
 * EI-9454 — a targeted `coord:presence { owner }` lookup must NOT pay the
 * whole-roster assembly.
 *
 * Observed live (2026-07-11, ~67 active sessions): the targeted lookup timed out
 * at 55s→300s exactly like a full-roster read, because the `owner` filter was
 * applied AFTER the enrichment fan-out (5 batch joins + the GC DELETE) ran for
 * every session. These tests pin the fix:
 *   1. the enrichment joins receive ONLY the matched id(s), not the whole roster;
 *   2. the GC sweep (a maintenance write) is SKIPPED on the targeted point-read;
 *   3. the default (no-owner) read is UNCHANGED — full-roster joins + the sweep.
 *
 * Hermetic: every IO seam is mocked; the pure helpers (matchesOwner,
 * selectRosterRows, mergeTier1, toStableRosterRow, deriveSessionState) stay real
 * so the selected rows keep production semantics.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.mock factories are hoisted above module-level consts — vi.hoisted() is the
// sanctioned way to share spies with them (a bare `const` here hits the TDZ).
const { listPresenceMock, sweepMock, tier1Mock, wakeabilityMock, fleetMock } = vi.hoisted(() => ({
  listPresenceMock: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  sweepMock: vi.fn(async (..._a: unknown[]) => 0),
  tier1Mock: vi.fn(async (..._a: unknown[]) => new Map()),
  wakeabilityMock: vi.fn(async (..._a: unknown[]) => new Map()),
  fleetMock: vi.fn(async (..._a: unknown[]) => new Map()),
}));
// importOriginal spread (not a bare factory): real presence-wakeability — kept
// real below via its own importOriginal — imports PRESENCE_STALE_MS from
// './presence'; a factory-only mock drops that export and the whole module
// graph fails to collect ("error when mocking a module").
vi.mock('./presence', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listPresence: listPresenceMock,
  sweepStalePresence: sweepMock,
}));
vi.mock('./federated-presence', () => ({ listFederatedPresence: vi.fn(async () => []) }));
vi.mock('../../adv-sessions', () => ({ listRecordedLiveSessions: vi.fn(async () => []) }));
// Pass-through reconcile: the test rows below are already RosterRow-shaped.
vi.mock('./recorded-sessions', () => ({
  reconcileRosterSources: (rows: unknown[]) => rows,
  RECORDED_SESSION_SOURCE: 'recorded-session',
}));
vi.mock('./presence-tier1', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchPresenceTier1: tier1Mock,
}));
vi.mock('./presence-wakeability', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchWakeability: wakeabilityMock,
}));
vi.mock('./presence-fleet', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchPresenceFleet: fleetMock,
}));
vi.mock('../../desktop-window-liveness', () => ({
  gatherOnDesktopSessions: vi.fn(async () => ({ owners: new Set<string>() })),
}));
vi.mock('../../pty-viewer-heartbeat', () => ({ gatherViewerAttachedOwners: vi.fn(async () => new Set<string>()) }));
vi.mock('../locks/su-lock-store', () => ({ getTxPool: vi.fn(), readGranularHolders: vi.fn(async () => []) }));
vi.mock('./watermarks', () => ({ writeWatermark: vi.fn(async () => undefined) }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'test-ws' }));

import { assemblePresenceSnapshot, type ResolvedPresenceScope } from './presence-snapshot';

const RESOLVED: ResolvedPresenceScope = { scope: 'workspace', wsId: 'test-ws', potId: null };

const row = (ownerId: string, stale: boolean) => ({
  ownerId,
  ownerLabel: `su · ${ownerId}`,
  stale,
  heartbeatAt: null,
  lastActiveAt: null,
  intentDeclaredAt: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  listPresenceMock.mockResolvedValue([row('su-aaa', false), row('su-bbb', false), row('su-ccc', true)]);
});

describe('assemblePresenceSnapshot targeted { owner } lookup (EI-9454)', () => {
  it('enriches ONLY the matched id — the batch joins never see the rest of the roster', async () => {
    const snap = await assemblePresenceSnapshot(RESOLVED, { owner: 'su-bbb' });
    // The load-bearing assertion: every per-owner join got the 1 matched id,
    // not the 2-3 roster ids (under real load: 1 id, not ~67).
    expect(tier1Mock).toHaveBeenCalledWith(['su-bbb']);
    expect(wakeabilityMock).toHaveBeenCalledWith(['su-bbb']);
    expect(fleetMock).toHaveBeenCalledWith(['su-bbb']);
    // Selection semantics preserved: the matched row comes back, alone.
    expect(snap.active.map((r) => (r as { ownerId?: string }).ownerId)).toEqual(['su-bbb']);
    // Summary describes the matched subset on a targeted read.
    expect(snap.summary.active).toBe(1);
    expect(snap.summary.stale).toBe(0);
  });

  it('skips the GC sweep on the targeted point-read', async () => {
    await assemblePresenceSnapshot(RESOLVED, { owner: 'su-bbb' });
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it('matches a STALE owner too — the "inspect one dead agent" path still enriches it', async () => {
    const snap = await assemblePresenceSnapshot(RESOLVED, { owner: 'su-ccc' });
    expect(wakeabilityMock).toHaveBeenCalledWith(['su-ccc']); // stale locals still get wakeability
    expect(tier1Mock).toHaveBeenCalledWith([]); // tier-1 stays ACTIVE-only (P-003) — unchanged
    expect(snap.active.map((r) => (r as { ownerId?: string }).ownerId)).toEqual(['su-ccc']);
    expect(snap.summary.stale).toBe(1);
  });

  it('fuzzy owner match (substring) still works through the early filter', async () => {
    const snap = await assemblePresenceSnapshot(RESOLVED, { owner: 'bbb' });
    expect(snap.active.map((r) => (r as { ownerId?: string }).ownerId)).toEqual(['su-bbb']);
    expect(tier1Mock).toHaveBeenCalledWith(['su-bbb']);
  });

  it('default (no-owner) read is UNCHANGED: whole-roster joins + the GC sweep run', async () => {
    const snap = await assemblePresenceSnapshot(RESOLVED, {});
    expect(sweepMock).toHaveBeenCalledTimes(1);
    expect(tier1Mock).toHaveBeenCalledWith(['su-aaa', 'su-bbb']); // active locals
    expect(wakeabilityMock).toHaveBeenCalledWith(['su-aaa', 'su-bbb', 'su-ccc']); // all locals
    expect(snap.summary.active).toBe(2);
    expect(snap.summary.stale).toBe(1);
  });
});
