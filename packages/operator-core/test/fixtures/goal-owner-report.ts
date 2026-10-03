import type { GoalOwnerReportSnapshotV1 } from '@papercusp/chat-protocol';

/** Approved experiment: long report, three exact actions, receipts and unknowns. */
export function goalOwnerReportFixture(workspaceId: string): GoalOwnerReportSnapshotV1 {
  const observedAt = '2026-10-03T10:00:00.000Z';
  return {
    schemaVersion: 1, workspaceId, goalId: 'goal-expandable-reports', observedAt,
    sources: [
      { ref: 'goal:goal-expandable-reports', revision: 'goal-generation-7', observedAt, measuredAt: observedAt, availability: 'value' },
      { ref: 'legacy-spend', revision: 'unavailable-1', observedAt, measuredAt: null, availability: 'unknown', unknownReason: 'Legacy receipts have not been priced.' },
    ],
    moved: [
      { ref: 'WI-completed', state: 'done', stateObservedAt: observedAt,
        successfulMutations: [{ receiptRef: 'receipt:complete-19', operation: 'work_items:complete', persistedAt: '2026-10-03T09:59:00.000Z' }],
        completionEvidenceRefs: ['test-run:19', 'artifact:verified-19'], verification: 'verified' },
      { ref: 'WI-observed', state: 'wip', stateObservedAt: observedAt, successfulMutations: [], completionEvidenceRefs: [], verification: 'unverified' },
    ],
    cost: { spentCents: 125.5, budgetCents: 1000, budgetWindowSec: 3600, sourceRef: 'goal-lineage:spend', sourceRevision: 'spend-generation-4', measuredAt: '2026-10-03T09:59:30.000Z', readAt: observedAt, coverage: 'partial; legacy unpriced', unknownReason: 'Historical unpriced receipts excluded.' },
    ownerWalls: [
      { itemRef: 'WI-wall-1', exactAction: 'Approve €50 for the isolated migration rehearsal.', decisionRefs: ['D-001'], artifactRefs: ['artifact:rehearsal'], sourceRevision: 'wall-1-v2' },
      { itemRef: 'WI-wall-2', exactAction: 'Choose retention of 7 days or 30 days for audit evidence.', decisionRefs: ['D-002'], artifactRefs: ['artifact:retention'], sourceRevision: 'wall-2-v1' },
      { itemRef: 'WI-wall-3', exactAction: 'Provide the service account with read access to project reports.', decisionRefs: ['D-003'], artifactRefs: ['artifact:access'], sourceRevision: 'wall-3-v3' },
    ],
    coverage: { checkedRefs: ['WI-completed', 'WI-observed'], uncheckedRefs: ['WI-unread'], notApplicableRefs: ['WI-archived'], unknowns: [{ ref: 'legacy-spend', reason: 'Historical cost coverage is incomplete.' }], residueRefs: ['WI-unread'] },
    killed: [{ ref: 'plan:old-direction', disposition: 'stopped: duplicate surface', evidenceRefs: ['decision:stop-3'], at: '2026-10-02T08:00:00.000Z' }],
    nextWake: { kind: 'loop', ref: 'loop:goal-holder', expectedAt: '2026-10-03T10:01:00.000Z', evidenceRef: 'loop-status:receipt-7' },
  };
}
