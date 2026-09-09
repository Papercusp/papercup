import { describe, expect, it, vi } from 'vitest';
import { scorecardEvidenceFingerprint, type ScorecardRow } from '../../scorecards';
import type { SpecClauseRevision } from '../plans/spec-clauses-store';
import type { SpecEvidenceForAdequacy } from '../plans/spec-test-adequacy';
import { evaluateSpecTestAdequacy, SPEC_TEST_ADEQUACY_RUBRIC_REF } from '../plans/spec-test-adequacy';
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
      // WI-2146375: every dimension here reads 'current', which is only reachable when a
      // comparison input WAS supplied — `unknown` is what you get when nobody asked.
      comparisonSupplied: true,
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

/** The evaluator requires a successful ledger-backed negative control for falsifiability. */
function counterexampleEvidence(over: Partial<ListedEvidence> = {}): ListedEvidence {
  return listedEvidence({
    id: 2,
    evidenceKind: 'counterexample',
    evidenceRef: 'counterexample:reconnect',
    details: {
      adequacy: {
        ...((evidence().details.adequacy ?? {}) as Record<string, unknown>),
        outcome: 'killed',
      },
    },
    ...over,
  });
}

function passingEvidence(): ListedEvidence[] {
  return [listedEvidence(), counterexampleEvidence()];
}

