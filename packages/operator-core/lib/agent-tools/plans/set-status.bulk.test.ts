/**
 * set-status.bulk.test.ts — the plans:set-status HANDLER bulk keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). Sibling to set-status.test.ts (which
 * pins the pure helpers). Pins: inline { slug, item, status } → one result; the
 * itemIds:[…] (one plan) + items:[…] (heterogeneous) fan-out keyed by { slug, itemId
 * }; and a partial failure (one item_not_found) that fails ONLY itself — top-level
 * ok:true, counts.failed===1.
 *
 * The lock + revision + identity deps are mocked so this is a pure unit test (no PG).
 * resolveAgentIdentity is mocked to throw → agentId=null, which (by design) skips the
 * claim / auto-convert / terminal-grip discipline so the core flip + envelope is what
 * we exercise here; the discipline itself is covered by set-status.test.ts +
 * integration tests.
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plans/set-status.bulk.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Keep the real `harnessArg` zod schema; only stub `harnessScopedCtx` so the test
// ctx (which carries no harnessSlug) does not trip the harness-required gate.
vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_h: unknown, ctx: unknown) => ctx,
}));
vi.mock('./_ctx-opts', () => ({ resolveCtxHarnessSlug: () => null }));
vi.mock('./revisions', () => ({
  planRevisionCapture: () => ({ afterWrite: undefined, recorded: { current: null } }),
}));
vi.mock('../coordination/plan-events', () => ({ emitPlanEventForCaller: vi.fn(async () => {}) }));
// No attributable agent identity → the claim/terminal discipline is skipped.
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => {
    throw new Error('no identity in this test');
  },
}));
// The lock helper is the single seam: it invokes the mutator and we shape its result.
vi.mock('./with-plan-lock', () => ({
  withPlanLock: vi.fn(),
  bumpUpdatedDate: (s: string) => s,
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
const laneSync = vi.hoisted(() => ({
  item: vi.fn(async () => null),
  dependents: vi.fn(async () => [] as string[]),
  terminal: vi.fn(async () => ({
    planSlug: 'plan-a',
    itemId: 'P-001',
    reconciled: [],
    skippedInFlight: [],
    skippedAlreadyTerminal: [],
    skippedUnprovenLink: [],
    skippedGatedState: [],
  })),
}));
vi.mock('../../plan-items/reconcile-linked-work-items', () => ({
  findAllLinkedWorkItems: vi.fn(async () => []),
  reconcileLinkedWorkItemsForPlanItem: laneSync.terminal,
  resyncPlanItemLaneNow: laneSync.item,
  resyncDependentPlanItemLanesNow: laneSync.dependents,
}));

import { withPlanLock } from './with-plan-lock';
const lockM = vi.mocked(withPlanLock);
const tool = (await import('./set-status')).default;

type Out = { data: any };
const body = async (args: Record<string, unknown>) =>
  (((await tool.handler(args as never, {} as never)) as Out).data);

beforeEach(() => vi.clearAllMocks());

/** Drive the lock: run the mutator against a fake body, then return its ok-value as a
 *  successful lock outcome (or a not_found mutator-value for an unknown item). */
function lockReturnsMutatorValue(
  knownItems: Set<string>,
  options: { importanceByItem?: Record<string, string>; statusByItem?: Record<string, string> } = {},
) {
  lockM.mockImplementation(async (_ctx: unknown, opts: unknown, mutate: unknown) => {
    // `intent` carries the item id we're flipping: "plans:set-status P-NNN → status".
    const intent = (opts as { intent: string }).intent;
    const itemId = /P-\d{3,}/.exec(intent)?.[0] ?? '';
    const status = options.statusByItem?.[itemId] ?? 'todo';
    const importance = options.importanceByItem?.[itemId];
    const fakeBody = knownItems.has(itemId)
      ? `- **${itemId}** \`${status}\` x${importance ? ` importance: ${importance}` : ''}`
      : '';
    const { value } = await (mutate as (b: string | null) => Promise<{ value: unknown }>)(fakeBody);
    return { kind: 'ok', value, filePath: 'plan.md' } as never;
  });
}

