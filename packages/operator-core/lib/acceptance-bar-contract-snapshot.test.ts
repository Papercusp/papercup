import { describe, expect, it, vi } from 'vitest';
import {
  ACCEPTANCE_BAR_CONTRACT_SNAPSHOT_VERSION,
  ACCEPTANCE_BAR_SNAPSHOT_ACTIVE_RUBRIC_LIMIT,
  ACCEPTANCE_BAR_SNAPSHOT_EVIDENCE_LIMIT,
  ACCEPTANCE_BAR_SNAPSHOT_LINEAGE_ROW_LIMIT,
  ACCEPTANCE_BAR_SNAPSHOT_PLAN_ITEM_LIMIT,
  ACCEPTANCE_BAR_SNAPSHOT_SCORECARD_LIMIT,
  diffAcceptanceBarContractSnapshots,
  projectAcceptanceBarContractSnapshot,
  readAcceptanceBarContractSnapshot,
  type AcceptanceBarContractSnapshotInput,
  type AcceptanceBarEvidenceSource,
  type AcceptanceBarPlanItemSource,
  type AcceptanceBarSnapshotDeps,
  type AcceptanceBarSubjectPlanSource,
  type AcceptanceBarWorkContractSource,
  type BoundedAcceptanceBarRows,
} from './acceptance-bar-contract-snapshot';
import { computeAcceptanceBarHash, computeAcceptanceBarSetHash, type Rubric, type RubricCriterion } from './rubrics';
import type { SpecClauseRevision } from './agent-tools/plans/spec-clauses-store';
import type { ScorecardRow } from './scorecards';

const iso = '2026-09-04T12:00:00.000Z';

function rows<T>(values: T[], limit = Math.max(values.length, 1), truncated = false): BoundedAcceptanceBarRows<T> {
  return { rows: values, limit, truncated };
}

function criterion(n: number): RubricCriterion {
  const value = {
    key: `r-${n}`,
    title: `Outcome ${n}`,
    model: `Outcome ${n} is true.`,
    method: `Run check ${n}.`,
    driftMarkers: `Outcome ${n} is absent.`,
    barKey: `R-${n}`,
    role: 'outcome' as const,
    mandatory: true,
    requiredScope: ['tree'],
    evidencePlane: 'tree' as const,
    passRatings: ['healthy'],
    barProvenance: {
      lifecycle: 'pre-implementation' as const,
      declaredAt: iso,
      declaredBy: 'su-author',
    },
  };
  return { ...value, barHash: computeAcceptanceBarHash(value) };
}

function scorecard(overrides: Partial<ScorecardRow> = {}): ScorecardRow {
  return {
    issueId: 'SC-GRADE',
    createdAt: '2026-09-04T13:00:00.000Z',
    createdBy: 'su-grader',
    rubricRef: 'acceptance-plan-a',
    rubricRevision: 2,
    ratings: {},
    nKeys: 0,
    missingKeys: [],
    extraKeys: [],
    rubricResolved: true,
    synthesized: false,
    score10: 10,
    linkedItems: [],
    ...overrides,
  } as ScorecardRow;
}

