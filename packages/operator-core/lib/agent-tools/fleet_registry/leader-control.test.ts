import { beforeEach, describe, expect, it, vi } from 'vitest';

const getModes = vi.fn();
const setMode = vi.fn();
const getLoopStatus = vi.fn();
const materializeLoop = vi.fn();
const buildLoopWakePrompt = vi.fn((_args: unknown) => 'wake prompt');
const listActiveAwaits = vi.fn();
const cancelAwait = vi.fn();
const retireLifecycleBoundWatches = vi.fn();
const registerAwait = vi.fn();
const captureWakeHandleForOwner = vi.fn();
const armInboxWake = vi.fn();
const getPresence = vi.fn();
const getFlag = vi.fn();
const findMatchingActivePredicateWatch = vi.fn();
const registerPredicateWatch = vi.fn();
const startPredicateWatchPoller = vi.fn();

vi.mock('../../modes/store', () => ({
  getModes: (...args: unknown[]) => getModes(...args),
  setMode: (...args: unknown[]) => setMode(...args),
}));

vi.mock('../../harness/routines/loop', () => ({
  getLoopStatus: (...args: unknown[]) => getLoopStatus(...args),
  materializeLoop: (...args: unknown[]) => materializeLoop(...args),
  buildLoopWakePrompt: (args: unknown) => buildLoopWakePrompt(args),
}));

vi.mock('../../events/await/store', () => ({
  listActiveAwaits: (...args: unknown[]) => listActiveAwaits(...args),
  cancelAwait: (...args: unknown[]) => cancelAwait(...args),
  retireLifecycleBoundWatches: (...args: unknown[]) => retireLifecycleBoundWatches(...args),
  registerAwait: (...args: unknown[]) => registerAwait(...args),
}));

vi.mock('../../events/await/handle', () => ({
  captureWakeHandleForOwner: (...args: unknown[]) => captureWakeHandleForOwner(...args),
}));

vi.mock('../../events/await/inbox-wake-arm', () => ({
  armInboxWake: (...args: unknown[]) => armInboxWake(...args),
}));

vi.mock('../../events/await/predicate-watch', () => ({
  findMatchingActivePredicateWatch: (...args: unknown[]) => findMatchingActivePredicateWatch(...args),
  registerPredicateWatch: (...args: unknown[]) => registerPredicateWatch(...args),
  startPredicateWatchPoller: (...args: unknown[]) => startPredicateWatchPoller(...args),
}));

vi.mock('@papercusp/flags/server', () => ({
  getFlag: (...args: unknown[]) => getFlag(...args),
}));

vi.mock('../coordination/presence', () => ({
  getPresence: (...args: unknown[]) => getPresence(...args),
}));

import {
  capLeaderProfileTargets,
  ensureFleetLeaderControl,
  LEADER_MONITOR_INTERVAL_SEC,
  LEADER_PROFILE_AUTO_ARM_CAP,
  resolveFleetLeaderAutoArmTargets,
  resolveFleetLeaderTransitionEventKeys,
  retireFleetLeaderWatches,
} from './leader-control';

const input = {
  workspaceId: 'ws-1',
  ownerId: 'leader-1',
  fleetSlug: 'alpha',
  harnessSlug: 'papercusp',
  planSlug: 'plan-1',
} as const;

function activeWatches() {
  return standardEventKeys().map((eventKey, index) => ({
    id: index + 1,
    eventKey,
    policy: 'wake',
    once: false,
    wakeHandle: { kind: 'psu-socket' },
    boundTo: { kind: 'fleet-leadership', ref: 'alpha' },
    ...(eventKey === 'fleet:member-dead:alpha' || eventKey === 'fleet:context-critical:alpha'
      ? { payloadFilter: { not: { agentId: { equals: input.ownerId } } } }
      : {}),
  }));
}

function standardEventKeys(): string[] {
  return resolveFleetLeaderTransitionEventKeys({ fleetSlug: 'alpha' });
}