describe('plans:set-status handler (bulk keyed-array)', () => {
  it('inline { slug, item, status } returns a single result', async () => {
    lockReturnsMutatorValue(new Set(['P-001']));
    const b = await body({ slug: 'plan-a', item: 'P-001', status: 'wip' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({
      ok: true,
      slug: 'plan-a',
      itemId: 'P-001',
      oldStatus: 'todo',
      newStatus: 'wip',
    });
    expect(laneSync.item).toHaveBeenCalledWith('plan-a', 'P-001', null);
    expect(laneSync.dependents).not.toHaveBeenCalled();
  });

  it('returns each item\'s stored importance for ordinary and terminal same-status flips', async () => {
    lockReturnsMutatorValue(new Set(['P-020', 'P-019']), {
      importanceByItem: { 'P-020': 'high', 'P-019': 'high' },
      statusByItem: { 'P-019': 'done' },
    });
    const b = await body({
      items: [
        { slug: 'plan-a', item: 'P-020', status: 'todo' },
        { slug: 'plan-a', item: 'P-019', status: 'done' },
      ],
    });

    expect(b.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemId: 'P-020', oldStatus: 'todo', newStatus: 'todo', importance: 'high' }),
        expect.objectContaining({ itemId: 'P-019', oldStatus: 'done', newStatus: 'done', importance: 'high' }),
      ]),
    );
  });

  it('itemIds:[…] flips many of one plan to the same status', async () => {
    lockReturnsMutatorValue(new Set(['P-001', 'P-002']));
    const b = await body({ slug: 'plan-a', itemIds: ['P-001', 'P-002'], status: 'done' });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: { itemId: string }) => r.itemId)).toEqual(['P-001', 'P-002']);
    expect(b.results.every((r: { newStatus: string }) => r.newStatus === 'done')).toBe(true);
    expect(laneSync.item).not.toHaveBeenCalled();
    expect(laneSync.terminal).toHaveBeenNthCalledWith(
      1,
      { planSlug: 'plan-a', itemId: 'P-001', harnessSlug: null },
      { knownTerminalStatus: 'done' },
    );
    expect(laneSync.terminal).toHaveBeenNthCalledWith(
      2,
      { planSlug: 'plan-a', itemId: 'P-002', harnessSlug: null },
      { knownTerminalStatus: 'done' },
    );
    expect(laneSync.dependents).toHaveBeenNthCalledWith(1, 'plan-a', 'P-001', null);
    expect(laneSync.dependents).toHaveBeenNthCalledWith(2, 'plan-a', 'P-002', null);
  });

  it('awaits terminal reconciliation for dropped before returning', async () => {
    lockReturnsMutatorValue(new Set(['P-003']));
    const b = await body({
      slug: 'plan-a',
      item: 'P-003',
      status: 'dropped',
      note: 'Synthetic verification run is intentionally abandoned.',
    });

    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(laneSync.terminal).toHaveBeenCalledWith(
      { planSlug: 'plan-a', itemId: 'P-003', harnessSlug: null },
      { knownTerminalStatus: 'dropped' },
    );
    expect(laneSync.item).not.toHaveBeenCalled();
    expect(laneSync.terminal.mock.invocationCallOrder[0]).toBeLessThan(
      laneSync.dependents.mock.invocationCallOrder[0]!,
    );
  });

  it('items:[…] heterogeneous; per-item status overrides the batch default', async () => {
    lockReturnsMutatorValue(new Set(['P-001', 'P-002']));
    const b = await body({
      slug: 'plan-a',
      status: 'done',
      items: [
        { slug: 'plan-a', item: 'P-001' },
        { slug: 'plan-b', item: 'P-002', status: 'blocked' },
      ],
    });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results[0]).toMatchObject({ slug: 'plan-a', itemId: 'P-001', newStatus: 'done' });
    expect(b.results[1]).toMatchObject({ slug: 'plan-b', itemId: 'P-002', newStatus: 'blocked' });
  });

  it('a partial failure (one unknown item) fails ONLY itself — batch survives', async () => {
    lockReturnsMutatorValue(new Set(['P-001'])); // P-099 is unknown → item_not_found
    const b = await body({ slug: 'plan-a', itemIds: ['P-001', 'P-099'], status: 'wip' });
    expect(b.ok).toBe(true); // the batch ran
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results[0]).toMatchObject({ ok: true, itemId: 'P-001' });
    expect(b.results[1]).toMatchObject({ ok: false, slug: 'plan-a', itemId: 'P-099', error: 'item_not_found' });
  });

  it('a busy lock maps to that item\'s { ok:false, error:"busy" } without throwing', async () => {
    lockM.mockResolvedValue({ kind: 'busy', busy: [{ path: 'p', owner_label: 'o', intent: 'i', expires_ts: 1 }] } as never);
    const b = await body({ slug: 'plan-a', item: 'P-001', status: 'wip' });
    expect(b.ok).toBe(true);
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0]).toMatchObject({ ok: false, slug: 'plan-a', itemId: 'P-001', error: 'busy' });
  });

  it('requires a nonblank reason for dropped before any write-side work', async () => {
    lockReturnsMutatorValue(new Set(['P-001']));
    const b = await body({
      slug: 'plan-a',
      item: 'P-001',
      status: 'dropped',
      note: '   ',
      rationale: '\n',
    });
    expect(b).toMatchObject({ ok: true, counts: { ok: 0, failed: 1 } });
    expect(b.results[0]).toMatchObject({
      ok: false,
      slug: 'plan-a',
      itemId: 'P-001',
      error: 'dropped_reason_required',
    });
    expect(b.results[0].hint).toMatch(/note.*rationale/);
    expect(lockM).not.toHaveBeenCalled();
  });

  it.each([
    ['note', { note: 'Superseded by the recorded D-009 decision.' }],
    ['rationale', { rationale: 'Scope deliberately moved to a follow-up plan.' }],
  ])('accepts a dropped reason supplied via %s', async (_label, reason) => {
    lockReturnsMutatorValue(new Set(['P-001']));
    const b = await body({ slug: 'plan-a', item: 'P-001', status: 'dropped', ...reason });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, itemId: 'P-001', newStatus: 'dropped' });
  });

  it('fails only the reasonless drop in a heterogeneous batch', async () => {
    lockReturnsMutatorValue(new Set(['P-001', 'P-002']));
    const b = await body({
      items: [
        { slug: 'plan-a', item: 'P-001', status: 'dropped' },
        { slug: 'plan-a', item: 'P-002', status: 'done' },
      ],
    });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: false, itemId: 'P-001', error: 'dropped_reason_required' });
    expect(b.results[1]).toMatchObject({ ok: true, itemId: 'P-002', newStatus: 'done' });
  });
});

