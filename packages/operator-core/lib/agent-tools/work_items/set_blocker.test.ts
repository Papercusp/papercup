import { beforeEach, describe, expect, it, vi } from 'vitest';

const getWorkItem = vi.fn();
const mergeWorkItemPayload = vi.fn();
const setWorkItemClaimHold = vi.fn();
const setWorkItemStateWithAliasInfo = vi.fn();
const getModes = vi.fn();
const planItemNeedsHumanContradiction = vi.fn();
vi.mock('../../work-items', () => ({
  getWorkItem: (...args: unknown[]) => getWorkItem(...args),
  mergeWorkItemPayload: (...args: unknown[]) => mergeWorkItemPayload(...args),
  setWorkItemClaimHold: (...args: unknown[]) => setWorkItemClaimHold(...args),
  setWorkItemStateWithAliasInfo: (...args: unknown[]) => setWorkItemStateWithAliasInfo(...args),
}));
vi.mock('../../modes/store', () => ({
  getModes: (...args: unknown[]) => getModes(...args),
}));
vi.mock('../../scheduler/plan-item-lane-guard', () => ({
  planItemNeedsHumanContradiction: (...args: unknown[]) => planItemNeedsHumanContradiction(...args),
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
  planItemNeedsHumanContradiction.mockResolvedValue(null);
});

describe('work_items:set_blocker', () => {
  it('opts out of the ambient workspace transaction', () => {
    expect((tool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

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

  it('a strict human capability records the ask before entering needs-human', async () => {
    const item = { id: 'WI-1', family: 'issue', kind: 'bug', state: 'open', harness: 'papercup', payload: {} };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({ ...item, payload: patch }));

    const out = await one({
      id: 'WI-1',
      kind: 'human',
      capability: 'credential',
      ref: 'credential:prod-db',
      summary: 'Provide the production DB credential.',
      nextVerb: 'setup:save_key',
    });

    expect(out.ok).toBe(true);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      'WI-1',
      'needs-human',
      expect.objectContaining({ by: 'su-a' }),
    );
  });

  it('refuses a strict human capability without a question and unblock action', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-1', family: 'issue', kind: 'bug', state: 'open', payload: {} });
    const out = await one({ id: 'WI-1', kind: 'human', capability: 'credential', ref: 'credential:prod-db' });
    expect(out).toMatchObject({ ok: false, id: 'WI-1' });
    expect(out.error).toMatch(/structured ask requires both.*summary.*nextVerb/);
    expect(mergeWorkItemPayload).not.toHaveBeenCalled();
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('rejects a plan contradiction before writing any blocker payload', async () => {
    const item = {
      id: 'WI-1', family: 'issue', kind: 'bug', state: 'open', harness: 'papercup',
      payload: { plan_item: { plan_slug: 'agent-plan', item_id: 'P-001' } },
    };
    getWorkItem.mockResolvedValue(item);
    planItemNeedsHumanContradiction.mockResolvedValue({
      reason: 'linked plan item agent-plan#P-001 explicitly remains agent-actionable (needsHuman=false)',
      planSlug: 'agent-plan',
      itemIds: ['P-001'],
    });

    const out = await one({
      id: 'WI-1', kind: 'human', capability: 'credential', ref: 'credential:prod-db',
      summary: 'Provide the production DB credential.', nextVerb: 'setup:save_key',
    });

    expect(out).toMatchObject({ ok: false, id: 'WI-1' });
    expect(out.error).toMatch(/agent-actionable.*no blocker was written/);
    expect(mergeWorkItemPayload).not.toHaveBeenCalled();
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
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

  it('EI-13301: feature-family clear restores blocked→open and the response reflects POST-write state', async () => {
    const blocker = {
      kind: 'human',
      capability: 'physical-device',
      ref: 'rig-vm',
      summary: 'VM busy',
      status: 'active',
      createdAt: '2026-07-17T03:00:00.000Z',
      createdBy: 'su-a',
      updatedAt: '2026-07-17T03:00:00.000Z',
    };
    // The item is ALREADY parked 'blocked' (a prior set_blocker call did this) — the
    // clear call below must restore it, and the RETURNED workItem must show the
    // post-restore state, not this pre-write snapshot.
    const item = {
      id: 'WI-1',
      family: 'feature',
      kind: 'feature',
      state: 'blocked',
      harness: 'papercup',
      payload: { externalBlockers: [blocker] },
    };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
      ...item,
      payload: { ...item.payload, ...patch },
    }));
    // work-item-status-full-unify P-007: features restore to the unified claimable
    // token 'open' directly (the legacy 'todo' spelling is retired — no writer
    // produces it and no row sits at it).
    setWorkItemStateWithAliasInfo.mockResolvedValue({
      workItem: { ...item, state: 'open' },
      aliased: false,
      requestedState: 'open',
      appliedState: 'open',
    });

    const out = await one({
      id: 'WI-1',
      kind: 'human',
      ref: 'rig-vm',
      clear: true,
      evidence: 'VM idle now',
    });
    expect(out.ok).toBe(true);
    expect(out.activeBlockers).toEqual([]);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      'WI-1',
      'open',
      expect.objectContaining({ by: 'su-a' }),
    );
    // Defect 2 regression: the returned workItem must be the POST-write ('open')
    // snapshot, not the stale pre-write ('blocked') one merge returned.
    expect(out.workItem.state).toBe('open');
  });

  it('EI-13301 backstop: retries the restore when the primary attempt leaves state stuck at blocked', async () => {
    // Simulates the race/no-op EI-13301 reported: the primary open-restore call fires
    // (updated.state was 'blocked') but its OWN result still reports 'blocked' (a
    // no-op write, or a concurrent write raced it) — the backstop must detect the
    // still-blocked, zero-active-blocker combination and retry rather than returning
    // a stranded item.
    const blocker = {
      kind: 'human',
      capability: 'physical-device',
      ref: 'rig-vm',
      summary: 'VM busy',
      status: 'active',
      createdAt: '2026-07-17T03:00:00.000Z',
      createdBy: 'su-a',
      updatedAt: '2026-07-17T03:00:00.000Z',
    };
    const item = {
      id: 'WI-1',
      family: 'feature',
      kind: 'feature',
      state: 'blocked',
      harness: 'papercup',
      payload: { externalBlockers: [blocker] },
    };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
      ...item,
      payload: { ...item.payload, ...patch },
    }));
    setWorkItemStateWithAliasInfo
      .mockResolvedValueOnce({
        // primary restore attempt: no-op, still 'blocked'
        workItem: { ...item, state: 'blocked' },
        aliased: false,
        requestedState: 'open',
        appliedState: 'blocked',
      })
      .mockResolvedValueOnce({
        // backstop retry: succeeds
        workItem: { ...item, state: 'open' },
        aliased: false,
        requestedState: 'open',
        appliedState: 'open',
      });

    const out = await one({
      id: 'WI-1',
      kind: 'human',
      ref: 'rig-vm',
      clear: true,
      evidence: 'VM idle now',
    });
    expect(out.ok).toBe(true);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledTimes(2);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenLastCalledWith(
      'WI-1',
      'open',
      expect.objectContaining({ by: 'su-a' }),
    );
    // The stranding this backstop exists to prevent: never return 'blocked' with zero
    // active blockers.
    expect(out.workItem.state).toBe('open');
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
      summary: 'Connect a live microphone for the hardware-only verification.',
      nextVerb: 'work_items:set_blocker { clear: true } after the device is connected',
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
      'needs-human',
      expect.objectContaining({ by: 'su-a' }),
    );
  });
});
