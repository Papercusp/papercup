/**
 * delegate.test.ts — resource:delegate (agent-allocation-framework-2026-07-03
 * P-002, D-004): pins the D-004→store MAPPING, which is this layer's whole job
 * (validation itself lives in the store — resource-allotments.test.ts).
 *
 * What a regression here breaks: the agent_slot trio landing outside `axis`
 * (the P-001 pinned contract), quantity not forwarded top-level, the AUTO
 * account default (D-003) dropped, sharePct leaking into slot rows (they cap
 * by COUNT, stored 0), the derived remove-row key ('model:effort:account')
 * drifting from the store's agentSlotRef, refusals being swallowed instead of
 * passed through, or the p2p.allotments invalidate firing on a refusal.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/resource/delegate.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../p2p/resource-allotments', () => ({
  setResourceAllotment: vi.fn(),
  removeResourceAllotment: vi.fn(),
  ALLOTMENT_AUDIENCES: ['trusted-members', 'whole-pot'],
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
// The delegation success path fires a best-effort seat-offer publish. It is NOT this file's
// subject (this file pins the D-004→store mapping) and delegate.ts's own header says unit tests
// must not publish. It was previously inert here only by ACCIDENT: the publish rode a floating
// `void import(...)` that never finished before the test did. Now that detached imports are
// enrolled and drained before teardown (WI-39811), the real implementation runs inside the test
// and logs its expected `no_single_shared_hive` skip — which vitest-fail-on-console rejects.
// Mocking the collaborator (rather than silencing console) keeps that diagnostic meaningful in
// production, where EI-19304844689981989 deliberately made the outcome observable.
vi.mock('../../p2p/offer-store-publish', () => ({
  publishSeatOfferForDelegationBestEffort: vi.fn(),
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({ workspaceId: 'ws-actor' })),
}));
vi.mock('../../harness/usage-actor', () => ({
  resolveUsageActor: vi.fn(async () => ({ githubUserId: 77 })),
}));

import { removeResourceAllotment, setResourceAllotment } from '../../p2p/resource-allotments';
import { notifySyncInvalidate } from '../../sync-sse';

const setM = vi.mocked(setResourceAllotment);
const removeM = vi.mocked(removeResourceAllotment);
const invalidateM = vi.mocked(notifySyncInvalidate);

const mod = await import('./delegate');
const { delegateResource, AUTO_ACCOUNT } = mod;
const tool = mod.default;

const ALLOTMENT = { fleetSlug: 'f', resourceKind: 'agent_slot', resourceRef: 'r' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  setM.mockResolvedValue({ ok: true, allotment: ALLOTMENT });
  removeM.mockResolvedValue({ ok: true, removed: 1 });
});

const setArgs = () => setM.mock.calls[0]![0] as unknown as Record<string, unknown>;

describe('delegateResource — agent_slot mapping (the P-001 pinned contract)', () => {
  it('puts the trio IN axis, quantity top-level, sharePct 0, ref derived model:effort:account', async () => {
    const r = await delegateResource({
      workspaceId: 'ws-1',
      fleetSlug: 'x',
      kind: 'agent_slot',
      model: 'opus',
      effort: 'xhigh',
      count: 5,
    });
    expect(r).toMatchObject({ ok: true, action: 'set' });
    expect(setArgs()).toMatchObject({
      workspaceId: 'ws-1',
      fleetSlug: 'x',
      resourceKind: 'agent_slot',
      resourceRef: `opus:xhigh:${AUTO_ACCOUNT}`,
      quantity: 5,
      sharePct: 0,
      axis: { model: 'opus', effort: 'xhigh', account: AUTO_ACCOUNT },
    });
  });

  it("account omitted → 'AUTO' (D-003, tool-layer default); explicit account passes verbatim", async () => {
    await delegateResource({ workspaceId: 'w', fleetSlug: 'x', kind: 'agent_slot', model: 'm', effort: 'high', count: 1, account: 'pool-b' });
    expect(setArgs().axis).toMatchObject({ account: 'pool-b' });
    expect(setArgs().resourceRef).toBe('m:high:pool-b');
  });

  it('an axis-shaped caller (the loopback) carries the trio inside axis; explicit fields win', async () => {
    await delegateResource({
      workspaceId: 'w',
      fleetSlug: 'x',
      kind: 'agent_slot',
      count: 2,
      model: 'opus', // explicit — must win over axis.model
      axis: { model: 'stale', effort: 'high', account: 'acct-1', dollarCapUsd: 10 },
    });
    // extra axis keys survive under the trio (the P-201 forward seam)
    expect(setArgs().axis).toMatchObject({ model: 'opus', effort: 'high', account: 'acct-1', dollarCapUsd: 10 });
    expect(setArgs().resourceRef).toBe('opus:high:acct-1');
  });

  it('missing count forwards quantity undefined — the store owns quantity_required', async () => {
    await delegateResource({ workspaceId: 'w', fleetSlug: 'x', kind: 'agent_slot', model: 'm', effort: 'low' });
    expect('quantity' in setArgs()).toBe(true);
    expect(setArgs().quantity).toBeUndefined();
  });
});

describe('delegateResource — P-001 potSlug/audience passthrough (pot-seat-pools-prose-ux-2026-07-18)', () => {
  it('forwards potSlug + audience to the store untouched (fleetSlug omitted)', async () => {
    await delegateResource({
      workspaceId: 'w',
      potSlug: 'my-pot',
      audience: 'whole-pot',
      kind: 'account',
      ref: 'pool-main',
      sharePct: 25,
    });
    expect(setArgs()).toMatchObject({
      fleetSlug: undefined,
      potSlug: 'my-pot',
      audience: 'whole-pot',
      resourceKind: 'account',
      resourceRef: 'pool-main',
      sharePct: 25,
    });
  });

  it('an agent_slot pot-scoped delegation also forwards potSlug/audience alongside the trio', async () => {
    await delegateResource({
      workspaceId: 'w',
      potSlug: 'my-pot',
      audience: 'trusted-members',
      kind: 'agent_slot',
      model: 'opus',
      effort: 'high',
      count: 3,
    });
    expect(setArgs()).toMatchObject({
      potSlug: 'my-pot',
      audience: 'trusted-members',
      quantity: 3,
      axis: { model: 'opus', effort: 'high', account: AUTO_ACCOUNT },
    });
  });

  it('a store grantee/audience refusal (grantee_conflict etc.) passes through untouched', async () => {
    setM.mockResolvedValue({ ok: false, refusal: { code: 'grantee_conflict', detail: 'both set' } });
    const r = await delegateResource({
      workspaceId: 'w',
      fleetSlug: 'x',
      potSlug: 'my-pot',
      audience: 'whole-pot',
      kind: 'account',
      ref: 'p',
      sharePct: 10,
    });
    expect(r).toEqual({ ok: false, refusal: { code: 'grantee_conflict', detail: 'both set' } });
  });

  it('the remove path forwards potSlug to removeResourceAllotment', async () => {
    await delegateResource({ workspaceId: 'w', potSlug: 'my-pot', kind: 'account', ref: 'pool-main', remove: true });
    expect(removeM.mock.calls[0]![0]).toMatchObject({ potSlug: 'my-pot', resourceKind: 'account', resourceRef: 'pool-main' });
  });

  // WI-5408: the store owns the xor + audience-required validation
  // (resource-allotments.test.ts pins the refusal LOGIC); this layer's whole job
  // for that class is to thread potSlug/audience through and pass the store's
  // refusal back UNTOUCHED without firing the board invalidate. grantee_conflict
  // is checked just above — audience_required (potSlug set, audience missing) is
  // the other cell of the matrix D-002 makes loud, so pin it here too.
  it('a store audience_required refusal (potSlug without audience) passes through untouched, no invalidate', async () => {
    setM.mockResolvedValue({ ok: false, refusal: { code: 'audience_required', detail: 'potSlug needs an audience' } });
    const r = await delegateResource({
      workspaceId: 'w',
      potSlug: 'my-pot',
      // audience deliberately omitted — the store refuses; this layer must not invent a default
      kind: 'agent_slot',
      model: 'opus',
      effort: 'high',
      count: 2,
    });
    expect(r).toEqual({ ok: false, refusal: { code: 'audience_required', detail: 'potSlug needs an audience' } });
    // the audience/potSlug the store rejected on were still forwarded verbatim
    expect(setArgs()).toMatchObject({ potSlug: 'my-pot', audience: undefined });
    expect(invalidateM).not.toHaveBeenCalled();
  });
});

describe('delegateResource — account/gpu unchanged (P-201 semantics)', () => {
  it('forwards ref + sharePct as-is; no quantity key; axis passthrough', async () => {
    await delegateResource({ workspaceId: 'w', fleetSlug: 'x', kind: 'account', ref: 'pool-main', sharePct: 50, axis: { windows: [] } });
    expect(setArgs()).toMatchObject({ resourceKind: 'account', resourceRef: 'pool-main', sharePct: 50, axis: { windows: [] } });
    expect('quantity' in setArgs()).toBe(false);
  });

  it('missing sharePct forwards NaN — the store owns invalid_share_pct', async () => {
    await delegateResource({ workspaceId: 'w', fleetSlug: 'x', kind: 'gpu', ref: 'gpu-0' });
    expect(Number.isNaN(setArgs().sharePct)).toBe(true);
  });
});

describe('delegateResource — refusal passthrough + invalidate discipline', () => {
  it('a store refusal returns untouched and fires NO invalidate', async () => {
    setM.mockResolvedValue({ ok: false, refusal: { code: 'invalid_resource_kind', detail: 'nope' } });
    const r = await delegateResource({ workspaceId: 'w', fleetSlug: 'x', kind: 'agent_slot', model: 'm', effort: 'low', count: 1 });
    expect(r).toEqual({ ok: false, refusal: { code: 'invalid_resource_kind', detail: 'nope' } });
    expect(invalidateM).not.toHaveBeenCalled();
  });

  it("a successful set fires the name-only 'p2p.allotments' invalidate (no args scope)", async () => {
    await delegateResource({ workspaceId: 'w', fleetSlug: 'x', kind: 'account', ref: 'p', sharePct: 10 });
    expect(invalidateM).toHaveBeenCalledWith('p2p.allotments');
  });

  it('skipInvalidate suppresses it', async () => {
    await delegateResource({ workspaceId: 'w', fleetSlug: 'x', kind: 'account', ref: 'p', sharePct: 10 }, { skipInvalidate: true });
    expect(invalidateM).not.toHaveBeenCalled();
  });
});

describe('delegateResource — ambiguous-hive fail-closed refusal (EI-16667)', () => {
  const many = async () => ({ kind: 'many' as const, candidates: ['hive-a', 'hive-b'] });
  const one = async () => ({ kind: 'one' as const, homeSlug: 'hive-a' });
  const none = async () => ({ kind: 'none' as const });

  it('a fleet-scoped agent_slot set with no hive on a >1-shared-hive workspace refuses loudly, no local write, no invalidate', async () => {
    const r = await delegateResource(
      { workspaceId: 'w', fleetSlug: 'x', kind: 'agent_slot', model: 'm', effort: 'high', count: 1 },
      { resolveScopeOverride: many },
    );
    expect(r).toEqual({
      ok: false,
      refusal: {
        code: 'hive_required',
        detail: expect.stringContaining('hive-a, hive-b'),
      },
    });
    expect(setM).not.toHaveBeenCalled();
    expect(invalidateM).not.toHaveBeenCalled();
  });

  it('passing `hive` bypasses the refusal and proceeds to the local write', async () => {
    const r = await delegateResource(
      { workspaceId: 'w', fleetSlug: 'x', kind: 'agent_slot', model: 'm', effort: 'high', count: 1, hive: 'hive-a' },
      { resolveScopeOverride: many },
    );
    expect(r).toMatchObject({ ok: true, action: 'set' });
    expect(setM).toHaveBeenCalled();
  });

  it('a pot-scoped agent_slot set bypasses the refusal even with no hive (potSlug disambiguates directly)', async () => {
    const r = await delegateResource(
      {
        workspaceId: 'w',
        potSlug: 'my-pot',
        audience: 'whole-pot',
        kind: 'agent_slot',
        model: 'm',
        effort: 'high',
        count: 1,
      },
      { resolveScopeOverride: many },
    );
    expect(r).toMatchObject({ ok: true, action: 'set' });
    expect(setM).toHaveBeenCalled();
  });

  it('a single-shared-hive workspace proceeds without requiring `hive`', async () => {
    const r = await delegateResource(
      { workspaceId: 'w', fleetSlug: 'x', kind: 'agent_slot', model: 'm', effort: 'high', count: 1 },
      { resolveScopeOverride: one },
    );
    expect(r).toMatchObject({ ok: true, action: 'set' });
    expect(setM).toHaveBeenCalled();
  });

  it('a zero-shared-hive workspace stays fail-SOFT (proceeds) — a single-machine box must still delegate', async () => {
    const r = await delegateResource(
      { workspaceId: 'w', fleetSlug: 'x', kind: 'agent_slot', model: 'm', effort: 'high', count: 1 },
      { resolveScopeOverride: none },
    );
    expect(r).toMatchObject({ ok: true, action: 'set' });
    expect(setM).toHaveBeenCalled();
  });

  it('remove:true bypasses the refusal entirely (revoking must never require disambiguation)', async () => {
    const r = await delegateResource(
      { workspaceId: 'w', fleetSlug: 'x', kind: 'agent_slot', model: 'm', effort: 'high', remove: true },
      { resolveScopeOverride: many },
    );
    expect(r).toEqual({ ok: true, action: 'remove', removed: 1 });
  });

  it('account/gpu kinds are never subject to the hive-ambiguity check', async () => {
    const r = await delegateResource(
      { workspaceId: 'w', fleetSlug: 'x', kind: 'account', ref: 'pool-main', sharePct: 10 },
      { resolveScopeOverride: many },
    );
    expect(r).toMatchObject({ ok: true, action: 'set' });
    expect(setM).toHaveBeenCalled();
  });
});

describe('delegateResource — remove (the /res chip ×)', () => {
  it('agent_slot remove keys on the derived slot ref; explicit ref wins', async () => {
    const r = await delegateResource({ workspaceId: 'w', fleetSlug: 'x', kind: 'agent_slot', model: 'opus', effort: 'xhigh', remove: true });
    expect(r).toEqual({ ok: true, action: 'remove', removed: 1 });
    expect(removeM.mock.calls[0]![0]).toMatchObject({ resourceKind: 'agent_slot', resourceRef: `opus:xhigh:${AUTO_ACCOUNT}` });

    await delegateResource({ workspaceId: 'w', fleetSlug: 'x', kind: 'agent_slot', ref: 'opus:xhigh:pool-b', remove: true });
    expect(removeM.mock.calls[1]![0]).toMatchObject({ resourceRef: 'opus:xhigh:pool-b' });
    expect(setM).not.toHaveBeenCalled();
  });
});

describe('resource:delegate handler (identity + response shaping)', () => {
  // The handler returns the data-shape ({ data }) per the tool-data-shape
  // ratchet (see delegate.ts) — the wire envelope is the framework's job.
  type Out = { data: Record<string, unknown> };
  const call = (args: Record<string, unknown>) => tool.handler(args as never, {} as never) as Promise<Out>;
  const body = (o: Out) => o.data;

  it('resolves the actor workspace + github id and returns the allotment', async () => {
    const b = body(await call({ fleetSlug: 'x', kind: 'agent_slot', model: 'opus', effort: 'xhigh', count: 5 }));
    expect(b).toMatchObject({ ok: true, action: 'set' });
    expect(setArgs()).toMatchObject({ workspaceId: 'ws-actor', createdByGithubUserId: 77 });
  });

  it('maps a refusal to { ok:false, error: code, detail }', async () => {
    setM.mockResolvedValue({ ok: false, refusal: { code: 'quantity_required', detail: 'q' } });
    const b = body(await call({ fleetSlug: 'x', kind: 'agent_slot', model: 'm', effort: 'low' }));
    expect(b).toEqual({ ok: false, error: 'quantity_required', detail: 'q' });
  });
});
