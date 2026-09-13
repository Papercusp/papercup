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
 * EI-21488009366204518 adds the FOURTH synthesis leg: an owner whose presence
 * row was REAPED but whose adv_sessions records the death must answer a targeted
 * `{ owner }` lookup with an explicit synthesized `ended` row — never an empty
 * roster indistinguishable from "never existed". The tail of this file pins that.
 *
 * Hermetic: every IO seam is mocked; the pure helpers (matchesOwner,
 * selectRosterRows, mergeTier1, toStableRosterRow, deriveSessionState,
 * synthesizeEndedRosterRows) stay real so the selected rows keep production
 * semantics.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.mock factories are hoisted above module-level consts — vi.hoisted() is the
// sanctioned way to share spies with them (a bare `const` here hits the TDZ).
const {
  listPresenceMock,
  federatedMock,
  recordedLiveSessionsMock,
  nurseryAliasMock,
  sweepMock,
  tier1Mock,
  wakeabilityMock,
  selfWakeMock,
  fleetMock,
  findLiveHostMock,
  endedSessionsMock,
  endedOwnersMock,
} = vi.hoisted(() => ({
  listPresenceMock: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  federatedMock: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  recordedLiveSessionsMock: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  nurseryAliasMock: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  sweepMock: vi.fn(async (..._a: unknown[]) => 0),
  tier1Mock: vi.fn(async (..._a: unknown[]) => new Map()),
  wakeabilityMock: vi.fn(async (..._a: unknown[]) => new Map()),
  selfWakeMock: vi.fn(async (..._a: unknown[]) => new Map()),
  fleetMock: vi.fn(async (..._a: unknown[]) => new Map()),
  findLiveHostMock: vi.fn<(id: string) => { ownerId: string } | null>(() => null),
  // EI-21488009366204518: the targeted-miss session-log death leg.
  endedSessionsMock: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  endedOwnersMock: vi.fn(async () => new Set<string>()),
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
vi.mock('./federated-presence', () => ({ listFederatedPresence: federatedMock }));
vi.mock('../../adv-sessions', async (orig) => ({
  ...(await orig<typeof import('../../adv-sessions')>()),
  endedRecordedOwnerIds: endedOwnersMock,
  listRecordedLiveSessions: recordedLiveSessionsMock,
  // Unification P-002: the snapshot's recorded-session oracle leg.
  recordedLiveOwnerIds: vi.fn(async () => new Set<string>()),
  // EI-21488009366204518: the targeted-miss session-log death leg.
  listEndedAdvSessionsByOwners: endedSessionsMock,
}));
// Pass-through reconcile: the test rows below are already RosterRow-shaped.
// importOriginal keeps the REAL synthesizeEndedRosterRows so the
// EI-21488009366204518 leg runs its production synthesis in these fixtures.
vi.mock('./recorded-sessions', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reconcileRosterSources: (rows: unknown[]) => rows,
  RECORDED_SESSION_SOURCE: 'recorded-session',
}));
// EI-16639: the nursery-alias leg — no running nursery bees in these fixtures,
// so it contributes nothing (existing counts/ids stay exactly as asserted below).
vi.mock('./nursery-alias-liveness', () => ({
  listRunningNurseryAliasRows: nurseryAliasMock,
  synthesizeNurseryAliasRosterRows: () => [],
  NURSERY_ALIAS_SOURCE: 'nursery-alias',
}));
vi.mock('./presence-tier1', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchPresenceTier1: tier1Mock,
}));
vi.mock('./presence-wakeability', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchWakeability: wakeabilityMock,
}));
vi.mock('./presence-selfwake', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchSelfWake: selfWakeMock,
}));
vi.mock('./presence-fleet', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchPresenceFleet: fleetMock,
}));
vi.mock('../../events/await/psu-pty-discovery', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  findLiveHost: findLiveHostMock,
}));
vi.mock('../../desktop-window-liveness', () => ({
  gatherOnDesktopSessions: vi.fn(async () => ({ owners: new Set<string>() })),
}));
vi.mock('../../pty-viewer-heartbeat', () => ({ gatherViewerAttachedOwners: vi.fn(async () => new Set<string>()) }));
vi.mock('../locks/su-lock-store', () => ({
  getTxPool: vi.fn(),
  readPathInterestsByOwner: vi.fn(async () => []),
}));
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
  // clearAllMocks keeps mockResolvedValue IMPLEMENTATIONS — restore the leg
  // defaults explicitly so the EI-21488009366204518 tests cannot leak their
  // fixtures into each other (order-dependent false positives).
  endedSessionsMock.mockResolvedValue([]);
  endedOwnersMock.mockResolvedValue(new Set<string>());
  listPresenceMock.mockResolvedValue([row('su-aaa', false), row('su-bbb', false), row('su-ccc', true)]);
  federatedMock.mockResolvedValue([]);
  recordedLiveSessionsMock.mockResolvedValue([]);
  nurseryAliasMock.mockResolvedValue([]);
  selfWakeMock.mockResolvedValue(new Map());
});

