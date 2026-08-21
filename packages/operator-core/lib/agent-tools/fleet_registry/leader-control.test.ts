import { beforeEach, describe, expect, it, vi } from 'vitest';

const getModes = vi.fn();
const setMode = vi.fn();
const getLoopStatus = vi.fn();
const materializeLoop = vi.fn();
const buildLoopWakePrompt = vi.fn((_args: unknown) => 'wake prompt');
const listActiveAwaits = vi.fn();
const cancelAwait = vi.fn();
const cancelAwaitsForSubscribersOnKeys = vi.fn();
const registerAwait = vi.fn();
const captureWakeHandleForOwner = vi.fn();
const armInboxWake = vi.fn();
const getPresence = vi.fn();

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
  cancelAwaitsForSubscribersOnKeys: (...args: unknown[]) => cancelAwaitsForSubscribersOnKeys(...args),
  registerAwait: (...args: unknown[]) => registerAwait(...args),
}));

vi.mock('../../events/await/handle', () => ({
  captureWakeHandleForOwner: (...args: unknown[]) => captureWakeHandleForOwner(...args),
}));

vi.mock('../../events/await/inbox-wake-arm', () => ({
  armInboxWake: (...args: unknown[]) => armInboxWake(...args),
}));

vi.mock('../coordination/presence', () => ({
  getPresence: (...args: unknown[]) => getPresence(...args),
}));

import {
  ensureFleetLeaderControl,
  LEADER_MONITOR_INTERVAL_SEC,
  LEADER_TRANSITION_EVENTS,
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
  return LEADER_TRANSITION_EVENTS.map((transition, index) => ({
    id: `await-${index}`,
    eventKey: `fleet:${transition}:alpha`,
    policy: 'wake',
    once: false,
    wakeHandle: { kind: 'psu-socket' },
    ...(transition === 'member-dead' || transition === 'context-critical'
      ? { payloadFilter: { not: { agentId: { equals: input.ownerId } } } }
      : {}),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
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
    id: 'new-await',
  }));
  cancelAwait.mockResolvedValue(undefined);
  cancelAwaitsForSubscribersOnKeys.mockResolvedValue(0);
  armInboxWake.mockResolvedValue(undefined);
  getPresence.mockResolvedValue({ potSlug: 'papercusp' });
});

describe('retireFleetLeaderWatches', () => {
  it('cancels only the exact standing transition keys for the departed fleet', async () => {
    cancelAwaitsForSubscribersOnKeys.mockResolvedValue(5);

    await expect(retireFleetLeaderWatches('leader-1', 'alpha')).resolves.toBe(5);

    expect(cancelAwaitsForSubscribersOnKeys).toHaveBeenCalledWith(
      ['leader-1'],
      LEADER_TRANSITION_EVENTS.map((transition) => `fleet:${transition}:alpha`),
    );
  });
});

describe('ensureFleetLeaderControl', () => {
  it('preserves cold-auto (and any registry-derived autonomous posture) instead of switching to plain auto', async () => {
    getModes.mockResolvedValue([{ mode: 'cold-auto' }]);

    const out = await ensureFleetLeaderControl(input);

    expect(out.healthy).toBe(true);
    expect(out.mode).toEqual({ healthy: true, changed: false });
    expect(setMode).not.toHaveBeenCalled();
    expect(materializeLoop).not.toHaveBeenCalled();
    expect(registerAwait).not.toHaveBeenCalled();
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
    expect(setMode).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1',
      ownerId: 'leader-1',
      modeId: 'auto',
      enabled: true,
    }));
    expect(materializeLoop).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      ownerId: 'leader-1',
      intervalSec: LEADER_MONITOR_INTERVAL_SEC,
      carry: 'cold',
      mode: 'monitor',
    }));
    expect(registerAwait).toHaveBeenCalledTimes(LEADER_TRANSITION_EVENTS.length);
    expect(out.watches.added).toEqual(
      LEADER_TRANSITION_EVENTS.map((transition) => `fleet:${transition}:alpha`),
    );

    const registrations = registerAwait.mock.calls.map(([args]) => args as Record<string, unknown>);
    expect(registrations.find((args) => args.eventKey === 'fleet:member-dead:alpha')).toMatchObject({
      payloadFilter: { not: { agentId: { equals: 'leader-1' } } },
    });
    expect(registrations.find((args) => args.eventKey === 'fleet:context-critical:alpha')).toMatchObject({
      payloadFilter: { not: { agentId: { equals: 'leader-1' } } },
    });
    for (const eventKey of [
      'fleet:claim-released:alpha',
      'fleet:item-completed:alpha',
      'fleet:drained:alpha',
    ]) {
      expect(registrations.find((args) => args.eventKey === eventKey)).not.toHaveProperty('payloadFilter');
    }
  });

  it('repairs legacy self-transition watches while preserving the other watches as unfiltered', async () => {
    listActiveAwaits.mockResolvedValue(
      activeWatches().map(({ payloadFilter: _payloadFilter, ...row }) => row),
    );

    const out = await ensureFleetLeaderControl(input);

    expect(out.healthy).toBe(true);
    expect(out.watches.repaired).toEqual([
      'fleet:member-dead:alpha',
      'fleet:context-critical:alpha',
    ]);
    expect(registerAwait).toHaveBeenCalledTimes(2);
    expect(registerAwait.mock.calls.map(([args]) => args.eventKey)).toEqual([
      'fleet:member-dead:alpha',
      'fleet:context-critical:alpha',
    ]);
    expect(registerAwait.mock.calls.every(([args]) =>
      args.payloadFilter?.not?.agentId?.equals === 'leader-1',
    )).toBe(true);
  });
});