beforeEach(() => {
  vi.clearAllMocks();
  getFlag.mockResolvedValue(true);
  getModes.mockResolvedValue([{ mode: 'auto' }]);
  setMode.mockResolvedValue({ ok: true });
  getLoopStatus.mockResolvedValue({
    active: true,
    harnessSlug: 'papercusp',
    intervalSec: LEADER_MONITOR_INTERVAL_SEC,
    mode: 'monitor',
    carry: 'warm',
  });
  materializeLoop.mockResolvedValue(undefined);
  listActiveAwaits.mockResolvedValue(activeWatches());
  captureWakeHandleForOwner.mockResolvedValue({
    handle: { kind: 'psu-socket' },
    note: 'reachable',
  });
  registerAwait.mockImplementation(async (args: Record<string, unknown>) => ({
    ...args,
    id: 100 + registerAwait.mock.calls.length,
  }));
  cancelAwait.mockResolvedValue(undefined);
  retireLifecycleBoundWatches.mockResolvedValue({ awaits: 0, predicateWatches: 0 });
  armInboxWake.mockResolvedValue(undefined);
  getPresence.mockResolvedValue({ potSlug: 'papercusp', agentRole: 'su' });
  findMatchingActivePredicateWatch.mockResolvedValue(null);
  registerPredicateWatch.mockResolvedValue({});
});

describe('retireFleetLeaderWatches', () => {
  it("retires only the departed owner's fleet-leadership binding", async () => {
    retireLifecycleBoundWatches.mockResolvedValue({ awaits: 5, predicateWatches: 1 });

    await expect(retireFleetLeaderWatches('leader-1', 'alpha')).resolves.toBe(6);

    expect(retireLifecycleBoundWatches).toHaveBeenCalledWith(
      { kind: 'fleet-leadership', ref: 'alpha' },
      { ownerIds: ['leader-1'] },
    );
  });
});