describe('assemblePresenceSnapshot targeted { owner } lookup (EI-9454)', () => {
  it('pushes targeted selectors into every broad source leg', async () => {
    await assemblePresenceSnapshot(RESOLVED, { owner: 'su-bbb' });

    expect(listPresenceMock).toHaveBeenCalledWith({
      workspaceId: 'test-ws',
      potSlug: null,
      ownerIds: ['su-bbb'],
    });
    expect(federatedMock).toHaveBeenCalledWith({
      workspaceId: 'test-ws',
      potSlug: null,
      ownerIds: ['su-bbb'],
    });
    expect(recordedLiveSessionsMock).toHaveBeenCalledWith({
      workspaceId: 'test-ws',
      ownerIds: ['su-bbb'],
    });
    expect(nurseryAliasMock).toHaveBeenCalledWith({
      workspaceId: 'test-ws',
      ownerIds: ['su-bbb'],
    });
  });

  it('enriches ONLY the matched id — the batch joins never see the rest of the roster', async () => {
    const snap = await assemblePresenceSnapshot(RESOLVED, { owner: 'su-bbb' });
    // The load-bearing assertion: every per-owner join got the 1 matched id,
    // not the 2-3 roster ids (under real load: 1 id, not ~67).
    expect(tier1Mock).toHaveBeenCalledWith(['su-bbb']);
    expect(wakeabilityMock).toHaveBeenCalledWith(['su-bbb']);
    expect(selfWakeMock).toHaveBeenCalledWith(['su-bbb']);
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

  it('positive live psu host keeps a non-wakeable su row out of ended', async () => {
    const owner = 'su-pty-live';
    listPresenceMock.mockResolvedValue([{ ...row(owner, false), agentRole: 'su', source: 'psu' }]);
    wakeabilityMock.mockResolvedValue(new Map([[owner, { wakeable: false, liveTurn: false }]]));
    findLiveHostMock.mockImplementation((id: string) => (id === owner ? { ownerId: id } : null));

    const snap = await assemblePresenceSnapshot(RESOLVED, {});
    expect(snap.active.find((r) => r.ownerId === owner)?.sessionState).toBe('recorded');
  });

  it('emits parked + selfWake:none so a healthy-looking member is visibly stranded', async () => {
    const owner = 'su-stranded';
    listPresenceMock.mockResolvedValue([row(owner, false)]);
    wakeabilityMock.mockResolvedValue(new Map([[owner, { wakeable: true, liveTurn: false }]]));
    selfWakeMock.mockResolvedValue(
      new Map([[owner, { loopArmed: false, standingEventAwait: false, selfWake: 'none' }]]),
    );

    const snap = await assemblePresenceSnapshot(RESOLVED, {});
    expect(snap.active[0]).toMatchObject({
      ownerId: owner,
      sessionState: 'parked',
      wakeable: true,
      loopArmed: false,
      selfWake: 'none',
    });
  });

  it('emits null self-wake fields when enrichment is absent, never fabricating none', async () => {
    const owner = 'su-selfwake-unknown';
    listPresenceMock.mockResolvedValue([row(owner, false)]);
    wakeabilityMock.mockResolvedValue(new Map([[owner, { wakeable: true, liveTurn: false }]]));
    selfWakeMock.mockResolvedValue(new Map());

    const snap = await assemblePresenceSnapshot(RESOLVED, {});
    expect(snap.active[0]).toMatchObject({
      ownerId: owner,
      sessionState: 'parked',
      loopArmed: null,
      selfWake: null,
    });
  });
});

describe('assemblePresenceSnapshot targeted { owner } lookup — reaped-row session-log leg (EI-21488009366204518)', () => {
  const DEAD = 'su-reaped-dead';
  const endedSessionRow = {
    coordOwnerId: DEAD,
    workspaceId: 'test-ws',
    planSlug: null,
    role: 'su',
    pid: null,
    startedAt: '2026-08-25T13:00:00.000Z',
    endedAt: '2026-08-25T14:06:45.000Z',
    label: null,
  };

  it('synthesizes an ENDED row for a reaped owner whose adv_sessions records the death', async () => {
    endedSessionsMock.mockResolvedValue([endedSessionRow]);
    // The oracle legs that classify the synthesized base row as explicit `ended`:
    // not wakeable + positive recorded death evidence for its id.
    wakeabilityMock.mockResolvedValue(new Map([[DEAD, { wakeable: false, liveTurn: false }]]));
    endedOwnersMock.mockResolvedValue(new Set([DEAD]));

    const snap = await assemblePresenceSnapshot(RESOLVED, { owner: DEAD });
    // The miss fired the leg with exactly the needle…
    expect(endedSessionsMock).toHaveBeenCalledWith([DEAD]);
    // …the synthesized row came back…
    const emitted = snap.active.find((r) => r.ownerId === DEAD);
    expect(emitted).toBeDefined();
    // …and the oracle classified it explicitly dead, not unknown.
    expect(emitted?.sessionState).toBe('ended');
    // The summary says HOW the needle resolved (session-log evidence, not presence).
    expect(snap.summary.ownerLookup).toEqual({ needle: DEAD, matched: 1, fromSessionLog: true });
  });

  it('a genuinely UNKNOWN id stays an explicit not-found, distinct from the ended case', async () => {
    const snap = await assemblePresenceSnapshot(RESOLVED, { owner: 'su-never-existed' });
    expect(endedSessionsMock).toHaveBeenCalledWith(['su-never-existed']); // the leg ran…
    expect(snap.active).toEqual([]); // …found nothing…
    // …and the summary says so EXPLICITLY instead of reading as silent absence.
    expect(snap.summary.ownerLookup).toEqual({ needle: 'su-never-existed', matched: 0, fromSessionLog: false });
  });

  it('the ended-session leg is never queried when the needle matches the roster', async () => {
    await assemblePresenceSnapshot(RESOLVED, { owner: 'su-bbb' });
    expect(endedSessionsMock).not.toHaveBeenCalled();
  });

  it('the default (no-owner) read never pays the session-log leg', async () => {
    await assemblePresenceSnapshot(RESOLVED, {});
    expect(endedSessionsMock).not.toHaveBeenCalled();
  });
});
