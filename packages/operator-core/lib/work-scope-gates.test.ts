/**
 * work-scope-gates.test.ts — the chokepoints honour the workspace work-scope policy
 * (plan workspace-work-scope-policy-2026-09-04, P-012).
 *
 * Contract under test, per chokepoint: policy ABSENT ⇒ the gate is inert (nothing is
 * skipped, refused or held); policy SET ⇒ an out-of-scope harness is held / skipped and
 * an in-scope one is untouched. The policy itself is unit-tested in
 * work-scope-policy.test.ts; this file covers the SEAMS that call it.
 *
 * Run: cd packages/operator-core && npx vitest run lib/work-scope-gates.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store: { policy: Record<string, unknown> } = { policy: {} };
vi.mock('./pot-control-policy', () => ({
  placementOverride: vi.fn(() => store.policy),
  readPotControlPolicy: vi.fn(async () => store.policy),
  writePotControlPolicy: vi.fn(async (patch: Record<string, unknown>) => {
    store.policy = { ...store.policy, ...patch };
    return store.policy;
  }),
}));

const planRows: Array<Record<string, unknown>> = [];
vi.mock('./agent-tools/plans/source', () => ({
  listPlanIndexRowsForWorkspace: vi.fn(async () => planRows),
  planItemsForRow: vi.fn(() => []),
}));
vi.mock('./agent-tools/plans/plan-drain-transition', () => ({
  applyPlanDrainTransition: vi.fn(async () => ({ applied: false, skipped: 'not-drained' })),
}));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

const ENFORCE = {
  mode: 'enforce',
  allowHarnesses: ['papercusp', 'papercusp/*'],
  setBy: 'role:su',
  reason: 'owner 2026-09-04: papercusp only',
};

beforeEach(() => {
  store.policy = {};
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('admission promoter (P-006)', () => {
  it('returns an empty run for an out-of-scope harness WITHOUT touching the database or the model', async () => {
    store.policy = { workScope: ENFORCE };
    const { runWorkItemAdmissionPromoter } = await import('./work-items-admission-promoter');
    const sql = (() => {
      throw new Error('database must not be touched for an out-of-scope harness');
    }) as never;
    const result = await runWorkItemAdmissionPromoter({
      workspaceId: 'ws-test',
      harnessSlug: 'sidestage',
      sql,
      llmCall: async () => {
        throw new Error('model must not be called for an out-of-scope harness');
      },
    });
    expect(result.promoted).toBe(0);
    expect(result.modelCalled).toBe(false);
    expect(result.flaggedPairs).toBe(0);
    expect(result.writerCoverageGap).toEqual([]);
    // the hold is ledgered once (the promoter is a per-harness tick; the ring must not flood)
    const ws = (store.policy as { workScope?: { ledger?: { counts?: Record<string, number> } } }).workScope;
    expect(ws?.ledger?.counts?.held).toBe(1);
  });
});

describe('plan-drain sweep (P-007)', () => {
  it('skips out-of-scope plans only when a policy is set; in-scope plans are scanned either way', async () => {
    planRows.splice(
      0,
      planRows.length,
      { planSlug: 'sidestage-thing', harnessSlug: 'sidestage', status: 'ready' },
      { planSlug: 'papercusp-thing', harnessSlug: 'papercusp', status: 'ready' },
    );
    const { sweepDrainedPlanStatuses } = await import('./agent-tools/plans/plan-drain-sweep');

    const inert = await sweepDrainedPlanStatuses({ workspaceId: 'ws-test' });
    expect(inert.skipped.scope_denied ?? 0).toBe(0);
    expect(inert.scanned).toBeGreaterThanOrEqual(2);

    store.policy = { workScope: ENFORCE };
    const enforced = await sweepDrainedPlanStatuses({ workspaceId: 'ws-test' });
    // one out-of-scope row per source status the sweep reads
    expect(enforced.skipped.scope_denied).toBeGreaterThanOrEqual(1);
    expect(enforced.skipped.scope_denied).toBe(enforced.scanned / 2);
  });
});
