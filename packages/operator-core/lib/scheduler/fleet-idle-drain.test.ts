/**
 * fleet-idle-drain.test — the second fleet:drained trigger (fleet-leader-frictions-
 * six-improvements-2026-07-10 P-006 / WI-3763): "claim-spec view empty AND every
 * member idle". Pure arithmetic + injected seams, so it unit-tests without PG
 * (fleet-drained-events.test.ts discipline).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AgentAssignment } from '../fleet/assignments';
import {
  allFleetMembersIdle,
  maybeEmitFleetIdleDrain,
  resetIdleDrainDebounce,
  IDLE_DRAIN_DEBOUNCE_MS,
} from './fleet-idle-drain';

const NOW = 1_000_000_000;

/** An AgentAssignment with every field defaulted; override only what a case needs. */
function member(p: Partial<AgentAssignment>): AgentAssignment {
  return {
    agentId: 'su-a',
    label: null,
    name: null,
    present: true,
    alive: true,
    heartbeatAt: null,
    intent: '',
    declaredPlanSlug: null,
    fleetSlug: 'fleet-x',
    fleetRole: 'member',
    claims: [],
    orphaned: false,
    stalled: false,
    declaredUnclaimed: false,
    doing: null,
    queued: [],
    load: 0,
    ...p,
  };
}

describe('allFleetMembersIdle (pure)', () => {
  it('an empty member list is NOT idle — nothing to observe', () => {
    expect(allFleetMembersIdle([], new Map(), NOW)).toBe(false);
  });

  it('true when every member is idle (no fresh tool call)', () => {
    const members = [member({ agentId: 'su-a' }), member({ agentId: 'su-b' })];
    const lastCalls = new Map<string, number | null>([
      ['su-a', NOW - 10 * 60_000],
      ['su-b', null],
    ]);
    expect(allFleetMembersIdle(members, lastCalls, NOW)).toBe(true);
  });

  it('false when even ONE member is speaking (fresh tool call)', () => {
    const members = [member({ agentId: 'su-a' }), member({ agentId: 'su-b' })];
    const lastCalls = new Map<string, number | null>([
      ['su-a', NOW - 10 * 60_000],
      ['su-b', NOW - 30_000], // within the 5-min speaking window
    ]);
    expect(allFleetMembersIdle(members, lastCalls, NOW)).toBe(false);
  });

  it('a dead or stalled member still counts as idle (not speaking)', () => {
    const members = [
      member({ agentId: 'su-dead', alive: false }),
      member({ agentId: 'su-stalled', stalled: true, load: 1 }),
    ];
    expect(allFleetMembersIdle(members, new Map(), NOW)).toBe(true);
  });
});

