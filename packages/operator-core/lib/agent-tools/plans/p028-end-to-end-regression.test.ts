/**
 * P-028 — the final-item → BAR repair → independent grade → author verdict
 * → shipped hand-off.
 *
 * The individual stores have their own integration suites.  This regression is
 * intentionally a small, deterministic journey over their shared contracts: it
 * proves that each refusal hands the caller to the next real verb, that an
 * author rejection/lineage failure remains a retryable verdict step, and that
 * the final hand-off is the guarded plans:set-plan-status shipment (including
 * the idempotent already-shipped replay).
 */
import { describe, expect, it } from 'vitest';
import { evaluateAcceptanceBarLifecycle } from '../../acceptance-bar-lifecycle-evaluator';
import type { AcceptanceBarContractSnapshot } from '../../acceptance-bar-contract-snapshot';
import { planAcceptanceRepairAction } from '../../plan-acceptance-gate';
import { pickAuthoritativeGrading } from '../../acceptance-grading-authority';
import { shouldEvaluateAcceptanceGate } from './set-plan-status';

const HASH = 'a'.repeat(64);

function snapshot(over: {
  method?: string;
  check?: Record<string, unknown> | null;
  proof?: Partial<AcceptanceBarContractSnapshot['bars'][number]['proof']>;
  vetting?: Partial<AcceptanceBarContractSnapshot['grading']['vetting']>;
  authorVerdict?: Partial<AcceptanceBarContractSnapshot['grading']['authorVerdict']>;
  grading?: Partial<AcceptanceBarContractSnapshot['bars'][number]['grading']>;
} = {}): AcceptanceBarContractSnapshot {
  const bar = {
    barKey: 'R-1',
    barHash: HASH,
    model: 'The final item is delivered.',
    falsifier: 'The final item is absent.',
    role: 'outcome' as const,
    mandatory: true,
    requiredScope: ['tree'],
    requiredTestLayers: ['integration'],
    evidencePlane: 'tree' as const,
    passRatings: ['healthy'],
    coversBarKeys: [],
    provenance: { lifecycle: 'pre-implementation' as const },
    method: over.method ?? 'Read the final-item result.',
    check: over.check === undefined ? { kind: 'instrument', instrumentKey: 'none' } : over.check,
    readiness: { codes: [] },
    proof: {
      state: 'current' as const,
      currentEvidence: 1,
      staleEvidence: 0,
      uncertainEvidence: 0,
      evidencePlanes: ['tree'],
      kinds: ['test'],
      evidenceRefs: ['test:p028'],
      adequacy: { state: 'pass' as const, checks: [{ specId: 'AUTO-BAR-R-1-P-001', revision: 1, verdict: 'pass', wouldBlock: [], evidenceRefs: ['test:p028'] }] },
      ...over.proof,
    },
    grading: {
      state: 'pass' as const,
      scorecardId: 'SC-GRADE',
      rubricRevision: 1,
      gradedBy: 'su-independent-grader',
      selectedVia: 'floor' as const,
      rating: 'healthy',
      evidence: 'independent result',
      ...over.grading,
    },
  };

  return {
    schemaVersion: 1,
    planSlug: 'p028-final-item-journey',
    applicable: true,
    plan: {
      status: 'ready',
      adoptionEpoch: 1,
      cohort: 'post-epoch',
      barSetHash: HASH,
      rubricSlug: 'acceptance-p028-final-item-journey',
      rubricRevision: 1,
    },
    rubric: {
      rubricId: 'acceptance-p028-final-item-journey',
      revision: 1,
      criteriaHash: HASH,
      barSetHash: HASH,
      ratingScale: ['healthy', 'broken', 'unknown'],
      classRef: 'plan-class-feature-ship',
    },
    completeness: { complete: true, truncated: false, problems: [] },
    readiness: { state: 'ready', codes: [], nextRepair: null },
    grading: {
      authoritativeScorecardId: 'SC-GRADE',
      gradedBy: 'su-independent-grader',
      selectedVia: 'floor',
      rubricRevision: 1,
      criteriaHash: HASH,
      vetting: { state: 'current', scorecardId: 'SC-VET', rubricRevision: 1, ...over.vetting },
      authorVerdict: {
        state: 'accepted',
        scorecardId: 'SC-AUTHOR',
        verdict: 'accept',
        ...over.authorVerdict,
      },
    },
    bars: [bar],
    sourceRevisions: { subjectPlan: 1, rubricPlan: 1, clauses: [], workContracts: [], scorecardIds: [] },
  } as unknown as AcceptanceBarContractSnapshot;
}

