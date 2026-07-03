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
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
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