function fixture(n = 2): AcceptanceBarContractSnapshotInput {
  const criteria = Array.from({ length: n }, (_, index) => criterion(index + 1));
  const barSetHash = computeAcceptanceBarSetHash(criteria);
  const plan: AcceptanceBarSubjectPlanSource = {
    workspaceId: 'ws-1',
    harnessSlug: 'papercusp',
    planSlug: 'plan-a',
    status: 'active',
    revision: 7,
    contentHash: 'plan-content-hash',
    adoptionEpoch: 1,
    cohort: 'post-epoch',
    barSetHash,
    rubricSlug: 'acceptance-plan-a',
    rubricRevision: 2,
    seededAt: iso,
    seededBy: 'su-author',
  };
  const rubric = {
    rubricId: 'acceptance-plan-a',
    revision: 2,
    workspaceId: 'ws-1',
    kind: 'acceptance',
    subjectPlan: 'plan-a',
    subjectGoal: null,
    barSetHash,
    barContract: {
      schemaVersion: 1,
      adoptionEpoch: 1,
      cohort: 'post-epoch',
      subjectPlanRevision: 7,
      seededAt: iso,
      seededBy: 'su-author',
    },
    characteristic: 'plan-acceptance',
    title: 'Plan A acceptance',
    description: 'Acceptance',
    criteria,
    ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
    criteriaHash: 'criteria-hash',
    status: 'active',
    created: '2026-09-04',
    updated: '2026-09-04',
    proposedBy: 'su-author',
    createdBy: 'su-author',
  } as unknown as Rubric;
  const planItems: AcceptanceBarPlanItemSource[] = criteria.map((bar, index) => ({
    itemId: `P-${String(index + 1).padStart(3, '0')}`,
    status: 'done',
  }));
  const clauses: SpecClauseRevision[] = criteria.map((bar, index) => {
    const itemId = planItems[index]!.itemId;
    return {
      planSlug: 'plan-a',
      specId: `AUTO-BAR-${bar.barKey}-${itemId}`,
      sourceValId: null,
      currentRevision: 1,
      revision: 1,
      planItemId: itemId,
      behavior: bar.model,
      behaviorClass: 'happy-path',
      requiredEvidence: ['tree'],
      requiredTestLayers: [],
      mutationRequired: false,
      lifecycleStatus: 'active',
      supersedes: null,
      exemption: null,
      falsifier: { observation: bar.driftMarkers },
      contentHash: `spec-hash-${index + 1}`,
      createdBy: 'su-author',
      createdAt: iso,
      acceptedBy: 'su-author',
      acceptedAt: iso,
      acceptanceRef: `acceptance-plan-a@2:${bar.barKey}`,
      sourceBar: {
        barKey: bar.barKey!,
        barHash: bar.barHash!,
        barSetHash,
        rubricSlug: 'acceptance-plan-a',
        rubricRevision: 2,
        evidencePlane: 'tree',
      },
    } as SpecClauseRevision;
  });
  const workContracts: AcceptanceBarWorkContractSource[] = clauses.map((clause, index) => ({
    workItemId: `WI-${index + 1}`,
    planSlug: clause.planSlug,
    specId: clause.specId,
    specRevision: clause.revision,
    specFingerprint: clause.contentHash,
  }));
  const evidence: AcceptanceBarEvidenceSource[] = clauses.map(
    (clause, index) =>
      ({
        id: index + 1,
        workItemId: `WI-${index + 1}`,
        planSlug: clause.planSlug,
        specId: clause.specId,
        sourceValId: null,
        specRevision: clause.revision,
        currentRevision: clause.revision,
        specFingerprint: clause.contentHash,
        evidenceKind: 'test',
        evidenceRef: `test:${index + 1}`,
        fingerprints: {
          sourceFingerprint: `source-${index + 1}`,
          testFingerprint: null,
          fixtureFingerprint: null,
          rubricFingerprint: null,
          environmentFingerprint: null,
        },
        coverageEvidenceRef: null,
        testRunId: null,
        details: {},
        observedAt: iso,
        bindingFingerprint: `binding-${index + 1}`,
        createdBy: 'su-impl',
        createdAt: iso,
        currentness: {
          overall: 'unknown',
          dimensions: {
            spec: 'current',
            source: 'unknown',
            test: 'not-applicable',
            fixture: 'not-applicable',
            rubric: 'not-applicable',
            environment: 'not-applicable',
            coverageEvidence: 'not-applicable',
            testRun: 'not-applicable',
          },
          staleReasons: [],
          unknownReasons: ['source-current-fingerprint-not-supplied'],
        },
      }) as AcceptanceBarEvidenceSource,
  );
  const ratings = Object.fromEntries(
    criteria.map((bar) => [bar.key, { rating: 'healthy', evidence: `verified ${bar.barKey}` }]),
  );
  const independent = scorecard({ ratings, nKeys: criteria.length, supersededBy: 'SC-AUTHOR' });
  const authorVerdict = scorecard({
    issueId: 'SC-AUTHOR',
    createdAt: '2026-09-04T14:00:00.000Z',
    createdBy: 'su-author',
    ratings,
    nKeys: criteria.length,
    supersedes: 'SC-GRADE',
    acceptance: { verdict: 'accept', reasoning: 'Independent evidence is sound.' },
  });
  const vetting = scorecard({
    issueId: 'SC-VET',
    rubricRef: 'meta-acceptance-rubric',
    createdAt: '2026-09-04T12:30:00.000Z',
    createdBy: 'su-critic',
    rubricRevision: 9,
    ratings: { completeness: { rating: 'healthy', evidence: 'complete' } },
    nKeys: 1,
    subject: { kind: 'rubric', ref: 'acceptance-plan-a' },
    vetting: { consultId: 'conv-1', rubricRevision: 2, critiquePosts: 1, critics: ['su-critic'] },
  });
  return {
    planRows: rows([plan], 1),
    rubrics: rows([rubric], ACCEPTANCE_BAR_SNAPSHOT_ACTIVE_RUBRIC_LIMIT),
    planItems: rows(planItems, ACCEPTANCE_BAR_SNAPSHOT_PLAN_ITEM_LIMIT),
    clauses: rows(clauses, 1_000),
    workContracts: rows(workContracts, 1_000),
    evidence: rows(evidence, ACCEPTANCE_BAR_SNAPSHOT_EVIDENCE_LIMIT),
    scorecards: rows([authorVerdict, independent], ACCEPTANCE_BAR_SNAPSHOT_SCORECARD_LIMIT),
    vettingScorecards: rows([vetting], ACCEPTANCE_BAR_SNAPSHOT_SCORECARD_LIMIT),
    lineage: {
      identities: ['su-impl'],
      workItemRowsRead: n,
      auditRowsRead: 1,
      rowLimit: ACCEPTANCE_BAR_SNAPSHOT_LINEAGE_ROW_LIMIT,
      truncated: false,
    },
    partyByIdentity: new Map([
      ['su-author', 'su-author'],
      ['su-grader', 'su-grader'],
      ['su-impl', 'su-impl'],
    ]),
    graderSelectionVia: new Map([['su-grader', 'floor']]),
  };
}

