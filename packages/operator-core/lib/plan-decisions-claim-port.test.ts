import { describe, it, expect, vi } from 'vitest';

const mockGetPlanRow = vi.fn();
vi.mock('./agent-tools/plans/source', () => ({
  getPlanRow: (...args: unknown[]) => mockGetPlanRow(...args),
}));

import { getClaimTimePlanDecisions } from './plan-decisions-claim-port';

const PLAN_WITH_DECISIONS = `## Now

State: ready.

## Decisions

### D-001 — A retirement is done when every reference is re-pointed
Date: 2026-07-26
Code removal alone is not enough — dispatch contracts crossing an HTTP
boundary are the invisible fourth reference class.

### D-002 — A ruling other lanes must follow is recorded as a plan Decision at the moment it forms
Date: 2026-07-26
Never only as a coord message — decisions are the auditable substrate;
messages are the notification.
`;

const PLAN_WITHOUT_DECISIONS = `## Now

State: ready.
`;

function workItemWithPlan(planSlug: string | null) {
  return {
    payload: planSlug ? { plan_item: { plan_slug: planSlug, item_id: 'P-003' } } : {},
  };
}

describe('getClaimTimePlanDecisions (agent-trap-guards-2026-07-26 P-003b)', () => {
  it('returns null when the work-item carries no plan_item back-pointer', async () => {
    const r = await getClaimTimePlanDecisions({ workItem: workItemWithPlan(null) });
    expect(r).toBeNull();
    expect(mockGetPlanRow).not.toHaveBeenCalled();
  });

  it('returns null when the plan does not resolve', async () => {
    mockGetPlanRow.mockResolvedValueOnce(null);
    const r = await getClaimTimePlanDecisions({ workItem: workItemWithPlan('ghost-plan') });
    expect(r).toBeNull();
  });

  it('returns null when the plan has zero decisions (the common case) — stays silent', async () => {
    mockGetPlanRow.mockResolvedValueOnce({ content: PLAN_WITHOUT_DECISIONS });
    const r = await getClaimTimePlanDecisions({ workItem: workItemWithPlan('quiet-plan') });
    expect(r).toBeNull();
  });

  it('surfaces every structured decision, bounded + slug-tagged, when the plan has decisions', async () => {
    mockGetPlanRow.mockResolvedValueOnce({ content: PLAN_WITH_DECISIONS });
    const r = await getClaimTimePlanDecisions({ workItem: workItemWithPlan('agent-trap-guards-2026-07-26') });
    expect(r).not.toBeNull();
    expect(r?.planSlug).toBe('agent-trap-guards-2026-07-26');
    expect(r?.decisions.map((d) => d.id)).toEqual(['D-001', 'D-002']);
    expect(r?.decisions[1]?.title).toMatch(/ruling other lanes must follow/);
    // The snippet is a bounded, single-line excerpt of the body — never the raw
    // multi-line markdown.
    expect(r?.decisions[1]?.snippet).not.toMatch(/\n/);
  });

  it('fails soft to null on a lookup error — never throws, never blocks the claim it decorates', async () => {
    mockGetPlanRow.mockRejectedValueOnce(new Error('pg hiccup'));
    const r = await getClaimTimePlanDecisions({ workItem: workItemWithPlan('flaky-plan') });
    expect(r).toBeNull();
  });
});
