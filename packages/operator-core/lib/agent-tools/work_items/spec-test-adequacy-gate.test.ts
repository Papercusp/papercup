import { describe, expect, it, vi } from 'vitest';
import { scorecardEvidenceFingerprint, type ScorecardRow } from '../../scorecards';
import type { SpecClauseRevision } from '../plans/spec-clauses-store';
import type { SpecEvidenceForAdequacy } from '../plans/spec-test-adequacy';
import {
  evaluateSpecTestAdequacy,
  SPEC_TEST_ADEQUACY_RUBRIC_REF,
} from '../plans/spec-test-adequacy';
import { specTestAdequacyCompletionGate } from './spec-test-adequacy-gate';

type GateDeps = NonNullable<Parameters<typeof specTestAdequacyCompletionGate>[1]>;
type ListedEvidence = Awaited<ReturnType<NonNullable<GateDeps['listEvidence']>>>[number];

const WORK_ITEM = {
  id: 'WI-101',
  harness: 'papercusp',
  payload: {
    plan_item: {
      plan_slug: 'reconnect-plan',
      item_id: 'P-003',
      harness_slug: 'papercusp',
    },
  },
  sourcePlanSlug: 'reconnect-plan',
  sourcePlanItemIds: ['P-003'],
};

function clause(over: Partial<SpecClauseRevision> = {}): SpecClauseRevision {
  return {
    planSlug: 'reconnect-plan',
    specId: 'SPEC-003-01',
    sourceValId: 'VAL-003-01',
    currentRevision: 1,
    revision: 1,
    planItemId: 'P-003',
    behavior: 'An acknowledged event is not replayed after reconnect.',
    behaviorClass: 'happy-path',
    requiredEvidence: [],
    requiredTestLayers: ['integration'],
    mutationRequired: false,
    lifecycleStatus: 'active',
    supersedes: null,
    exemption: null,
    falsifier: null,
    contentHash: 'sha256:spec-v1',
    createdBy: 'su-test',
    createdAt: '2026-08-20T00:00:00.000Z',
    acceptedBy: 'reviewer',
    acceptedAt: '2026-08-20T00:01:00.000Z',
    acceptanceRef: 'D-003',
    ...over,
  };
}

function evidence(over: Partial<SpecEvidenceForAdequacy> = {}): SpecEvidenceForAdequacy {
  return {
    workItemId: 'WI-101',
    planSlug: 'reconnect-plan',
    specId: 'SPEC-003-01',
    specRevision: 1,
    specFingerprint: 'sha256:spec-v1',
    evidenceKind: 'test',
    evidenceRef: 'test:reconnect',
    fingerprints: {
      sourceFingerprint: 'git:abc',
      testFingerprint: 'sha256:test',
      fixtureFingerprint: null,
      rubricFingerprint: 'sha256:rubric',
      environmentFingerprint: 'node:24',
    },
    coverageEvidenceRef: null,
    testRunId: 43,
    details: {
      adequacy: {
        falsifiable: true,
        testLayer: 'integration',
        pathReachable: true,
        oracleIndependent: true,
        collected: true,
        skipped: false,
        executed: true,
        outcome: 'passed',
        coverageRungs: { l3: true },
      },
    },
    currentness: {
      overall: 'current',
      dimensions: {
        spec: 'current',
        source: 'current',
        test: 'current',
        fixture: 'not-applicable',
        rubric: 'current',
        environment: 'current',
        coverageEvidence: 'not-applicable',
        testRun: 'current',
      },
      staleReasons: [],
      unknownReasons: [],
    },
    ...over,
  };
}

function listedEvidence(over: Partial<ListedEvidence> = {}): ListedEvidence {
  return {
    id: 1,
    sourceValId: 'VAL-003-01',
    currentRevision: 1,
    observedAt: '2026-08-20T00:01:30.000Z',
    bindingFingerprint: 'sha256:binding',
    createdBy: 'su-test',
    createdAt: '2026-08-20T00:01:31.000Z',
    ...evidence(),
    ...over,
  };
}