// EI-8509: a →wip flip auto-claims the item under the CALLER's identity. When the
// caller is scripts/mcp-call.mjs's auto-generated fallback (`mcp-call-<pid>` — a
// one-shot process with no liveness/heartbeat and no fleet cup behind it), that
// auto-claim must be refused, the same "placed but nothing executes it" failure
// EI-8509 found. This suite re-mocks resolveAgentIdentity to return that shape
// (the sibling suite above mocks it to throw, which already skips this leg).
describe('plans:set-status →wip auto-claim refuses the mcp-call.mjs fallback identity (EI-8509)', () => {
  it('refuses the wip flip and never reaches the lock/claim path', async () => {
    vi.resetModules();
    vi.doMock('../_harness-scope', async (orig) => ({
      ...(await orig<typeof import('../_harness-scope')>()),
      harnessScopedCtx: (_h: unknown, ctx: unknown) => ctx,
    }));
    vi.doMock('./_ctx-opts', () => ({ resolveCtxHarnessSlug: () => null }));
    vi.doMock('./revisions', () => ({
      planRevisionCapture: () => ({ afterWrite: undefined, recorded: { current: null } }),
    }));
    vi.doMock('../coordination/plan-events', () => ({ emitPlanEventForCaller: vi.fn(async () => {}) }));
    vi.doMock('../coordination/identity', () => ({
      resolveAgentIdentity: () => ({ ownerId: 'mcp-call-42', ownerLabel: 'su · mcp-call-42', source: 'omp-hook-session' }),
      isEphemeralMcpCallIdentity: (id: string) => /^mcp-call-\d+$/.test(id),
    }));
    const lock = vi.fn();
    vi.doMock('./with-plan-lock', () => ({ withPlanLock: lock, bumpUpdatedDate: (s: string) => s }));
    vi.doMock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
    vi.doMock('../plan-items/claim-discipline', () => ({
      claimForWork: vi.fn(async () => ({ ok: true, claimId: 'c1', alreadyHeld: false })),
      releaseOwnClaim: vi.fn(async () => true),
    }));
    vi.doMock('./source', () => ({
      resolvePlanScope: vi.fn(async () => ({ workspaceId: 'default', harnessSlug: 'papercup' })),
    }));

    const freshTool = (await import('./set-status')).default;
    const out = (await freshTool.handler(
      { slug: 'plan-a', item: 'P-001', status: 'wip' } as never,
      {} as never,
    )) as { data: any };
    const b = out.data;

    expect(b).toMatchObject({ ok: true, counts: { ok: 0, failed: 1 } });
    expect(b.results[0]).toMatchObject({
      ok: false,
      slug: 'plan-a',
      itemId: 'P-001',
      error: 'ephemeral_mcp_call_identity',
    });
    expect(b.results[0].hint).toMatch(/mcp-call\.mjs/);
    expect(lock).not.toHaveBeenCalled();

    vi.doUnmock('../_harness-scope');
    vi.doUnmock('./_ctx-opts');
    vi.doUnmock('./revisions');
    vi.doUnmock('../coordination/plan-events');
    vi.doUnmock('../coordination/identity');
    vi.doUnmock('./with-plan-lock');
    vi.doUnmock('../../sync-sse');
    vi.doUnmock('../plan-items/claim-discipline');
    vi.doUnmock('./source');
    vi.resetModules();
  });
});