describe('AcceptanceBarContractSnapshot — pure bounded projection', () => {
  it('projects exact source revisions, per-BAR trace, authoritative grading, and one content hash', () => {
    const snapshot = projectAcceptanceBarContractSnapshot(fixture());

    expect(snapshot).toMatchObject({
      schemaVersion: ACCEPTANCE_BAR_CONTRACT_SNAPSHOT_VERSION,
      planSlug: 'plan-a',
      applicable: true,
      completeness: { complete: true, truncated: false, problems: [] },
      readiness: { state: 'ready', codes: [], nextRepair: null },
      sourceRevisions: { subjectPlan: 7, rubricPlan: 2 },
      grading: {
        authoritativeScorecardId: 'SC-GRADE',
        gradedBy: 'su-grader',
        selectedVia: 'floor',
        vetting: { state: 'current', scorecardId: 'SC-VET', rubricRevision: 2 },
        authorVerdict: { state: 'accepted', scorecardId: 'SC-AUTHOR', verdict: 'accept' },
      },
    });
    expect(snapshot.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.bars).toHaveLength(2);
    expect(snapshot.bars[0]).toMatchObject({
      barKey: 'R-1',
      readiness: { state: 'ready', mapping: 'live', method: 'declared', workContract: 'current' },
      proof: { state: 'current', currentEvidence: 1 },
      grading: { state: 'pass', scorecardId: 'SC-GRADE', rating: 'healthy' },
    });
  });

  it('is deterministic when every unordered source arrives in the opposite order', () => {
    const input = fixture(8);
    const first = projectAcceptanceBarContractSnapshot(input);
    const reversed = projectAcceptanceBarContractSnapshot({
      ...input,
      planItems: { ...input.planItems, rows: [...input.planItems.rows].reverse() },
      clauses: { ...input.clauses, rows: [...input.clauses.rows].reverse() },
      workContracts: { ...input.workContracts, rows: [...input.workContracts.rows].reverse() },
      evidence: { ...input.evidence, rows: [...input.evidence.rows].reverse() },
      scorecards: { ...input.scorecards, rows: [...input.scorecards.rows].reverse() },
      vettingScorecards: { ...input.vettingScorecards, rows: [...input.vettingScorecards.rows].reverse() },
      partyByIdentity: new Map([...input.partyByIdentity.entries()].reverse()),
    });

    expect(reversed.contentHash).toBe(first.contentHash);
    expect(reversed.bars).toEqual(first.bars);
  });

  it('fails source completeness when BAR meaning no longer matches the server hash', () => {
    const input = fixture(1);
    input.rubrics.rows[0]!.criteria[0]!.model = 'Quietly rewritten outcome.';

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.completeness.complete).toBe(false);
    expect(snapshot.completeness.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'bar_snapshot_bar_hash_mismatch', barKey: 'R-1' })]),
    );
  });

  it('accepts exactly 200 BARs and refuses + marks truncation at 201', () => {
    const atLimit = projectAcceptanceBarContractSnapshot(fixture(200));
    expect(atLimit.bars).toHaveLength(200);
    expect(atLimit.completeness.truncated).toBe(false);
    expect(atLimit.completeness.problems).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'bar_snapshot_bar_set_too_large' })]),
    );

    const overLimit = projectAcceptanceBarContractSnapshot(fixture(201));
    expect(overLimit.bars).toHaveLength(200);
    expect(overLimit.completeness.truncated).toBe(true);
    expect(overLimit.completeness.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'bar_snapshot_bar_set_too_large' })]),
    );
  });

  it('distinguishes exactly-at-limit from over-limit for every bounded source', () => {
    const input = fixture(1);
    input.clauses = { ...input.clauses, limit: input.clauses.rows.length, truncated: false };
    expect(projectAcceptanceBarContractSnapshot(input).completeness.complete).toBe(true);

    input.clauses = { ...input.clauses, truncated: true };
    const over = projectAcceptanceBarContractSnapshot(input);
    expect(over.completeness.complete).toBe(false);
    expect(over.completeness.truncated).toBe(true);
    expect(over.readiness.nextRepair?.code).toBe('bar_snapshot_source_truncated');
  });
});