describe('maybeEmitFleetIdleDrain (orchestrator, injected seams)', () => {
  beforeEach(() => resetIdleDrainDebounce());

  it('no-op for a caller with no fleet membership', async () => {
    const emit = vi.fn();
    const listAssignments = vi.fn();
    const fetchMembership = vi.fn().mockResolvedValue(null);
    maybeEmitFleetIdleDrain('su-solo', 'ws', { emit, listAssignments, fetchMembership, now: () => NOW });
    await flush();
    expect(fetchMembership).toHaveBeenCalledWith('ws', 'su-solo');
    expect(listAssignments).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('emits fleet:drained:<slug> when every member is idle', async () => {
    const emit = vi.fn();
    const fetchMembership = vi.fn().mockResolvedValue({ fleetSlug: 'fleet-x', fleetRole: 'member' });
    const listAssignments = vi.fn().mockResolvedValue([
      rowFor('su-a', 'fleet-x'),
      rowFor('su-b', 'fleet-x'),
    ]);
    const fetchLastToolCalls = vi.fn().mockResolvedValue(new Map());
    maybeEmitFleetIdleDrain('su-a', 'ws', { emit, listAssignments, fetchMembership, fetchLastToolCalls, now: () => NOW });
    await flush();
    expect(emit).toHaveBeenCalledWith('fleet-x');
  });

  it('does NOT emit when a member is speaking', async () => {
    const emit = vi.fn();
    const fetchMembership = vi.fn().mockResolvedValue({ fleetSlug: 'fleet-x', fleetRole: 'member' });
    const listAssignments = vi.fn().mockResolvedValue([rowFor('su-a', 'fleet-x'), rowFor('su-b', 'fleet-x')]);
    const fetchLastToolCalls = vi
      .fn()
      .mockResolvedValue(new Map([['su-b', new Date(NOW - 30_000).toISOString()]]));
    maybeEmitFleetIdleDrain('su-a', 'ws', { emit, listAssignments, fetchMembership, fetchLastToolCalls, now: () => NOW });
    await flush();
    expect(emit).not.toHaveBeenCalled();
  });

  it('debounces repeat emits for the same fleet within the window', async () => {
    const emit = vi.fn();
    const fetchMembership = vi.fn().mockResolvedValue({ fleetSlug: 'fleet-x', fleetRole: 'member' });
    const listAssignments = vi.fn().mockResolvedValue([rowFor('su-a', 'fleet-x')]);
    const fetchLastToolCalls = vi.fn().mockResolvedValue(new Map());
    const deps = { emit, listAssignments, fetchMembership, fetchLastToolCalls, now: () => NOW };
    maybeEmitFleetIdleDrain('su-a', 'ws', deps);
    await flush();
    maybeEmitFleetIdleDrain('su-a', 'ws', { ...deps, now: () => NOW + IDLE_DRAIN_DEBOUNCE_MS - 1 });
    await flush();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('re-arms after the debounce window elapses', async () => {
    const emit = vi.fn();
    const fetchMembership = vi.fn().mockResolvedValue({ fleetSlug: 'fleet-x', fleetRole: 'member' });
    const listAssignments = vi.fn().mockResolvedValue([rowFor('su-a', 'fleet-x')]);
    const fetchLastToolCalls = vi.fn().mockResolvedValue(new Map());
    const deps = { emit, listAssignments, fetchMembership, fetchLastToolCalls, now: () => NOW };
    maybeEmitFleetIdleDrain('su-a', 'ws', deps);
    await flush();
    maybeEmitFleetIdleDrain('su-a', 'ws', { ...deps, now: () => NOW + IDLE_DRAIN_DEBOUNCE_MS + 1 });
    await flush();
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('never throws when a dependency rejects (fire-and-forget)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMembership = vi.fn().mockRejectedValue(new Error('pg down'));
    expect(() => maybeEmitFleetIdleDrain('su-a', 'ws', { fetchMembership })).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pg down'));
    warn.mockRestore();
  });
});

/** A minimal 'presence' fleet_assignment row for a member of `fleetSlug`, shaped
 *  the way `groupByAgent` expects (only the fields it reads are non-default). */
function rowFor(agentId: string, fleetSlug: string) {
  return {
    source: 'presence' as const,
    workspaceId: 'w',
    agentId,
    agentLabel: null,
    agentName: null,
    harnessSlug: null,
    planSlug: null,
    itemId: null,
    workItemId: null,
    itemKind: null,
    detail: '',
    status: null,
    claimAcquiredTs: null,
    claimExpiresTs: null,
    claimActive: null,
    livenessMode: null,
    lastActivityTs: null,
    holderPresent: true,
    holderAlive: true,
    holderHeartbeatAt: null,
    holderIntent: null,
    holderPlanSlug: null,
    orphaned: false,
    stalled: null,
    lastProgressAt: null,
    declaredPlanMatches: null,
    assigneeRank: null,
    rankWriter: null,
    fleetSlug,
    fleetRole: 'member',
  };
}

/** Flush the microtask queue so `void Promise.resolve().then(...)` settles. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
