/**
 * P-019 (review-system-rework-reduction-2026-09-23, RSR-P-019-A): any-drags adequacy.
 *
 * The evaluator grades EVERY live binding at a clause revision, so one older weak, stale or
 * failing row fails a criterion beside newer sufficient proof. Measured on R-11: a fresh,
 * fully-flagged targeted mutation proof could not pass the bar until 13 older rows were
 * retracted by hand — and nothing in the verdict said WHICH rows. These tests pin both halves
 * of the fix on the evaluator side: the verdict names the dragging binding ids, and once the
 * dragging row is withdrawn (what plans:bind-spec-evidence supersedeAtRevision does) the
 * sufficient binding carries the clause. The store/tool half lives in
 * spec-evidence-store.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { SpecClauseRevision } from './spec-clauses-store';
import {
  evaluateSpecTestAdequacy,
  LEDGER_PROOF_HINT,
  supersedeEligibilityGaps,
  SUPERSEDE_DRAGGING_SUGGESTION,
  type SpecEvidenceForAdequacy,
} from './spec-test-adequacy';

function clause(over: Partial<SpecClauseRevision> = {}): SpecClauseRevision {
  return {
    planSlug: 'drag-plan',
    specId: 'SPEC-DRAG-01',
    sourceValId: null,
    currentRevision: 1,
    revision: 1,
    planItemId: 'P-019',
    behavior: 'Fresh sufficient proof carries the clause once the dragging row is withdrawn.',
    behaviorClass: 'happy-path',
    requiredEvidence: [],
    requiredTestLayers: [],
    mutationRequired: false,
    lifecycleStatus: 'active',
    supersedes: null,
    exemption: null,
    falsifier: null,
    contentHash: 'sha256:drag-v1',
    createdBy: 'su-test',
    createdAt: '2026-09-23T00:00:00.000Z',
    acceptedBy: 'reviewer',
    acceptedAt: '2026-09-23T00:01:00.000Z',
    acceptanceRef: 'D-019',
    ...over,
  };
}

const CURRENT: SpecEvidenceForAdequacy['currentness'] = {
  comparisonSupplied: true,
  provenance: 'server-measured',
  overall: 'current',
  dimensions: {
    spec: 'current',
    source: 'current',
    test: 'current',
    fixture: 'current',
    rubric: 'current',
    environment: 'current',
    coverageEvidence: 'current',
    testRun: 'current',
  },
  staleReasons: [],
  unknownReasons: [],
};

const STALE: SpecEvidenceForAdequacy['currentness'] = {
  ...CURRENT,
  overall: 'stale',
  dimensions: { ...CURRENT.dimensions, source: 'stale' },
  staleReasons: ['sourceFingerprint mismatched'],
};

function row(
  id: number,
  over: Partial<SpecEvidenceForAdequacy> & { adequacy?: Record<string, unknown> } = {},
): SpecEvidenceForAdequacy {
  const { adequacy, ...rest } = over;
  return {
    id,
    workItemId: 'WI-019',
    planSlug: 'drag-plan',
    specId: 'SPEC-DRAG-01',
    specRevision: 1,
    specFingerprint: 'sha256:drag-v1',
    evidenceKind: 'test',
    evidenceRef: `test-run:${id}`,
    fingerprints: {
      sourceFingerprint: 'git:abc',
      testFingerprint: 'sha256:test',
      fixtureFingerprint: null,
      rubricFingerprint: null,
      environmentFingerprint: null,
    },
    coverageEvidenceRef: null,
    testRunId: 1000 + id,
    details: {
      adequacy: {
        falsifiable: true,
        testLayer: 'unit',
        pathReachable: true,
        oracleIndependent: true,
        collected: true,
        skipped: false,
        executed: true,
        outcome: 'passed',
        targeted: true,
        coverageRungs: { l3: true },
        ...adequacy,
      },
    },
    currentness: CURRENT,
    createdAt: `2026-09-23T00:00:${String(id).padStart(2, '0')}.000Z`,
    ...rest,
  };
}

const counterexample = (id: number) =>
  row(id, { evidenceKind: 'counterexample', evidenceRef: `counterexample:${id}`, adequacy: { outcome: 'pass' } });

describe('any-drags adequacy names the dragging binding (P-019)', () => {
  it('names an older failing attempt as the row dragging execution-integrity, and the clause passes once it is withdrawn', () => {
    const olderFailing = row(1, { adequacy: { outcome: 'failed' } });
    const fresh = row(2);
    const negative = counterexample(3);

    const dragged = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [olderFailing, fresh, negative],
      classRef: 'plan-class-feature-ship',
    });
    expect(dragged.ratings['execution-integrity'].rating).toBe('fail');
    expect(dragged.draggingBindingIds['execution-integrity']).toEqual([1]);
    // The fresh sufficient row is NOT named — only the row that actually drags.
    expect(Object.values(dragged.draggingBindingIds).flat()).not.toContain(2);
    expect(dragged.ratings['execution-integrity'].evidence).toContain('id=1,');
    expect(dragged.ratings['execution-integrity'].suggestion).toContain(SUPERSEDE_DRAGGING_SUGGESTION);

    // Positive control on the same fixture: withdraw the dragging row (what
    // supersedeAtRevision does) and the one sufficient binding carries the clause.
    const repaired = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [fresh, negative],
      classRef: 'plan-class-feature-ship',
    });
    expect(repaired.ratings['execution-integrity'].rating).toBe('pass');
    expect(repaired.wouldBlock).toEqual([]);
    expect(repaired.verdict).toBe('pass');
    expect(repaired.draggingBindingIds).toEqual({});
  });

  it('names every stale row dragging freshness and points at a re-run when nothing current remains', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [row(5, { currentness: STALE }), { ...counterexample(6), currentness: STALE }],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings.freshness.rating).toBe('fail');
    expect(result.draggingBindingIds.freshness).toEqual([5, 6]);
    expect(result.ratings.freshness.suggestion).toMatch(/^Re-run the stale proof/);
  });

  it('offers supersession for a stale row that sits beside a current sufficient one', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [row(7, { currentness: STALE }), row(8), counterexample(9)],
      classRef: 'plan-class-feature-ship',
      // A supplied comparison input keeps every exact binding in the graded population.
      current: [],
    });
    expect(result.ratings.freshness.rating).toBe('fail');
    expect(result.draggingBindingIds.freshness).toEqual([7]);
    expect(result.ratings.freshness.suggestion).toBe(SUPERSEDE_DRAGGING_SUGGESTION);
  });

  it('names no binding for a criterion blocked by absence', () => {
    const result = evaluateSpecTestAdequacy({ clause: clause(), evidence: [], classRef: 'plan-class-feature-ship' });
    expect(result.verdict).toBe('fail');
    expect(result.wouldBlock).toContain('traceability');
    expect(result.draggingBindingIds).toEqual({});
  });

  it('surfaces the ledger requirement, including where mutation-probe rows are listed, on a ledger-gated refusal', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [row(10)],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.wouldBlock).toContain('falsifiability');
    expect(result.ratings.falsifiability.suggestion).toContain(LEDGER_PROOF_HINT);
    expect(LEDGER_PROOF_HINT).toContain("source:'mutation-probe'");
  });
});

describe('supersedeEligibilityGaps: only proof sufficient on its own may supersede (P-019)', () => {
  const adequacy = { collected: true, skipped: false, executed: true, outcome: 'passed' };

  it('accepts a successful ledger-backed executable binding', () => {
    expect(supersedeEligibilityGaps({ evidenceKind: 'test', testRunId: 5, details: { adequacy } })).toEqual([]);
  });

  it.each([
    ['no ledger reference', { evidenceKind: 'test' as const, details: { adequacy } }, 'no testRunId/coverageEvidenceRef ledger reference'],
    ['a failing outcome', { evidenceKind: 'test' as const, testRunId: 5, details: { adequacy: { ...adequacy, outcome: 'failed' } } }, 'outcome="failed"'],
    ['a non-executable kind', { evidenceKind: 'manual' as const, testRunId: 5, details: { adequacy } }, 'evidenceKind=manual is not executable'],
    ['falsifiable=false', { evidenceKind: 'test' as const, testRunId: 5, details: { adequacy: { ...adequacy, falsifiable: false } } }, 'falsifiable=false'],
    ['a disclosed gap', { evidenceKind: 'test' as const, testRunId: 5, details: { adequacy: { ...adequacy, disclosedGap: ['no e2e'] } } }, 'an author-disclosed gap is recorded'],
  ])('refuses %s', (_label, binding, expectedGap) => {
    expect(supersedeEligibilityGaps(binding)).toContain(expectedGap);
  });
});
