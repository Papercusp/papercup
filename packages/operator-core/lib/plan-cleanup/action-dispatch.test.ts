import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sql: { tag: 'sql' },
  reclaimExpiredPlanItemClaims: vi.fn(),
  call: vi.fn(),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../plan-items/stale-claims', () => ({
  reclaimExpiredPlanItemClaims: h.reclaimExpiredPlanItemClaims,
}));

import { dispatchCleanupFindingAction } from './action-dispatch';

const run = {
  runId: 'cleanup-1',
  workspaceId: 'ws-1',
  harnessSlug: 'papercusp',
} as never;

function finding(kind: string, itemId: string | null = 'P-001') {
  return {
    findingId: `${kind}:papercusp/plan-a${itemId ? `#${itemId}` : ''}`,
    kind,
    workspaceId: 'ws-1',
    harnessSlug: 'papercusp',
    planSlug: 'plan-a',
    itemId,
    target: 'target',
    from: 'from',
    to: 'to',
    confidence: kind === 'archive-candidate' || kind === 'stale-now' ? 'recommended' : 'provable',
    autoApply: kind !== 'archive-candidate' && kind !== 'stale-now',
    autoApplyBlockedBy: null,
    evidence: [],
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.call.mockResolvedValue({ ok: true });
  h.reclaimExpiredPlanItemClaims.mockResolvedValue({
    released: [{ workspace_id: 'ws-1', harness_slug: 'papercusp', plan_slug: 'plan-a', item_id: 'P-001' }],
  });
});

describe('dispatchCleanupFindingAction', () => {
  it.each([
    ['flip-to-done', 'plans:set-status', { slug: 'plan-a', item: 'P-001', status: 'done', harness: 'papercusp' }],
    ['cleared-blocker', 'plans:set-status', { slug: 'plan-a', item: 'P-001', status: 'todo', harness: 'papercusp' }],
    ['finish-plan', 'plans:set-plan-status', { slug: 'plan-a', status: 'shipped', harness: 'papercusp' }],
    ['archive-candidate', 'plans:set-archived', { slug: 'plan-a', archived: true, harness: 'papercusp' }],
  ])('routes %s through the canonical %s tool', async (kind, tool, args) => {
    await dispatchCleanupFindingAction({
      run,
      finding: finding(kind, kind === 'finish-plan' || kind === 'archive-candidate' ? null : 'P-001'),
      call: h.call,
    });
    expect(h.call).toHaveBeenCalledWith(tool, args);
  });

  it('targets exactly one orphaned claim through the canonical stale-claim reaper', async () => {
    await dispatchCleanupFindingAction({ run, finding: finding('orphaned-claim'), call: h.call });
    expect(h.reclaimExpiredPlanItemClaims).toHaveBeenCalledWith(h.sql, {
      key: {
        workspaceId: 'ws-1',
        harnessSlug: 'papercusp',
        planSlug: 'plan-a',
        itemId: 'P-001',
      },
    });
    expect(h.call).not.toHaveBeenCalled();
  });

  it('keeps stale-Now recommend-only until an authored proposal exists', async () => {
    await expect(
      dispatchCleanupFindingAction({ run, finding: finding('stale-now', null), call: h.call }),
    ).rejects.toThrow(/requires an authored state\/next proposal/);
    expect(h.call).not.toHaveBeenCalled();
  });
});
