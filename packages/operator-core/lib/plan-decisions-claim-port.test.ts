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

/**
 * 12 decisions — deliberately OVER the 8 cap, which no fixture here used to be
 * (EI-19396519606401168). The cap was therefore never exercised, and the bug it
 * hid was that `slice(0, 8)` kept the OLDEST eight while the note reported the
 * post-slice length as the total. D-012 below stands in for the real-world case
 * that caught it: a late ruling that DEFERS an item, which a claimer that only
 * sees D-001..D-008 will go ahead and build.
 */
const PLAN_WITH_MANY_DECISIONS = `## Now

State: ready.

## Decisions
${Array.from({ length: 11 }, (_, i) => {
  const n = String(i + 1).padStart(3, '0');
  return `### D-${n} — Early ruling ${i + 1}\nDate: 2026-07-26\nBody of early ruling ${i + 1}.\n`;
}).join('\n')}
### D-012 — Do not start P-004; it is deferred
Date: 2026-08-02
P-004 has no evidence behind it. Do not start that phase.
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
    // Under the cap, the window IS the whole set — so the count a caller renders
    // is honest without any "showing N of M" hedging.
    expect(r?.totalDecisions).toBe(2);
  });

  // EI-19396519606401168 — the cap kept the OLDEST decisions, so a late ruling
  // that defers the very item being claimed never reached the claimer.
  it('over the cap: keeps the MOST RECENT window, not the oldest', async () => {
    mockGetPlanRow.mockResolvedValueOnce({ content: PLAN_WITH_MANY_DECISIONS });
    const r = await getClaimTimePlanDecisions({ workItem: workItemWithPlan('busy-plan') });
    expect(r?.decisions).toHaveLength(8);
    // The newest 8 of 12 — D-001..D-004 fall out of the window, D-012 survives.
    expect(r?.decisions.map((d) => d.id)).toEqual([
      'D-005', 'D-006', 'D-007', 'D-008', 'D-009', 'D-010', 'D-011', 'D-012',
    ]);
  });

  it('over the cap: a late DEFERRAL ruling reaches the claimer (the regression that motivated this)', async () => {
    mockGetPlanRow.mockResolvedValueOnce({ content: PLAN_WITH_MANY_DECISIONS });
    const r = await getClaimTimePlanDecisions({ workItem: workItemWithPlan('busy-plan') });
    const deferral = r?.decisions.find((d) => d.id === 'D-012');
    expect(deferral).toBeDefined();
    expect(deferral?.title).toMatch(/deferred/i);
    // Under the old slice(0, 8) this was the observed failure: the last id
    // surfaced was D-008 and the deferral was invisible.
    expect(r?.decisions.at(-1)?.id).not.toBe('D-008');
  });

  it('over the cap: reports the TRUE total so the window cannot read as the whole set', async () => {
    mockGetPlanRow.mockResolvedValueOnce({ content: PLAN_WITH_MANY_DECISIONS });
    const r = await getClaimTimePlanDecisions({ workItem: workItemWithPlan('busy-plan') });
    expect(r?.totalDecisions).toBe(12);
    // The whole point: total and window length must be independently readable,
    // so a caller can say "8 of 12" instead of announcing 8 as the total.
    expect(r?.totalDecisions).toBeGreaterThan(r!.decisions.length);
  });

  it('fails soft to null on a lookup error — never throws, never blocks the claim it decorates', async () => {
    mockGetPlanRow.mockRejectedValueOnce(new Error('pg hiccup'));
    const r = await getClaimTimePlanDecisions({ workItem: workItemWithPlan('flaky-plan') });
    expect(r).toBeNull();
  });
});