function matchingCard(over: Partial<ScorecardRow> = {}): ScorecardRow {
  const result = evaluateSpecTestAdequacy({
    clause: clause(),
    evidence: [evidence()],
    classRef: 'plan-class-feature-ship',
  });
  return {
    issueId: 'EI-scorecard',
    createdAt: '2026-08-20T00:02:00.000Z',
    createdBy: 'reviewer',
    subject: result.scorecardDraft.subject,
    rubricRef: SPEC_TEST_ADEQUACY_RUBRIC_REF,
    ratings: result.ratings,
    nKeys: Object.keys(result.ratings).length,
    missingKeys: [],
    extraKeys: [],
    rubricResolved: true,
    evidenceFingerprint: scorecardEvidenceFingerprint({
      rubricRef: SPEC_TEST_ADEQUACY_RUBRIC_REF,
      ratings: result.ratings,
    }),
    synthesized: false,
    score10: 10,
    linkedItems: [],
    ...over,
  };
}

const ATTESTATION = {
  classRef: 'plan-class-feature-ship' as const,
  current: [
    {
      evidenceKind: 'test' as const,
      evidenceRef: 'test:reconnect',
      sourceFingerprint: 'git:abc',
      testFingerprint: 'sha256:test',
      fixtureFingerprint: null,
      rubricFingerprint: 'sha256:rubric',
      environmentFingerprint: 'node:24',
    },
  ],
};

function passingDeps() {
  const listClauses = vi.fn<NonNullable<GateDeps['listClauses']>>(async () => [clause()]);
  const listEdges = vi.fn<NonNullable<GateDeps['listEdges']>>(async () => []);
  const listEvidence = vi.fn<NonNullable<GateDeps['listEvidence']>>(async () => [listedEvidence()]);
  const listCards = vi.fn<NonNullable<GateDeps['listCards']>>(async () => [matchingCard()]);
  return {
    listClauses,
    listEdges,
    listEvidence,
    listCards,
  };
}