function matchingCard(over: Partial<ScorecardRow> = {}): ScorecardRow {
  const result = evaluateSpecTestAdequacy({
    clause: clause(),
    evidence: passingEvidence(),
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

/**
 * Default plan status for every namespace a test resolves.
 *
 * `active` is chosen so the DEFAULT is enforcing: a test that says nothing about plan
 * status is asserting about the gate's enforcement behavior, and a default that quietly
 * exempted every plan would make those tests pass for the wrong reason — the vacuous-pass
 * class. Tests that care about the non-enforcing lanes override this explicitly.
 */
function planStatuses(byPlan: Record<string, string> = {}) {
  return vi.fn<NonNullable<GateDeps['listPlanStatuses']>>(
    async ({ planSlugs }) => new Map(planSlugs.map((slug) => [slug, byPlan[slug] ?? 'active'])),
  );
}

function passingDeps() {
  const listClauses = vi.fn<NonNullable<GateDeps['listClauses']>>(async () => [clause()]);
  const listEdges = vi.fn<NonNullable<GateDeps['listEdges']>>(async () => []);
  const listEvidence = vi.fn<NonNullable<GateDeps['listEvidence']>>(async (options) => {
    const rows = passingEvidence();
    return options.evidenceRefs ? rows.filter((row) => options.evidenceRefs!.includes(row.evidenceRef)) : rows;
  });
  const listCards = vi.fn<NonNullable<GateDeps['listCards']>>(async () => [matchingCard()]);
  const listPlanStatuses = planStatuses();
  return {
    listClauses,
    listEdges,
    listEvidence,
    listCards,
    listPlanStatuses,
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

  it('refuses terminal completion when the only proof is an ephemeral session-local path', async () => {
    const deps = passingDeps();
    deps.listEvidence.mockResolvedValue([
      listedEvidence({
        evidenceRef: '/tmp/pui-p001-counterexample-guard.log',
        coverageEvidenceRef: null,
        testRunId: null,
      }),
    ]);

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

    expect(result).toMatchObject({ ok: false, applicable: true, retryable: true, checked: [] });
    if (!result.ok) {
      expect(result.reason).toContain('traceability');
    }
    expect(deps.listCards).not.toHaveBeenCalled();
  });

  it('accepts grading-integrity evidence enrichment without coupling prose to the evaluator fingerprint', async () => {
    const deps = passingDeps();
    const card = matchingCard();
    const enrichedRatings = Object.fromEntries(
      Object.entries(card.ratings).map(([key, value]) => [
        key,
        {
          ...value,
          evidence: `${value.evidence} Re-run plans:get-spec-evidence with the exact current binding.`,
        },
      ]),
    );
    deps.listCards.mockResolvedValue([
      {
        ...card,
        ratings: enrichedRatings,
        evidenceFingerprint: scorecardEvidenceFingerprint({
          rubricRef: SPEC_TEST_ADEQUACY_RUBRIC_REF,
          ratings: enrichedRatings,
        }),
        gradingAudit: {
          state: 'passed',
          metaRubricRef: 'grading-integrity',
          stampedAt: '2026-08-20T00:02:00.000Z',
        },
      },
    ]);

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

    expect(result).toEqual({ ok: true, applicable: true, checked: ['SPEC-003-01@1'] });
  });

  it('accepts the exact current cohort without historical unknown bindings vetoing it', async () => {
    const deps = passingDeps();
    const historical = listedEvidence({
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
    });
    const current = listedEvidence({ id: 2 });
    const counterexample = counterexampleEvidence({ id: 3 });
    deps.listEvidence.mockImplementation(async (options) => {
      const rows = [historical, current, counterexample];
      return options.evidenceRefs ? rows.filter((row) => options.evidenceRefs!.includes(row.evidenceRef)) : rows;
    });
    const attestation = {
      ...ATTESTATION,
      evidenceRefs: [current.evidenceRef, counterexample.evidenceRef],
    };
    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation }, deps);

    expect(result).toEqual({ ok: true, applicable: true, checked: ['SPEC-003-01@1'] });
  });

  it.each([
    [
      'divergent evaluator verdict',
      {
        ratings: {
          ...matchingCard().ratings,
          freshness: { rating: 'fail', evidence: 'The current evidence is stale.' },
        },
      },
    ],
    [
      'provisional scorecard',
      { provisional: { violatableKeys: ['freshness'], stampedAt: '2026-08-20T00:02:00.000Z' } },
    ],
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

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

    expect(result).toMatchObject({ ok: false, applicable: true, retryable: true, checked: [] });
    if (!result.ok) expect(result.reason).toContain('no current terminal complete scorecard');
  });

  it('returns only current pending scorecard issue ids for auditor dispatch', async () => {
    const deps = passingDeps();
    deps.listCards.mockResolvedValue([
      matchingCard({
        issueId: 'EI-pending-current',
        gradingAudit: {
          state: 'pending',
          metaRubricRef: 'grading-integrity',
          stampedAt: '2026-08-20T00:02:00.000Z',
        },
      }),
      matchingCard({
        issueId: 'EI-pending-superseded',
        supersededBy: 'EI-replacement',
        gradingAudit: {
          state: 'pending',
          metaRubricRef: 'grading-integrity',
          stampedAt: '2026-08-20T00:02:00.000Z',
        },
      }),
      matchingCard({
        issueId: 'EI-pending-retracted',
        retracted: {} as ScorecardRow['retracted'],
        gradingAudit: {
          state: 'pending',
          metaRubricRef: 'grading-integrity',
          stampedAt: '2026-08-20T00:02:00.000Z',
        },
      }),
    ]);

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

    expect(result).toMatchObject({
      ok: false,
      applicable: true,
      retryable: true,
      pendingGradingAuditTargetIds: ['EI-pending-current'],
    });
  });

  it.each(['passed', 'failed'] as const)(
    'routes a legacy %s audit stamp with missing recorded identity back through pending dispatch',
    async (state) => {
      const deps = passingDeps();
      deps.listCards.mockResolvedValue([
        matchingCard({
          issueId: `EI-legacy-${state}`,
          gradingAudit: {
            state,
            metaRubricRef: 'grading-integrity',
            stampedAt: '2026-08-20T00:02:00.000Z',
            auditIssueId: 'EI-old-audit',
          },
          gradingAuditCurrentness: {
            state: 'unknown',
            reason: 'recorded-identity-missing',
            recordedRevision: null,
            currentRevision: 6,
            recordedCriteriaHash: null,
            currentCriteriaHash: 'hash-current',
          },
        }),
      ]);

      const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

      expect(result).toMatchObject({
        ok: false,
        applicable: true,
        retryable: true,
        pendingGradingAuditTargetIds: [`EI-legacy-${state}`],
      });
      if (!result.ok) expect(result.failedGradingAuditTargetIds).toBeUndefined();
    },
  );

  it('returns only current failed scorecard issue ids for state-specific repair guidance', async () => {
    const deps = passingDeps();
    deps.listCards.mockResolvedValue([
      matchingCard({
        issueId: 'EI-failed-current',
        gradingAudit: {
          state: 'failed',
          metaRubricRef: 'grading-integrity',
          stampedAt: '2026-08-20T00:02:00.000Z',
          auditIssueId: 'EI-audit-failed-current',
        },
      }),
      matchingCard({
        issueId: 'EI-failed-superseded',
        supersededBy: 'EI-replacement',
        gradingAudit: {
          state: 'failed',
          metaRubricRef: 'grading-integrity',
          stampedAt: '2026-08-20T00:02:00.000Z',
        },
      }),
      matchingCard({
        issueId: 'EI-failed-retracted',
        retracted: {} as ScorecardRow['retracted'],
        gradingAudit: {
          state: 'failed',
          metaRubricRef: 'grading-integrity',
          stampedAt: '2026-08-20T00:02:00.000Z',
        },
      }),
    ]);

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

    expect(result).toMatchObject({
      ok: false,
      applicable: true,
      retryable: true,
      failedGradingAuditTargetIds: ['EI-failed-current'],
    });
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
      counterexampleEvidence({
        currentness: {
          ...evidence().currentness,
          overall: 'stale',
          dimensions: {
            ...evidence().currentness.dimensions,
            test: 'stale',
          },
          staleReasons: ['test_fingerprint_mismatch'],
        },
      }),
    ]);

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

    expect(result).toMatchObject({ ok: false, applicable: true, retryable: true });
    if (!result.ok) expect(result.reason).toContain('freshness');
  });

  it('names the omitted fingerprint dimension in a freshness refusal', async () => {
    const deps = passingDeps();
    deps.listEvidence.mockResolvedValue([
      listedEvidence({
        currentness: {
          ...evidence().currentness,
          overall: 'unknown',
          dimensions: {
            ...evidence().currentness.dimensions,
            test: 'unknown',
          },
          unknownReasons: ['test-current-fingerprint-not-supplied'],
        },
      }),
      counterexampleEvidence({
        currentness: {
          ...evidence().currentness,
          overall: 'unknown',
          dimensions: {
            ...evidence().currentness.dimensions,
            test: 'unknown',
          },
          unknownReasons: ['test-current-fingerprint-not-supplied'],
        },
      }),
    ]);

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

    expect(result).toMatchObject({ ok: false, applicable: true, retryable: true });
    if (!result.ok) {
      expect(result.reason).toContain('unknown [freshness]');
      expect(result.reason).toContain('Current fingerprints are missing for: test:reconnect');
      expect(result.reason).toContain('testFingerprint omitted');
    }
  });

  it('distinguishes a mismatched fingerprint dimension in a freshness refusal', async () => {
    const deps = passingDeps();
    deps.listEvidence.mockResolvedValue([
      listedEvidence({
        currentness: {
          ...evidence().currentness,
          overall: 'stale',
          dimensions: {
            ...evidence().currentness.dimensions,
            test: 'stale',
          },
          staleReasons: ['test_fingerprint_mismatch'],
        },
      }),
      counterexampleEvidence({
        currentness: {
          ...evidence().currentness,
          overall: 'stale',
          dimensions: {
            ...evidence().currentness.dimensions,
            test: 'stale',
          },
          staleReasons: ['test_fingerprint_mismatch'],
        },
      }),
    ]);

    const result = await specTestAdequacyCompletionGate({ workItem: WORK_ITEM, attestation: ATTESTATION }, deps);

    expect(result).toMatchObject({ ok: false, applicable: true, retryable: true });
    if (!result.ok) {
      expect(result.reason).toContain('fail [freshness]');
      expect(result.reason).toContain('testFingerprint mismatched');
      expect(result.reason).not.toContain('testFingerprint omitted');
    }
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

  it('treats a task-kind plan deliverable as non-applicable without an executable-proof attestation', async () => {
    const deps = passingDeps();

    const result = await specTestAdequacyCompletionGate({ workItem: { ...WORK_ITEM, kind: 'task' } }, deps);

    expect(result).toEqual({ ok: true, applicable: false, checked: [] });
    expect(deps.listEvidence).not.toHaveBeenCalled();
    expect(deps.listCards).not.toHaveBeenCalled();
  });

  it.each(['src/client.ts', 'src/client.rs', 'scripts/run.sh', 'sql/123-fix.sql', 'src/style.css'])(
    'refuses task-kind executable changes to %s even when the attestation is omitted',
    async (path) => {
      const deps = passingDeps();
      const input = { workItem: { ...WORK_ITEM, kind: 'task' }, changedPaths: [path] };

      const result = await specTestAdequacyCompletionGate(input, deps);

      expect(result).toMatchObject({ ok: false, applicable: true, retryable: true });
      expect(!result.ok && result.reason).toContain('work_items:update');
      expect(deps.listEvidence).not.toHaveBeenCalled();
      expect(deps.listCards).not.toHaveBeenCalled();
    },
  );

  it('does not let task kind suppress an explicitly submitted executable-proof attestation', async () => {
    const deps = passingDeps();
    const result = await specTestAdequacyCompletionGate({
      workItem: { ...WORK_ITEM, kind: 'task' },
      attestation: ATTESTATION,
    }, deps);

    expect(result).toMatchObject({ ok: false, applicable: true, retryable: true });
    expect(!result.ok && result.reason).toContain('work_items:update');
  });

  it('requires both a code kind AND settled audits, never treating re-kind as proof', async () => {
    const deps = passingDeps();
    const pendingCard = matchingCard({
      gradingAudit: {
        state: 'pending',
        metaRubricRef: 'grading-integrity',
        stampedAt: '2026-08-20T00:02:00.000Z',
      },
    });
    deps.listCards.mockResolvedValue([pendingCard]);
    const input = { workItem: { ...WORK_ITEM, kind: 'task' }, attestation: ATTESTATION };

    const wrongKind = await specTestAdequacyCompletionGate(input, deps);
    expect(wrongKind).toMatchObject({ ok: false, applicable: true, retryable: true });
    expect(deps.listCards).not.toHaveBeenCalled();

    const rightKind = await specTestAdequacyCompletionGate({
      ...input, workItem: { ...WORK_ITEM, kind: 'change' },
    }, deps);
    expect(rightKind).toMatchObject({
      ok: false, applicable: true, pendingGradingAuditTargetIds: ['EI-scorecard'],
    });
  });

  it('preserves the exemption for genuine documentation changes without an executable attestation', async () => {
    const deps = passingDeps();
    const input = { workItem: { ...WORK_ITEM, kind: 'task' }, changedPaths: ['docs/design.md', 'report.csv'] };

    expect(await specTestAdequacyCompletionGate(input, deps))
      .toEqual({ ok: true, applicable: false, checked: [] });
    expect(deps.listEvidence).not.toHaveBeenCalled();
    expect(deps.listCards).not.toHaveBeenCalled();
  });
});

/**
 * P-016 / D-012 / D-013 — applicability is BEHAVIOR-owned, and the report is advisory.
 *
 * D-013 splits this surface: P-016 REPORTS what the universal resolver newly resolves,
 * P-013 turns the same reconciled condition into hard enforcement. Both halves need a
 * falsifier, and the second is the one that matters: a test that only proves the new
 * clauses are VISIBLE would pass just as happily if P-016 had also started refusing on
 * them, which would block completions fleet-wide on edges authored as documentation.
 */
describe('specTestAdequacyCompletionGate — universal contract resolution (P-016)', () => {
  const OTHER_PLAN_CLAUSE = clause({
    planSlug: 'other-plan',
    specId: 'SPEC-900-01',
    planItemId: 'P-900',
    contentHash: 'sha256:other-v1',
  });

  /** Routes clause reads by namespace so a cross-namespace resolution is observable. */
  function namespacedDeps(
    edges: Array<{ planSlug: string; specId: string; specRevision: number }>,
    clausesByPlan: Record<string, SpecClauseRevision[]>,
    statusByPlan: Record<string, string> = {},
  ) {
    const deps = passingDeps();
    deps.listPlanStatuses = planStatuses(statusByPlan);
    deps.listEdges.mockImplementation(async () =>
      edges.map((edge) => ({
        workItemId: 'WI-101',
        planSlug: edge.planSlug,
        specId: edge.specId,
        specRevision: edge.specRevision,
        specFingerprint: 'sha256:edge',
      })),
    );
    deps.listClauses.mockImplementation(async (options) => {
      const pool = clausesByPlan[options.planSlug] ?? [];
      if (options.specIds) return pool.filter((c) => options.specIds!.includes(c.specId));
      if (options.planItemIds) return pool.filter((c) => options.planItemIds!.includes(c.planItemId));
      return pool;
    });
    return deps;
  }

  it('resolves a STANDALONE behavior-changing item through its edges — no plan provenance needed', async () => {
    const deps = namespacedDeps([{ planSlug: 'other-plan', specId: 'SPEC-900-01', specRevision: 1 }], {
      'other-plan': [OTHER_PLAN_CLAUSE],
    });

    const result = await specTestAdequacyCompletionGate(
      { workItem: { id: 'WI-101', kind: 'bug', harness: 'papercusp', payload: null } },
      deps,
    );

    // Before P-016 this returned from the missing plan stamp having read nothing at all.
    expect(deps.listEdges).toHaveBeenCalledWith({ harnessSlug: 'papercusp', workItemId: 'WI-101' });

    // P-013: the resolved clause is now ENFORCED, not merely reported. Carrying no plan
    // provenance is exactly what used to buy this item an exemption from its own resolved
    // obligations — the D-012 gap one level down — so the refusal here IS the fix.
    expect(result).toMatchObject({ ok: false, applicable: true, retryable: true });
    if (!result.ok) expect(result.reason).toContain('SPEC-900-01@1');
  });

  it('ENFORCES a cross-namespace clause — P-013 closes the D-013 split', async () => {
    const deps = namespacedDeps([{ planSlug: 'other-plan', specId: 'SPEC-900-01', specRevision: 1 }], {
      'reconnect-plan': [clause()],
      'other-plan': [OTHER_PLAN_CLAUSE],
    });

    const result = await specTestAdequacyCompletionGate(
      { workItem: { ...WORK_ITEM, kind: 'bug' }, attestation: ATTESTATION },
      deps,
    );

    // This assertion is INVERTED from what it read under P-016, deliberately. P-016
    // resolved cross-namespace clauses but enforced only the stamped namespace's, so this
    // case passed with `checked: ['SPEC-003-01@1']` alone. That half-state was always
    // scoped to end here: both namespaces are eligible, so both refuse.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('SPEC-900-01@1');

    // The evidence read must be scoped to the SAME namespaces as the enforced set. If it
    // stayed single-plan, the cross-namespace clause would find zero rows and refuse for a
    // reason the gate manufactured — a refusal that looks identical to a real one.
    const evidenceCall = deps.listEvidence.mock.calls.at(-1)?.[0];
    expect(evidenceCall?.planSlugs).toEqual(expect.arrayContaining(['reconnect-plan', 'other-plan']));
  });

  it('does NOT enforce a namespace whose plan is not yet eligible — the widening still narrows', async () => {
    // The falsifier for the widening above. Enforcement is gated on plan ELIGIBILITY, so
    // a plan that has shipped (historical) or is still a draft (pre-enforcement) stays
    // report-only. Without this case, "enforces cross-namespace clauses" would pass just
    // as happily if eligibility were ignored entirely and every plan refused — which is
    // the fleet-wide refusal this plan's migration semantics exist to prevent.
    const deps = namespacedDeps(
      [{ planSlug: 'other-plan', specId: 'SPEC-900-01', specRevision: 1 }],
      { 'reconnect-plan': [clause()], 'other-plan': [OTHER_PLAN_CLAUSE] },
      { 'other-plan': 'shipped' },
    );

    const result = await specTestAdequacyCompletionGate(
      { workItem: { ...WORK_ITEM, kind: 'bug' }, attestation: ATTESTATION },
      deps,
    );

    // The eligible namespace still enforces and passes; the shipped one does not reach
    // the verdict at all.
    expect(result).toMatchObject({ ok: true, applicable: true, checked: ['SPEC-003-01@1'] });
    if (result.ok) expect(result.checked).not.toContain('SPEC-900-01@1');

    // ...and it is not silently dropped either: the report names it AND says why, so a
    // correct permanent exemption reads differently from an unreconciled migration TODO.
    expect(result.impactReport).toContain('other-plan/SPEC-900-01@1');
    expect(result.impactReport).toContain('already shipped');

    // The evidence read narrows with the enforced set — a shipped plan is never queried.
    const evidenceCall = deps.listEvidence.mock.calls.at(-1)?.[0];
    expect(evidenceCall?.planSlugs).toEqual(['reconnect-plan']);
  });

  it('forwards an exact evidence selection so superseded bindings remain historical without poisoning completion', async () => {
    const deps = passingDeps();
    const evidenceRefs = ['test:reconnect', 'counterexample:reconnect'];
    const result = await specTestAdequacyCompletionGate(
      {
        workItem: { ...WORK_ITEM, kind: 'bug' },
        attestation: { ...ATTESTATION, evidenceRefs },
      },
      deps,
    );

    expect(result).toMatchObject({ ok: true, applicable: true, checked: ['SPEC-003-01@1'] });
    expect(deps.listEvidence).toHaveBeenCalledWith(expect.objectContaining({ evidenceRefs }));
  });

  it('does NOT enforce an active plan that has adopted no clauses — the per-plan migration lane', async () => {
    // "Migrate active plans individually" is the other half of the scope line. An ACTIVE
    // plan reached only by an edge, with no clause of its own adopted, must not refuse —
    // otherwise enabling enforcement blocks every active plan at once instead of arriving
    // per plan as each is reconciled.
    const deps = namespacedDeps([{ planSlug: 'other-plan', specId: 'SPEC-900-01', specRevision: 1 }], {
      'reconnect-plan': [clause()],
      'other-plan': [],
    });

    const result = await specTestAdequacyCompletionGate(
      { workItem: { ...WORK_ITEM, kind: 'bug' }, attestation: ATTESTATION },
      deps,
    );

    expect(result).toMatchObject({ ok: true, applicable: true, checked: ['SPEC-003-01@1'] });
    const evidenceCall = deps.listEvidence.mock.calls.at(-1)?.[0];
    expect(evidenceCall?.planSlugs).toEqual(['reconnect-plan']);
  });

  it('never turns an unresolved standalone item into a refusal (enforcement is P-013)', async () => {
    const deps = namespacedDeps([], {});

    const result = await specTestAdequacyCompletionGate(
      { workItem: { id: 'WI-orphan', kind: 'change', harness: 'papercusp', payload: null } },
      deps,
    );

    // D-012 REQUIRES a behavior-changing item to resolve clauses; D-013 assigns the
    // refusal to P-013. So this reports and passes — asserting both together is what
    // stops enforcement from leaking in unnoticed.
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ applicable: false, checked: [] });
    expect(result.impactReport).toContain('Reported, not enforced');
  });

  it('reports an edge pinned to a superseded revision instead of dropping it', async () => {
    const deps = namespacedDeps([{ planSlug: 'other-plan', specId: 'SPEC-900-01', specRevision: 1 }], {
      'other-plan': [{ ...OTHER_PLAN_CLAUSE, revision: 3, currentRevision: 3 }],
    });

    const result = await specTestAdequacyCompletionGate(
      { workItem: { id: 'WI-101', kind: 'bug', harness: 'papercusp', payload: null } },
      deps,
    );

    // A silently-dropped stale edge is a coverage claim against a since-revised promise.
    expect(result.impactReport).toContain('edge@1 vs current@3');
  });

  it('keeps a draft clause non-enforceable until promotion makes it active', async () => {
    const asDraft = namespacedDeps([{ planSlug: 'other-plan', specId: 'SPEC-900-01', specRevision: 1 }], {
      'other-plan': [{ ...OTHER_PLAN_CLAUSE, lifecycleStatus: 'draft' }],
    });
    const draftResult = await specTestAdequacyCompletionGate(
      { workItem: { id: 'WI-101', kind: 'bug', harness: 'papercusp', payload: null } },
      asDraft,
    );
    // Candidate inputs are non-enforceable until promoted (D-012), so the clause is
    // resolved but contributes no enforceable obligation — no refusal, nothing to name.
    expect(draftResult).toMatchObject({ ok: true, applicable: false, checked: [] });
    expect(draftResult.impactReport ?? '').not.toContain('other-plan/SPEC-900-01@1');

    const asActive = namespacedDeps([{ planSlug: 'other-plan', specId: 'SPEC-900-01', specRevision: 1 }], {
      'other-plan': [OTHER_PLAN_CLAUSE],
    });
    const activeResult = await specTestAdequacyCompletionGate(
      { workItem: { id: 'WI-101', kind: 'bug', harness: 'papercusp', payload: null } },
      asActive,
    );
    // The promotion is the only difference between the two runs — a positive control,
    // without which "draft is invisible" is indistinguishable from "nothing resolves".
    //
    // ⚠ The control MOVED with P-013 and had to be re-pointed rather than deleted. It
    // used to read the promoted clause out of `impactReport`; enforcement is what an
    // eligible active clause now produces, so a clause that reaches the VERDICT is the
    // evidence that it resolved. Left as-is, this assertion would have failed for the
    // right reason and been indistinguishable from a regression.
    expect(activeResult).toMatchObject({ ok: false, applicable: true, retryable: true });
    if (!activeResult.ok) expect(activeResult.reason).toContain('SPEC-900-01@1');
  });
});
