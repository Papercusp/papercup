/**
 * claim.test.ts — the plan_items:claim HANDLER, bulk keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21 P-004). Engine fns + the flag read
 * mocked (flag OFF = the bare-lease path). Pins: inline single → n=1 with the
 * claim payload under results[0].result; itemIds:[…] fan-out; a per-item
 * refused/conflict claim fails ONLY that item (ok:false) while top-level ok stays
 * true and counts.failed is the truth. The flag-ON auto-convert wire is covered by
 * claim-auto-convert.integration.test.ts (it needs the real stores).
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plan-items/claim.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'sess-A', ownerLabel: 'A' }),
  isEphemeralMcpCallIdentity: (id: string) => /^mcp-call-\d+$/.test(id),
}));
vi.mock('../plans/source', () => ({
  resolvePlanScope: vi.fn(async (opts?: { harnessSlug?: string }) => ({
    workspaceId: 'default',
    harnessSlug: opts?.harnessSlug ?? 'papercup',
  })),
}));
vi.mock('../../plan-items/agent-names', () => ({
  bestEffortOwnerUser: () => 'user-A',
  resolveAdoptedName: vi.fn(async () => 'builder-1'),
}));
vi.mock('../../plan-items/liveness', () => ({ claimPlanItem: vi.fn() }));
vi.mock('../../plan-items/convert', () => ({ convertPlanItem: vi.fn() }));
// flag OFF → bare lease; partial-mock so onFlagChange (used by the coord module graph) survives.
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
  getFlag: vi.fn(async () => false),
}));

import { claimPlanItem } from '../../plan-items/liveness';
const claimM = vi.mocked(claimPlanItem);
const tool = (await import('./claim')).default;

type Out = { data: any };
const body = async (args: Record<string, unknown>) =>
  (((await tool.handler(args as never, {} as never)) as Out).data);

beforeEach(() => {
  vi.clearAllMocks();
  claimM.mockImplementation(
    async (opts) =>
      ({ status: 'claimed', claim: { itemId: opts.itemId, owner: 'sess-A' }, mode: 'availability', viaAssignment: false }) as never,
  );
});

describe('plan_items:claim handler (bulk keyed-array, flag OFF)', () => {
  it('claims one inline (n=1) and returns the claim under results[0].result', async () => {
    const b = await body({ plan: 'p1', item: 'P-001' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, plan: 'p1', item: 'P-001' });
    expect(b.results[0].result.status).toBe('claimed');
    expect(claimM).toHaveBeenCalledWith(expect.objectContaining({ planSlug: 'p1', itemId: 'P-001', owner: 'sess-A' }));
  });

  it('claims MANY in the same plan via itemIds:[…]', async () => {
    const b = await body({ plan: 'p1', itemIds: ['P-001', 'P-002'] });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: { item: string }) => r.item)).toEqual(['P-001', 'P-002']);
  });

  it('one claimed + one refused: only the refused item fails, top-level ok stays true', async () => {
    claimM.mockImplementation(async (opts) =>
      opts.itemId === 'P-REF'
        ? ({ status: 'refused', reason: 'assigned to builder-2', assignee: 'builder-2' } as never)
        : ({ status: 'claimed', claim: { itemId: opts.itemId, owner: 'sess-A' }, mode: 'availability', viaAssignment: false } as never),
    );
    const b = await body({ plan: 'p1', itemIds: ['P-001', 'P-REF'] });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: true, item: 'P-001' });
    expect(b.results[1]).toMatchObject({ ok: false, plan: 'p1', item: 'P-REF' });
    expect(b.results[1].result.status).toBe('refused');
  });

  it('a conflict is reported per item (ok:false) without failing the rest', async () => {
    claimM.mockResolvedValue({ status: 'conflict', conflict: { owner: 'sess-B' } } as never);
    const b = await body({ plan: 'p1', item: 'P-001' });
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0]).toMatchObject({ ok: false, item: 'P-001' });
    expect(b.results[0].result.status).toBe('conflict');
  });

  it('items:[…] heterogeneous; per-item harness overrides the batch default', async () => {
    const { resolvePlanScope } = await import('../plans/source');
    await body({ harness: 'papercup', items: [{ plan: 'p1', item: 'P-001' }, { plan: 'p2', item: 'P-009', harness: 'web' }] });
    expect(resolvePlanScope).toHaveBeenNthCalledWith(1, { harnessSlug: 'papercup' });
    expect(resolvePlanScope).toHaveBeenNthCalledWith(2, { harnessSlug: 'web' });
  });
});

// EI-8509: this tool always claims for the CALLER's own identity (no explicit
// assignee param exists here) — refuse the whole batch when the caller is
// scripts/mcp-call.mjs's auto-generated fallback (`mcp-call-<pid>`), a
// one-shot process with no liveness/heartbeat and no fleet cup behind it.
describe('plan_items:claim refuses the mcp-call.mjs auto-generated fallback identity (EI-8509)', () => {
  it('refuses every item in the batch without ever calling claimPlanItem', async () => {
    vi.resetModules();
    vi.doMock('../coordination/identity', () => ({
      resolveAgentIdentity: () => ({ ownerId: 'mcp-call-777', ownerLabel: 'su · mcp-call-777' }),
      isEphemeralMcpCallIdentity: (id: string) => /^mcp-call-\d+$/.test(id),
    }));
    vi.doMock('../plans/source', () => ({
      resolvePlanScope: vi.fn(async (opts?: { harnessSlug?: string }) => ({
        workspaceId: 'default',
        harnessSlug: opts?.harnessSlug ?? 'papercup',
      })),
    }));
    vi.doMock('../../plan-items/agent-names', () => ({
      bestEffortOwnerUser: () => 'user-A',
      resolveAdoptedName: vi.fn(async () => 'builder-1'),
    }));
    const freshClaimM = vi.fn();
    vi.doMock('../../plan-items/liveness', () => ({ claimPlanItem: freshClaimM }));
    vi.doMock('../../plan-items/convert', () => ({ convertPlanItem: vi.fn() }));
    vi.doMock('@papercusp/flags/server', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
      getFlag: vi.fn(async () => false),
    }));

    const freshTool = (await import('./claim')).default;
    const out = (await freshTool.handler(
      { plan: 'p1', itemIds: ['P-001', 'P-002'] } as never,
      {} as never,
    )) as { data: any };
    const b = out.data;

    expect(b).toMatchObject({ ok: true, counts: { ok: 0, failed: 2 } });
    expect(b.results[0]).toMatchObject({ ok: false, plan: 'p1', item: 'P-001' });
    expect(b.results[0].result).toMatchObject({ status: 'refused', reason: 'ephemeral_mcp_call_identity' });
    expect(b.results[0].result.hint).toMatch(/mcp-call\.mjs/);
    expect(freshClaimM).not.toHaveBeenCalled();

    vi.doUnmock('../coordination/identity');
    vi.doUnmock('../plans/source');
    vi.doUnmock('../../plan-items/agent-names');
    vi.doUnmock('../../plan-items/liveness');
    vi.doUnmock('../../plan-items/convert');
    vi.doUnmock('@papercusp/flags/server');
    vi.resetModules();
  });
});
