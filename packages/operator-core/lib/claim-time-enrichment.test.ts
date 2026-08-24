import { describe, expect, it, vi } from 'vitest';

const behaviorContractResolver = vi.fn(async () => ({ groups: [], enforceable: [] }));

vi.mock('./plan-decisions-claim-port', () => ({
  getClaimTimePlanDecisions: vi.fn(async () => null),
  renderPlanDecisionsNote: vi.fn(),
}));
vi.mock('./prior-attempt-context', () => ({
  getClaimTimePriorAttemptBrief: vi.fn(async () => null),
}));
vi.mock('./premises-claim-port', () => ({
  getClaimTimePremises: vi.fn(async () => null),
}));
vi.mock('./agent-tools/work_items/retraction-advisory', () => ({
  getClaimTimeRetractionAdvisory: vi.fn(async () => null),
}));
vi.mock('./work-item-prior-work', () => ({
  getClaimTimeAuthorshipRevalidationHint: vi.fn(async () => null),
  authorshipRevalidationWarning: vi.fn(() => null),
}));
vi.mock('./work-item-plan-contradiction', () => ({
  getClaimTimePlanItemContradiction: vi.fn(async () => null),
  planItemContradictionWarning: vi.fn(() => null),
}));
vi.mock('./agent-tools/plans/behavior-contract-resolver', () => ({
  resolveWorkItemBehaviorContract: behaviorContractResolver,
}));

import { buildClaimTimeEnrichment } from './claim-time-enrichment';

describe('buildClaimTimeEnrichment behavior-contract leg', () => {
  it('does not call the resolver when a partial subject has no work-item id', async () => {
    await expect(
      buildClaimTimeEnrichment({
        workItem: { harness: 'papercusp', payload: null },
      }),
    ).resolves.toEqual({});

    expect(behaviorContractResolver).not.toHaveBeenCalled();
  });
});
