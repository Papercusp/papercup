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

  it('accepts legacy capability-in-kind calls and persists the canonical human blocker', async () => {
    const item = {
      id: 'WI-credential-alias',
      family: 'issue',
      kind: 'bug',
      state: 'open',
      harness: 'papercusp',
      payload: {},
    };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
      ...item,
      payload: { ...item.payload, ...patch },
    }));
    setWorkItemStateWithAliasInfo.mockResolvedValueOnce({
      workItem: { ...item, state: 'needs-human' },
      aliased: false,
      requestedState: 'needs-human',
      appliedState: 'needs-human',
    });

    const out = await one({
      id: item.id,
      kind: 'credential',
      ref: 'credential:prod-db',
      summary: 'Provide the production DB credential.',
      nextVerb: 'setup:save_key',
    });

    expect(out).toMatchObject({
      ok: true,
      workItem: { state: 'needs-human' },
      activeBlockers: [
        expect.objectContaining({
          kind: 'human',
          capability: 'credential',
          ref: 'credential:prod-db',
          status: 'active',
        }),
      ],
    });
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      item.id,
      'needs-human',
      expect.objectContaining({ by: 'su-a' }),
    );
  });

  it('rejects an ambiguous capability shorthand combined with a different capability', () => {
    expect(() =>
      parse({
        id: 'WI-1',
        kind: 'credential',
        capability: 'physical-device',
        ref: 'credential:prod-db',
      }),
    ).toThrow(/shorthand for capability 'credential'.*physical-device/);
  });

  it('requires an explicit trigger kind when live-dependency is the capability', () => {
    expect(() =>
      parse({
        id: 'WI-1',
        kind: 'live-dependency',
        ref: 'deploy:ready:staging',
      }),
    ).toThrow();
    expect(() =>
      parse({
        id: 'WI-1',
        kind: 'event',
        capability: 'live-dependency',
        ref: 'deploy:ready:staging',
      }),
    ).not.toThrow();
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

  it('rejects a main/green-checkpoint blocker for ordinary implementation work', async () => {
    const item = {
      id: 'WI-1',
      family: 'issue',
      kind: 'change',
      state: 'open',
      harness: 'papercup',
      title: 'Implement the fact-plane fairness policy',
      summary: 'Run focused tests on staging and continue implementation.',
      payload: {},
    };
    getWorkItem.mockResolvedValue(item);

    const out = await one({
      id: 'WI-1',
      kind: 'gate',
      capability: 'live-dependency',
      ref: 'gate.greenCheckpoint.ownership',
      summary: 'Wait for main to turn green before continuing implementation.',
      nextVerb: 'release:checkpoint-run',
    });

    expect(out).toMatchObject({ ok: false, id: 'WI-1', code: 'non_final_deployed_main_blocker' });
    expect(out.error).toMatch(/Continue implementation.*staging\/current-build/);
    expect(mergeWorkItemPayload).not.toHaveBeenCalled();
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('does not let item metadata launder a generic deployed-main blocker', async () => {
    const item = {
      id: 'EI-23090624251629318',
      family: 'issue',
      kind: 'bug',
      state: 'open',
      harness: 'papercusp',
      title: 'work_items:set_blocker rejects generic deployed-parity blocker without deployed-only contract wording',
      summary:
        'A valid gate blocker write was refused by the non-final deployed-main guard because the payload did not explicitly name a deployed-only property, state what staging/current-build cannot exercise, and give a concrete reason. The remediation is to narrow the blocker text.',
      payload: {},
    };
    getWorkItem.mockResolvedValue(item);

    const out = await one({
      id: item.id,
      kind: 'gate',
      capability: 'live-dependency',
      ref: 'gate.greenCheckpoint.ownership',
      summary: 'Wait for main to turn green before continuing implementation.',
      evidence: 'The ordinary implementation still needs the release plane before continuing.',
      nextVerb: 'release:checkpoint-run',
    });

    expect(out).toMatchObject({ ok: false, id: item.id, code: 'non_final_deployed_main_blocker' });
    expect(mergeWorkItemPayload).not.toHaveBeenCalled();
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('allows the actual green-checkpoint repair item to record its gate blocker', async () => {
    const item = {
      id: 'WI-212675',
      family: 'issue',
      kind: 'bug',
      state: 'open',
      harness: 'papercup',
      title: '[gate-red-streak] Re-green current green-checkpoint and restore tested/deployed parity',
      summary: 'Run the scheduled checkpoint and restore release parity.',
      payload: {},
    };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({ ...item, payload: patch }));

    const out = await one({
      id: 'WI-212675',
      kind: 'gate',
      capability: 'live-dependency',
      ref: 'gate.greenCheckpoint.ownership',
      summary: 'Wait for the scheduled checkpoint verdict.',
      nextVerb: 'release:trace',
    });

    expect(out.ok).toBe(true);
    expect(out.activeBlockers).toHaveLength(1);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      'WI-212675',
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

  it('parks a plan-linked item when the plan lane is already needs-human for an external service action', async () => {
    const item = {
      id: 'WI-plan-human',
      family: 'issue',
      kind: 'bug',
      state: 'open',
      harness: 'papercusp',
      payload: { plan_item: { plan_slug: 'owner-plan', item_id: 'P-001' } },
    };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
      ...item,
      payload: { ...item.payload, ...patch },
    }));
    setWorkItemStateWithAliasInfo.mockResolvedValue({
      workItem: { ...item, state: 'needs-human' },
      aliased: false,
      requestedState: 'needs-human',
      appliedState: 'needs-human',
    });

    const out = await one({
      id: 'WI-plan-human',
      kind: 'human',
      capability: 'external-service-action',
      ref: 'cloudinary:r2-migration',
      summary: 'Have the external service operator enable the migration endpoint.',
      nextVerb: 'work_items:set_blocker { clear: true } after the endpoint is enabled',
    });

    expect(planItemNeedsHumanContradiction).toHaveBeenCalledWith(item);
    expect(out).toMatchObject({
      ok: true,
      id: 'WI-plan-human',
      workItem: { state: 'needs-human' },
      activeBlockers: [
        expect.objectContaining({
          kind: 'human',
          capability: 'external-service-action',
          ref: 'cloudinary:r2-migration',
          status: 'active',
        }),
      ],
    });
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      'WI-plan-human',
      'needs-human',
      expect.objectContaining({ by: 'su-a' }),
    );
  });

  it('parks an already-blocked plan-linked item when the plan lane is already needs-human', async () => {
    const item = {
      id: 'WI-plan-human-blocked',
      family: 'issue',
      kind: 'bug',
      state: 'blocked',
      harness: 'papercusp',
      payload: { plan_item: { plan_slug: 'owner-plan', item_id: 'P-001' } },
    };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
      ...item,
      payload: { ...item.payload, ...patch },
    }));
    setWorkItemStateWithAliasInfo.mockResolvedValue({
      workItem: { ...item, state: 'needs-human' },
      aliased: false,
      requestedState: 'needs-human',
      appliedState: 'needs-human',
    });

    const out = await one({
      id: 'WI-plan-human-blocked',
      kind: 'human',
      capability: 'external-service-action',
      ref: 'cloudinary:r2-migration',
      summary: 'Have the external service operator enable the migration endpoint.',
      nextVerb: 'work_items:set_blocker { clear: true } after the endpoint is enabled',
    });

    expect(planItemNeedsHumanContradiction).toHaveBeenCalledWith(item);
    expect(out).toMatchObject({
      ok: true,
      id: 'WI-plan-human-blocked',
      workItem: { state: 'needs-human' },
      activeBlockers: [
        expect.objectContaining({
          kind: 'human',
          capability: 'external-service-action',
          ref: 'cloudinary:r2-migration',
          status: 'active',
        }),
      ],
    });
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      'WI-plan-human-blocked',
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

  it('accepts a clear-only request and infers the sole active blocker kind', async () => {
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
      ref: 'dolphin:dbus',
      clear: true,
      evidence: 'DBus responsive',
    });

    expect(out.ok).toBe(true);
    expect(out.changed).toBe(true);
    expect(out.activeBlockers).toEqual([]);
    expect(out.blockerHistory[0]).toMatchObject({ status: 'cleared', evidence: 'DBus responsive' });
    expect(setWorkItemClaimHold).toHaveBeenCalledWith(
      'WI-1',
      false,
      expect.objectContaining({ reason: expect.stringContaining('runtime:dolphin:dbus cleared') }),
    );
  });

  it('accepts an id-only clear when the item has one active blocker', async () => {
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

    const out = await one({ id: 'WI-1', clear: true, evidence: 'DBus responsive' });

    expect(out).toMatchObject({ ok: true, changed: true, activeBlockers: [] });
    expect(out.blockerHistory[0]).toMatchObject({ ref: 'dolphin:dbus', status: 'cleared', evidence: 'DBus responsive' });
    expect(setWorkItemClaimHold).toHaveBeenCalledWith(
      'WI-1',
      false,
      expect.objectContaining({ reason: expect.stringContaining('runtime:dolphin:dbus cleared') }),
    );
  });

  it('requires kind for a set request but accepts kind-less clear-only bulk entries', () => {
    expect(() => parse({ id: 'WI-1', ref: 'dolphin:dbus' })).toThrow(/kind is required/);
    expect(() => parse({ items: [{ id: 'WI-1', ref: 'dolphin:dbus' }] })).toThrow(/kind is required/);
    expect(() => parse({ id: 'WI-1', clear: true })).not.toThrow();
    expect(() => parse({ items: [{ id: 'WI-1', clear: true }] })).not.toThrow();
    expect(() => parse({ id: 'WI-1', ref: 'dolphin:dbus', clear: true })).not.toThrow();
    expect(() => parse({ items: [{ id: 'WI-1', ref: 'dolphin:dbus', clear: true }] })).not.toThrow();
  });

  it('refuses an id-only clear when multiple active blockers match', async () => {
    const blocker = (kind: 'runtime' | 'event', ref: string) => ({
      kind,
      ref,
      summary: `${kind} blocker`,
      status: 'active',
      createdAt: '2026-07-13T08:00:00.000Z',
      createdBy: 'su-a',
      updatedAt: '2026-07-13T08:00:00.000Z',
    });
    getWorkItem.mockResolvedValue({
      id: 'WI-1',
      family: 'issue',
      kind: 'bug',
      state: 'blocked',
      payload: { externalBlockers: [blocker('runtime', 'dbus'), blocker('event', 'deploy:ready')] },
    });

    const out = await one({ id: 'WI-1', clear: true });

    expect(out).toMatchObject({ ok: false, id: 'WI-1' });
    expect(out.error).toMatch(/omitted ref.*matches 2 active blockers.*pass ref explicitly/);
    expect(mergeWorkItemPayload).not.toHaveBeenCalled();
    expect(setWorkItemClaimHold).not.toHaveBeenCalled();
  });

  it('refuses a clear-only request when the ref is active under multiple kinds', async () => {
    const blocker = (kind: 'runtime' | 'event') => ({
      kind,
      ref: 'shared-ref',
      summary: `${kind} blocker`,
      status: 'active',
      createdAt: '2026-07-13T08:00:00.000Z',
      createdBy: 'su-a',
      updatedAt: '2026-07-13T08:00:00.000Z',
    });
    getWorkItem.mockResolvedValue({
      id: 'WI-1',
      family: 'issue',
      kind: 'bug',
      state: 'open',
      payload: { externalBlockers: [blocker('runtime'), blocker('event')] },
    });

    const out = await one({ id: 'WI-1', ref: 'shared-ref', clear: true });

    expect(out).toMatchObject({ ok: false, id: 'WI-1' });
    expect(out.error).toMatch(/ambiguous.*runtime.*event.*pass kind explicitly/);
    expect(mergeWorkItemPayload).not.toHaveBeenCalled();
    expect(setWorkItemClaimHold).not.toHaveBeenCalled();
  });

  it('rejects a plan contradiction before writing any blocker payload', async () => {
    const item = {
      id: 'WI-1',
      family: 'issue',
      kind: 'bug',
      state: 'open',
      harness: 'papercup',
      payload: { plan_item: { plan_slug: 'agent-plan', item_id: 'P-001' } },
    };
    getWorkItem.mockResolvedValue(item);
    planItemNeedsHumanContradiction.mockResolvedValue({
      reason: 'linked plan item agent-plan#P-001 explicitly remains agent-actionable (needsHuman=false)',
      planSlug: 'agent-plan',
      itemIds: ['P-001'],
    });

    const out = await one({
      id: 'WI-1',
      kind: 'human',
      capability: 'credential',
      ref: 'credential:prod-db',
      summary: 'Provide the production DB credential.',
      nextVerb: 'setup:save_key',
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

  it('keeps an issue in needs-human when a partial clear leaves a strict owner-capability blocker', async () => {
    const decisionBlocker = {
      kind: 'human',
      capability: 'product-decision',
      ref: 'epoch-policy',
      summary: 'Choose the epoch policy.',
      status: 'active',
      createdAt: '2026-09-05T00:00:00.000Z',
      createdBy: 'su-a',
      updatedAt: '2026-09-05T00:00:00.000Z',
    };
    const deviceBlocker = {
      kind: 'human',
      capability: 'physical-device',
      ref: 'peer-vm',
      summary: 'Inspect the peer VM.',
      status: 'active',
      createdAt: '2026-09-05T00:00:00.000Z',
      createdBy: 'su-a',
      updatedAt: '2026-09-05T00:00:00.000Z',
    };
    const item = {
      id: 'WI-1',
      family: 'issue',
      kind: 'bug',
      state: 'needs-human',
      harness: 'papercup',
      payload: { externalBlockers: [decisionBlocker, deviceBlocker] },
    };
    getWorkItem.mockResolvedValue(item);
    mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
      ...item,
      payload: { ...item.payload, ...patch },
    }));
    setWorkItemStateWithAliasInfo.mockResolvedValue({
      workItem: { ...item, state: 'needs-human' },
      aliased: false,
      requestedState: 'needs-human',
      appliedState: 'needs-human',
    });

    const out = await one({
      id: 'WI-1',
      kind: 'human',
      ref: 'epoch-policy',
      clear: true,
      evidence: 'The policy decision is now recorded.',
    });

    expect(out.ok).toBe(true);
    expect(out.activeBlockers).toEqual([
      expect.objectContaining({ status: 'active', capability: 'physical-device', ref: 'peer-vm' }),
    ]);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith(
      'WI-1',
      'needs-human',
      expect.objectContaining({ by: 'su-a' }),
    );
    expect(out.workItem.state).toBe('needs-human');
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
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalledWith('WI-1', 'open', expect.objectContaining({ by: 'su-a' }));
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

  // WI-2141488 — a bare work-item id as a blocker ref is inert: no event key,
  // nothing to await, nothing to clear. 22 papercusp rows waited forever on one.
  describe('bare work-item id as a blocker ref', () => {
    const openItem = {
      id: 'WI-1',
      family: 'issue',
      kind: 'bug',
      state: 'open',
      harness: 'papercup',
      payload: {},
    };

    it('refuses the write and names both repairs', async () => {
      getWorkItem.mockResolvedValue(openItem);

      const out = await one({ id: 'WI-1', kind: 'gate', ref: 'WI-40086' });

      expect(out).toMatchObject({ ok: false, id: 'WI-1', code: 'work_item_ref_as_external_blocker' });
      expect(out.error).toContain("work_items:link { rel:'blocks'");
      expect(out.error).toContain('WI-40086');
      // Nothing may be persisted by a refused write.
      expect(mergeWorkItemPayload).not.toHaveBeenCalled();
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    });

    it('refuses every kind, not just the one the reporter happened to hit', async () => {
      getWorkItem.mockResolvedValue(openItem);
      for (const kind of ['event', 'gate', 'runtime', 'human'] as const) {
        vi.clearAllMocks();
        getWorkItem.mockResolvedValue(openItem);
        const out = await one({
          id: 'WI-1',
          kind,
          ref: 'EI-21330406073681578',
          ...(kind === 'human' ? { summary: 'q', nextVerb: 'v' } : {}),
        });
        expect(out).toMatchObject({ ok: false, code: 'work_item_ref_as_external_blocker' });
        expect(mergeWorkItemPayload).not.toHaveBeenCalled();
      }
    });

    // CALIBRATION — must hold before and after the guard exists. If these ever
    // fail, the guard has become over-broad and is refusing legitimate writes.
    it('still accepts a gate condition that merely QUALIFIES with an item id', async () => {
      getWorkItem.mockResolvedValue(openItem);
      mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
        ...openItem,
        payload: { ...openItem.payload, ...patch },
      }));

      const out = await one({ id: 'WI-1', kind: 'gate', ref: 'gate-red-streak:papercusp / WI-212675' });

      expect(out.ok).toBe(true);
      expect(out.activeBlockers).toEqual([
        expect.objectContaining({ status: 'active', ref: 'gate-red-streak:papercusp / WI-212675' }),
      ]);
    });

    it('still accepts the live work-item:done await key', async () => {
      getWorkItem.mockResolvedValue(openItem);
      mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
        ...openItem,
        payload: { ...openItem.payload, ...patch },
      }));

      const out = await one({ id: 'WI-1', kind: 'event', ref: 'work-item:done:WI-40509' });

      expect(out.ok).toBe(true);
      expect(out.await).toEqual({ event: 'work-item:done:WI-40509' });
    });

    // The load-bearing one: rows already carrying a bad ref must stay clearable,
    // or this guard would strand the exact population it exists to prevent.
    it('still CLEARS an already-written bare work-item blocker', async () => {
      const blocked = {
        ...openItem,
        state: 'blocked',
        payload: {
          externalBlockers: [
            {
              kind: 'gate',
              ref: 'WI-40086',
              summary: 'waiting on WI-40086',
              status: 'active',
              capability: 'live-dependency',
              capabilitySource: 'explicit',
              createdAt: '2026-08-01T00:00:00.000Z',
              createdBy: 'su-old',
              updatedAt: '2026-08-01T00:00:00.000Z',
            },
          ],
        },
      };
      getWorkItem.mockResolvedValue(blocked);
      mergeWorkItemPayload.mockImplementation(async (_id, patch) => ({
        ...blocked,
        payload: { ...blocked.payload, ...patch },
      }));

      const out = await one({ id: 'WI-1', ref: 'WI-40086', clear: true, evidence: 'WI-40086 is done' });

      expect(out.ok).toBe(true);
      expect(out.activeBlockers).toEqual([]);
      expect(mergeWorkItemPayload).toHaveBeenCalled();
    });
  });
});