describe('ensureFleetLeaderControl', () => {
  it('derives the exact five standard event keys from the fleet-leader auto-arm profile', () => {
    expect(standardEventKeys()).toEqual([
      'fleet:member-dead:alpha',
      'fleet:drained:alpha',
      'fleet:context-critical:alpha',
      'fleet:claim-released:alpha',
      'fleet:admission-blocked:alpha',
    ]);
    expect(standardEventKeys()).not.toContain('fleet:item-completed:alpha');
  });

  it('caps one resolved agent/profile before any watches can be registered', () => {
    const candidates = Array.from({ length: LEADER_PROFILE_AUTO_ARM_CAP + 3 }, (_, index) => `target-${index}`);

    const bounded = capLeaderProfileTargets(candidates);

    expect(bounded.selected).toHaveLength(LEADER_PROFILE_AUTO_ARM_CAP);
    expect(bounded.omitted).toEqual(candidates.slice(LEADER_PROFILE_AUTO_ARM_CAP));
  });

  it('preserves cold-auto (and any registry-derived autonomous posture) instead of switching to plain auto', async () => {
    getModes.mockResolvedValue([{ mode: 'cold-auto' }]);

    const out = await ensureFleetLeaderControl(input);

    expect(out.healthy).toBe(true);
    expect(out.mode).toEqual({ healthy: true, changed: false });
    expect(setMode).not.toHaveBeenCalled();
    expect(materializeLoop).not.toHaveBeenCalled();
    expect(registerAwait).not.toHaveBeenCalled();
    expect(out.watches.cancel).toEqual({
      tool: 'events:cancel',
      args: { await_ids: [1, 2, 3, 4, 5] },
    });
  });

  it('honours the flag-off kill switch by retiring lifecycle-bound profile watches', async () => {
    getFlag.mockResolvedValue(false);
    retireLifecycleBoundWatches.mockResolvedValue({ awaits: 4, predicateWatches: 1 });

    const out = await ensureFleetLeaderControl(input);

    expect(out.healthy).toBe(true);
    expect(out.watches).toMatchObject({ enabled: false, healthy: true, removed: 5, cancel: null });
    expect(retireLifecycleBoundWatches).toHaveBeenCalledWith(
      { kind: 'fleet-leadership', ref: 'alpha' },
      { ownerIds: ['leader-1'] },
    );
    expect(listActiveAwaits).not.toHaveBeenCalled();
    expect(registerAwait).not.toHaveBeenCalled();
  });

  it('fails safe to the default-ON profile when flag lookup errors', async () => {
    getFlag.mockRejectedValue(new Error('flag backend unavailable'));

    const out = await ensureFleetLeaderControl(input);

    expect(out.healthy).toBe(true);
    expect(out.watches.enabled).toBe(true);
    expect(out.watches.flag).toEqual({ fallback: true, error: 'flag backend unavailable' });
    expect(out.watches.active).toEqual(standardEventKeys());
  });

  it('repairs a missing autonomy mode, slow work loop, and absent standing watches in one pass', async () => {
    getModes.mockResolvedValue([]);
    getLoopStatus.mockResolvedValue({
      active: true,
      harnessSlug: 'papercusp',
      intervalSec: 300,
      mode: 'work',
      carry: 'cold',
    });
    listActiveAwaits.mockResolvedValue([]);

    const out = await ensureFleetLeaderControl(input);

    expect(out.healthy).toBe(true);
    expect(out.repaired).toBe(true);
    expect(out.mode).toEqual({ healthy: true, changed: true });
    expect(setMode).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        ownerId: 'leader-1',
        modeId: 'auto',
        enabled: true,
      }),
    );
    expect(materializeLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        harnessSlug: 'papercusp',
        ownerId: 'leader-1',
        intervalSec: LEADER_MONITOR_INTERVAL_SEC,
        carry: 'cold',
        mode: 'monitor',
      }),
    );
    expect(registerAwait).toHaveBeenCalledTimes(5);
    expect(out.watches.added).toEqual(standardEventKeys());
    expect(out.watches.cancel).toEqual({
      tool: 'events:cancel',
      args: { await_ids: [101, 102, 103, 104, 105] },
    });

    const registrations = registerAwait.mock.calls.map(([args]) => args as Record<string, unknown>);
    expect(
      registrations.every(
        (args) => JSON.stringify(args.boundTo) === JSON.stringify({ kind: 'fleet-leadership', ref: 'alpha' }),
      ),
    ).toBe(true);
    expect(registrations.find((args) => args.eventKey === 'fleet:member-dead:alpha')).toMatchObject({
      payloadFilter: { not: { agentId: { equals: 'leader-1' } } },
    });
    expect(registrations.find((args) => args.eventKey === 'fleet:context-critical:alpha')).toMatchObject({
      payloadFilter: { not: { agentId: { equals: 'leader-1' } } },
    });
    for (const eventKey of ['fleet:claim-released:alpha', 'fleet:drained:alpha', 'fleet:admission-blocked:alpha']) {
      expect(registrations.find((args) => args.eventKey === eventKey)).not.toHaveProperty('payloadFilter');
    }
  });

  it('repairs legacy self-transition watches while preserving the other watches as unfiltered', async () => {
    listActiveAwaits.mockResolvedValue(activeWatches().map(({ payloadFilter: _payloadFilter, ...row }) => row));

    const out = await ensureFleetLeaderControl(input);

    expect(out.healthy).toBe(true);
    expect(out.watches.repaired).toEqual(['fleet:member-dead:alpha', 'fleet:context-critical:alpha']);
    expect(registerAwait).toHaveBeenCalledTimes(2);
    expect(registerAwait.mock.calls.map(([args]) => args.eventKey)).toEqual([
      'fleet:member-dead:alpha',
      'fleet:context-critical:alpha',
    ]);
    expect(registerAwait.mock.calls.every(([args]) => args.payloadFilter?.not?.agentId?.equals === 'leader-1')).toBe(
      true,
    );
  });
});