describe('P-028 final-item completion to shipped journey', () => {
  it('keeps every repair/refusal on the next real verb and ships only after the author verdict', () => {
    // Final-item completion is the first gate: a non-terminal item is not a
    // grading problem, so the repair points back to the item-status verb.
    expect(
      planAcceptanceRepairAction('p028-final-item-journey', {
        satisfied: false,
        code: 'plan_items_unfinished',
      }),
    ).toMatchObject({
      kind: 'diagnostic',
      nextVerb: { name: 'plans:get' },
    });

    // BAR/rubric repair is author-owned and must not recruit a grader.  The
    // real lifecycle evaluator supplies the measured method/check refusal.
    const unamended = snapshot({ method: '', check: null });
    const barRefusal = evaluateAcceptanceBarLifecycle(unamended, 'ship');
    expect(barRefusal.satisfied).toBe(false);
    expect(barRefusal.codes).toEqual(
      expect.arrayContaining(['bar_snapshot_method_missing', 'bar_snapshot_check_missing']),
    );
    expect(
      planAcceptanceRepairAction('p028-final-item-journey', {
        satisfied: false,
        code: 'acceptance_bar_contract_not_ready',
        acceptanceBarLifecycle: barRefusal,
      }, { harnessSlug: 'papercusp' }),
    ).toMatchObject({
      kind: 'contract-repair',
      repairVerb: 'rubrics:amend',
      nextVerb: { name: 'plans:get', args: { mode: 'meta', shipReadiness: true } },
    });

    // Once BAR meaning is repaired, the independent grading step is still
    // required.  A missing card routes to the idempotent acceptance recruiter.
    const repaired = snapshot();
    const readyForGrading = evaluateAcceptanceBarLifecycle(repaired, 'pre-grading');
    expect(readyForGrading.satisfied).toBe(true);
    expect(
      planAcceptanceRepairAction('p028-final-item-journey', {
        satisfied: false,
        code: 'acceptance_ungraded',
      }),
    ).toMatchObject({
      kind: 'independent-grading',
      nextVerb: { name: 'plans:set-plan-status', args: { status: 'shipped' } },
    });

    // A grading from the implementer's lineage (or a wrong-subject card) is
    // not a ship verdict.  Both refusal codes stay on the author-verdict rail;
    // they never bypass the independent card requirement.
    expect(
      planAcceptanceRepairAction('p028-final-item-journey', {
        satisfied: false,
        code: 'acceptance_rejected',
      }),
    ).toMatchObject({ kind: 'author-verdict', repairVerb: 'scorecards:emit' });
    expect(
      planAcceptanceRepairAction('p028-final-item-journey', {
        satisfied: false,
        code: 'acceptance_not_recorded',
        gradingRef: 'EI-p028-independent-grade',
      }),
    ).toMatchObject({
      kind: 'author-verdict',
      nextVerb: { name: 'scorecards:get', args: { issueId: 'EI-p028-independent-grade' } },
    });

    const authorRejected = snapshot({
      authorVerdict: { state: 'rejected', scorecardId: 'SC-AUTHOR', verdict: 'reject' },
    });
    const rejected = evaluateAcceptanceBarLifecycle(authorRejected, 'ship');
    expect(rejected.codes).toContain('bar_snapshot_author_rejected');

    // The independent authority selector is the lineage-safe ordering kernel:
    // a floor-qualified grader outranks a minimum-fill grader even when the
    // latter is newer.  This is the exact card the author must reference.
    const authoritative = pickAuthoritativeGrading(
      [
        { createdBy: 'su-minimum', createdAt: '2026-09-20T02:00:00.000Z' },
        { createdBy: 'su-floor', createdAt: '2026-09-20T01:00:00.000Z' },
      ],
      (card) => (card.createdBy === 'su-minimum' ? 'minimum' : 'floor'),
    );
    expect(authoritative?.createdBy).toBe('su-floor');

    // Only the accepted author verdict opens the final shipment hand-off.  The
    // expectedCurrent guard is carried so a concurrent retry cannot overwrite a
    // newer lifecycle state.
    const final = evaluateAcceptanceBarLifecycle(repaired, 'ship');
    expect(final.satisfied, JSON.stringify({ codes: final.codes, blockingBars: final.blockingBars })).toBe(true);
    expect(planAcceptanceRepairAction('p028-final-item-journey', { satisfied: true }, {}, 'awaiting-acceptance')).toMatchObject({
      kind: 'shipment',
      nextVerb: {
        name: 'plans:set-plan-status',
        args: { status: 'shipped', expectedCurrent: 'awaiting-acceptance' },
      },
    });

    // The retry after a committed ship is explicitly idempotent: it skips the
    // pre-ship gate rather than reopening BAR/grading work.
    expect(shouldEvaluateAcceptanceGate('shipped', 'shipped')).toBe(false);
    expect(planAcceptanceRepairAction('p028-final-item-journey', { satisfied: true, skipped: 'already-shipped' })).toEqual({
      kind: 'terminal',
      nextVerb: null,
      instruction: 'Already shipped; do not reopen acceptance.',
    });
  });
});
