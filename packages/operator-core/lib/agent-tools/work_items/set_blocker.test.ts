import { beforeEach, describe, expect, it, vi } from 'vitest';

const getWorkItem = vi.fn();
const mergeWorkItemPayload = vi.fn();
const setWorkItemClaimHold = vi.fn();
const setWorkItemStateWithAliasInfo = vi.fn();
const getModes = vi.fn();
vi.mock('../../work-items', () => ({
  getWorkItem: (...args: unknown[]) => getWorkItem(...args),
  mergeWorkItemPayload: (...args: unknown[]) => mergeWorkItemPayload(...args),
  setWorkItemClaimHold: (...args: unknown[]) => setWorkItemClaimHold(...args),
  setWorkItemStateWithAliasInfo: (...args: unknown[]) => setWorkItemStateWithAliasInfo(...args),
}));
vi.mock('../../modes/store', () => ({
  getModes: (...args: unknown[]) => getModes(...args),
}));

import tool from './set_blocker';

const ctx = { uiClientId: 'su-a', isSuperuser: true, workspaceId: 'default' } as never;
const parse = (value: unknown) => (tool.args as { parse: (v: unknown) => unknown }).parse(value);
async function one(value: unknown) {
  const result = (await tool.handler(parse(value) as never, ctx)) as { data: { results: unknown[] } };
  return result.data.results[0] as Record<string, any>;
}

beforeEach(() => {
  vi.clearAllMocks();
  setWorkItemStateWithAliasInfo.mockResolvedValue({
    workItem: { id: 'WI-1', state: 'open' },
    aliased: true,
    requestedState: 'blocked',
    appliedState: 'open',
  });
  setWorkItemClaimHold.mockResolvedValue({ applicable: true, held: false });
  getModes.mockResolvedValue([]);
});

describe('work_items:set_blocker', () => {
  it('persists an event blocker, parks the item, and returns the push-based await key', async () => {
    const item = {
      id: 'WI-1',
      family: 'issue',
      kind: 'bug',
      state: 'open',
      harness: 'papercup',
      payload: { plan_item: { item_id: 'P-008' } },
    };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
      ...item,
      payload: { ...item.payload, ...patch },
    }));

    const out = await one({
      id: 'WI-1',
      kind: 'event',
      capability: 'live-dependency',
      ref: 'deploy:ready:staging',
      summary: 'wait for deploy',
      nextVerb: 'events:await',
    });
    expect(out.ok).toBe(true);
    expect(out.await).toEqual({ event: 'deploy:ready:staging' });
    expect(out.activeBlockers).toHaveLength(1);
    expect(out.capabilityDisposition).toMatchObject({ capability: 'live-dependency', autoClearable: false });
    expect(mergeWorkItemPayload).toHaveBeenCalledWith(
      'WI-1',
      expect.objectContaining({ externalBlockers: expect.any(Array) }),
      { harness: undefined },
    );
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      'WI-1',
      'blocked',
      expect.objectContaining({ by: 'su-a' }),
    );
  });

  it('clears the last blocker, retains history, and removes the issue claim hold', async () => {
    const blocker = {
      kind: 'runtime',
      ref: 'dolphin:dbus',
      summary: 'runtime unavailable',
      status: 'active',
      createdAt: '2026-07-13T08:00:00.000Z',
      createdBy: 'su-a',
      updatedAt: '2026-07-13T08:00:00.000Z',
    };
    const item = {
      id: 'WI-1',
      family: 'issue',
      kind: 'bug',
      state: 'open',
      harness: 'papercup',
      payload: { externalBlockers: [blocker] },
    };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
      ...item,
      payload: { ...item.payload, ...patch },
    }));

    const out = await one({
      id: 'WI-1',
      kind: 'runtime',
      ref: 'dolphin:dbus',
      clear: true,
      evidence: 'DBus responsive',
    });
    expect(out.ok).toBe(true);
    expect(out.activeBlockers).toEqual([]);
    expect(out.blockerHistory[0]).toMatchObject({ status: 'cleared', evidence: 'DBus responsive' });
    expect(setWorkItemClaimHold).toHaveBeenCalledWith(
      'WI-1',
      false,
      expect.objectContaining({ reason: expect.stringContaining('runtime:dolphin:dbus cleared') }),
    );
  });

  it('AUTO authority history-clears approval without parking the item', async () => {
    const item = {
      id: 'WI-1',
      family: 'feature',
      kind: 'feature',
      state: 'todo',
      harness: 'papercup',
      payload: {},
    };
    getModes.mockResolvedValue([{ mode: 'auto' }]);
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
      ...item,
      payload: { ...item.payload, ...patch },
    }));

    const out = await one({
      id: 'WI-1',
      kind: 'human',
      capability: 'approval-auto-clearable',
      ref: 'owner-approval',
    });
    expect(out.ok).toBe(true);
    expect(out.autoCleared).toBe(true);
    expect(out.activeBlockers).toEqual([]);
    expect(out.blockerHistory).toEqual([
      expect.objectContaining({ status: 'cleared', capability: 'approval-auto-clearable' }),
    ]);
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('AUTO authority cannot clear a missing physical device', async () => {
    const item = {
      id: 'WI-1',
      family: 'feature',
      kind: 'feature',
      state: 'todo',
      harness: 'papercup',
      payload: {},
    };
    getModes.mockResolvedValue([{ mode: 'auto' }]);
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
      ...item,
      payload: { ...item.payload, ...patch },
    }));

    const out = await one({
      id: 'WI-1',
      kind: 'human',
      capability: 'physical-device',
      ref: 'live-microphone',
    });
    expect(out.ok).toBe(true);
    expect(out.autoCleared).toBe(false);
    expect(out.activeBlockers).toEqual([expect.objectContaining({ status: 'active', capability: 'physical-device' })]);
    expect(out.capabilityDisposition).toMatchObject({
      capability: 'physical-device',
      autoClearable: false,
      requiresOwnerCapability: true,
    });
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      'WI-1',
      'blocked',
      expect.objectContaining({ by: 'su-a' }),
    );
  });
});