describe('specTestAdequacyCompletionGate', () => {
  it('is non-applicable for a legacy work item with no plan provenance', async () => {
    const deps = passingDeps();
    const result = await specTestAdequacyCompletionGate(
      { workItem: { id: 'WI-legacy', harness: 'papercusp', payload: null } },
      deps,
    );

    expect(result).toEqual({ ok: true, applicable: false, checked: [] });
    // P-016/D-012: the VERDICT is unchanged, but the reason it is reached moved. This
    // used to assert `listEdges` was NOT called — the gate returned non-applicable from
    // the missing plan stamp alone, before looking at behavior at all. Applicability is
    // behavior-owned now, so the edges ARE consulted (unscoped); this item is
    // non-applicable because it genuinely has no edges, not because it has no plan.
    expect(deps.listEdges).toHaveBeenCalledWith({ harnessSlug: 'papercusp', workItemId: 'WI-legacy' });
    expect(deps.listClauses).not.toHaveBeenCalled();
  });

  it('falls back to canonical sourcePlan columns when the payload stamp is absent', async () => {
    const deps = passingDeps();
    const result = await specTestAdequacyCompletionGate(
      {
        workItem: {
          id: WORK_ITEM.id,
          harness: WORK_ITEM.harness,
          payload: null,
          sourcePlanSlug: WORK_ITEM.sourcePlanSlug,
          sourcePlanItemIds: WORK_ITEM.sourcePlanItemIds,
        },
        attestation: ATTESTATION,
      },
      deps,
    );

    expect(result).toEqual({ ok: true, applicable: true, checked: ['SPEC-003-01@1'] });
    // P-016/D-013 design call (a): the edge read is UNSCOPED by plan. It used to pass
    // `planSlug: 'reconnect-plan'`, which is precisely what made an edge into another
    // plan's namespace invisible. The stamp is still what SCOPES enforcement below — it
    // is just no longer what scopes discovery.
    expect(deps.listEdges).toHaveBeenCalledWith({
      harnessSlug: 'papercusp',
      workItemId: 'WI-101',
    });
    expect(deps.listClauses).toHaveBeenCalledWith({
      harnessSlug: 'papercusp',
      planSlug: 'reconnect-plan',
      planItemIds: ['P-003'],
    });
  });

  it('requires an attestation before evaluating test-requiring current clauses', async () => {
    const deps = passingDeps();
    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM }, deps);

    expect(result).toMatchObject({ ok: false, applicable: true, retryable: true, checked: [] });
    if (!result.ok) expect(result.reason).toContain('SPEC-003-01@1');
    expect(deps.listEvidence).not.toHaveBeenCalled();
    expect(deps.listCards).not.toHaveBeenCalled();
  });

  it('accepts only the exact current complete terminal scorecard', async () => {
    const result = await specTestAdequacyCompletionGate(
      { workItem: WORK_ITEM, attestation: ATTESTATION },
      passingDeps(),
    );

    expect(result).toEqual({ ok: true, applicable: true, checked: ['SPEC-003-01@1'] });
  });

  it('accepts the exact current cohort without historical unknown bindings vetoing it', async () => {
    const deps = passingDeps();
    deps.listEvidence.mockResolvedValue([
      listedEvidence({
        id: 1,
        evidenceRef: 'test:historical',
        currentness: {
          ...evidence().currentness,
          overall: 'unknown',
          dimensions: {
            ...evidence().currentness.dimensions,
            source: 'unknown',
            test: 'unknown',
          },
          unknownReasons: ['source_fingerprint_absent', 'test_fingerprint_absent'],
        },
      }),
      listedEvidence({ id: 2 }),
    ]);

    const result = await specTestAdequacyCompletionGate(
      { workItem: WORK_ITEM, attestation: ATTESTATION },
      deps,
    );

    expect(result).toEqual({ ok: true, applicable: true, checked: ['SPEC-003-01@1'] });
  });

  it.each([
    ['stale evidence fingerprint', { evidenceFingerprint: 'sha256:stale' }],
    ['provisional scorecard', { provisional: { violatableKeys: ['freshness'], stampedAt: '2026-08-20T00:02:00.000Z' } }],
    [
      'pending grading audit',
      {
        gradingAudit: {
          state: 'pending' as const,
          metaRubricRef: 'grading-integrity',
          stampedAt: '2026-08-20T00:02:00.000Z',
        },
      },
    ],
  ])('refuses a %s without treating it as pass', async (_label, cardPatch) => {
    const deps = passingDeps();
    deps.listCards.mockResolvedValue([matchingCard(cardPatch as Partial<ScorecardRow>)]);

    const result = await specTestAdequacyCompletionGate(
      { workItem: WORK_ITEM, attestation: ATTESTATION },
      deps,
    );

    expect(result).toMatchObject({ ok: false, applicable: true, retryable: true, checked: [] });
    if (!result.ok) expect(result.reason).toContain('no current terminal complete scorecard');
  });

  it('returns evaluator would-block reasons for stale or otherwise inadequate evidence', async () => {
    const deps = passingDeps();
    deps.listEvidence.mockResolvedValue([
      listedEvidence({
        currentness: {
          ...evidence().currentness,
          overall: 'stale',
          staleReasons: ['test_fingerprint_mismatch'],
        },
      }),
    ]);

    const result = await specTestAdequacyCompletionGate(
      { workItem: WORK_ITEM, attestation: ATTESTATION },
      deps,
    );

    expect(result).toMatchObject({ ok: false, applicable: true, retryable: true });
    if (!result.ok) expect(result.reason).toContain('freshness');
  });

  it('treats an active non-automated clause with no required layers as non-applicable', async () => {
    const deps = passingDeps();
    deps.listClauses.mockResolvedValue([
      clause({ behaviorClass: 'non-automated', requiredTestLayers: [], mutationRequired: false }),
    ]);

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM }, deps);

    expect(result).toEqual({ ok: true, applicable: false, checked: [] });
    expect(deps.listEvidence).not.toHaveBeenCalled();
  });
});