describe('AcceptanceBarContractSnapshot — fixed-call loader', () => {
  it('calls every batch reader once for a 200-BAR plan (no per-BAR/N+1 reads)', async () => {
    const source = fixture(200);
    const deps: AcceptanceBarSnapshotDeps = {
      readPlans: vi.fn(async () => source.planRows),
      readRubrics: vi.fn(async () => source.rubrics),
      readPlanItems: vi.fn(async () => source.planItems),
      readClauses: vi.fn(async () => source.clauses),
      readWorkContracts: vi.fn(async () => source.workContracts),
      readEvidence: vi.fn(async () => source.evidence),
      readLineage: vi.fn(async () => source.lineage),
      readScorecards: vi.fn(async () => source.scorecards),
      readVettingScorecards: vi.fn(async () => source.vettingScorecards),
      readParties: vi.fn(async () => new Map(source.partyByIdentity)),
      readGraderSelectionVia: vi.fn(async () => new Map(source.graderSelectionVia)),
    };

    const snapshot = await readAcceptanceBarContractSnapshot('plan-a', deps);

    expect(snapshot.bars).toHaveLength(200);
    for (const reader of Object.values(deps)) expect(reader).toHaveBeenCalledTimes(1);
  });

  it('turns a reader failure into an explicit unavailable source and blocked repair', async () => {
    const source = fixture(1);
    const snapshot = await readAcceptanceBarContractSnapshot('plan-a', {
      readPlans: async () => source.planRows,
      readRubrics: async () => source.rubrics,
      readPlanItems: async () => source.planItems,
      readClauses: async () => {
        throw new Error('clause read down');
      },
      readWorkContracts: async () => source.workContracts,
      readEvidence: async () => source.evidence,
      readLineage: async () => source.lineage,
      readScorecards: async () => source.scorecards,
      readVettingScorecards: async () => source.vettingScorecards,
      readParties: async () => new Map(source.partyByIdentity),
      readGraderSelectionVia: async () => new Map(source.graderSelectionVia),
    });

    expect(snapshot.completeness.complete).toBe(false);
    expect(snapshot.completeness.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'bar_snapshot_source_unavailable', source: 'clauses' })]),
    );
    expect(snapshot.readiness.nextRepair?.code).toBe('bar_snapshot_source_unavailable');
  });
});

describe('AcceptanceBarContractSnapshot — semantic dry-run diff', () => {
  it('keeps a METHOD-only edit distinct and does not require BAR amendment', () => {
    const before = projectAcceptanceBarContractSnapshot(fixture(1));
    const after = structuredClone(before);
    after.bars[0]!.method = 'A better runbook.';

    const diff = diffAcceptanceBarContractSnapshots(before, after, 'amend');

    expect(diff.changed).toBe(true);
    expect(diff.requiresAmendment).toBe(false);
    expect(diff.changes).toEqual([
      expect.objectContaining({ barKey: 'R-1', kinds: ['method-only'], fields: ['method'] }),
    ]);
  });

  it('classifies BAR meaning, evidence plane, mapping, and provenance separately', () => {
    const before = projectAcceptanceBarContractSnapshot(fixture(1));
    const after = structuredClone(before);
    after.bars[0]!.model = 'Changed outcome.';
    after.bars[0]!.evidencePlane = 'live';
    after.bars[0]!.mappings = [];
    after.bars[0]!.provenance = { ...after.bars[0]!.provenance!, declaredAt: '2026-09-05T00:00:00.000Z' };

    const diff = diffAcceptanceBarContractSnapshots(before, after, 'migration');

    expect(diff.requiresAmendment).toBe(true);
    expect(diff.changes[0]?.kinds).toEqual(['bar-meaning', 'evidence-plane', 'mapping', 'provenance-cohort']);
    expect(diff.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
