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
import {
  buildAcceptanceBarAmendmentCandidate,
  computeAcceptanceBarHash,
  computeAcceptanceBarSetHash,
  effectiveCriterionInstrumentKey,
  type Rubric,
  type RubricCriterion,
} from './rubrics';
import type { SpecClauseRevision } from './agent-tools/plans/spec-clauses-store';
import type { ScorecardRow } from './scorecards';
import { evaluateAcceptanceBarLifecycle } from './acceptance-bar-lifecycle-evaluator';

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
    criteriaHash: 'criteria-hash',
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
        // Durable rerun anchor. classifySpecEvidenceLineage rates a binding
        // 'unknown' when nothing identifies a rerunnable proof, and that
        // propagates to the adequacy state — masking the test-LAYER logic these
        // cases exist to exercise. Real evidence for an exercised outcome
        // carries a test run id; the fixture must too.
        testRunId: index + 1,
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
          // The default snapshot reader supplies no `current` input, so this row's
          // `unknown` means "nobody asked", not "the proof is doubtful" (WI-2146375).
          comparisonSupplied: false,
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
    vetting: {
      consultId: 'conv-1',
      rubricRevision: 2,
      criteriaHash: 'criteria-hash',
      critiquePosts: 1,
      critics: ['su-critic'],
    },
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

function provedFixture(n = 2): AcceptanceBarContractSnapshotInput {
  const input = fixture(n);
  const rubric = input.rubrics.rows[0]!;
  for (const criterion of rubric.criteria) {
    criterion.requiredTestLayers = ['integration'];
    criterion.check = { kind: 'instrument', instrumentKey: 'none' };
    criterion.barHash = computeAcceptanceBarHash(criterion);
  }
  const barSetHash = computeAcceptanceBarSetHash(rubric.criteria);
  rubric.barSetHash = barSetHash;
  input.planRows.rows[0]!.barSetHash = barSetHash;
  input.clauses.rows.forEach((clause, index) => {
    clause.requiredTestLayers = ['integration'];
    clause.sourceBar!.barHash = rubric.criteria[index]!.barHash!;
    clause.sourceBar!.barSetHash = barSetHash;
  });
  for (const evidence of input.evidence.rows) {
    evidence.currentness = { ...evidence.currentness, overall: 'current', comparisonSupplied: true,
      dimensions: { ...evidence.currentness.dimensions, source: 'current' }, unknownReasons: [] };
    evidence.details = { evidencePlane: 'tree', adequacy: { testLayer: 'integration', pathReachable: true,
      falsifiable: true, oracleIndependent: true, collected: true, skipped: false, executed: true,
      outcome: 'passed', coverageRungs: { l3: true } } };
  }
  // Falsifiability is demonstrated by an executed negative control, not by the
  // positive row's `falsifiable: true` self-attestation. Keep the logical
  // identity distinct from the recurrence row so the evaluator retains both.
  input.evidence.rows.push(...input.evidence.rows.map((evidence, index) => ({
    ...evidence,
    id: input.evidence.rows.length + index + 1,
    evidenceKind: 'counterexample' as const,
    evidenceRef: `counterexample:${index + 1}`,
    testRunId: input.evidence.rows.length + index + 1,
    bindingFingerprint: `counterexample-binding-${index + 1}`,
    details: {
      evidencePlane: 'tree',
      adequacy: {
        collected: true, skipped: false, executed: true, targeted: true, outcome: 'killed',
      },
    },
  })));
  return input;
}

describe('AcceptanceBarContractSnapshot — pure bounded projection', () => {
  it.each([{ floor: [] }, { floor: ['integration'] }])('keeps a stricter clause current above the BAR test floor $floor', ({ floor }) => {
    const input = floor.length ? provedFixture(1) : fixture(1);
    input.clauses.rows[0]!.requiredTestLayers = [...floor, 'e2e'];

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]!.readiness.codes).not.toContain('bar_snapshot_projection_stale');
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'pre-start').codes).not.toContain('bar_snapshot_projection_stale');
  });

  it('rejects a clause that omits a required BAR test layer', () => {
    const input = provedFixture(1);
    input.clauses.rows[0]!.requiredTestLayers = ['e2e'];

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]!.readiness.codes).toContain('bar_snapshot_projection_stale');
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'pre-start').satisfied).toBe(false);
  });

  it('requires proof of additional clause layers before shipping', () => {
    const input = provedFixture(1);
    input.clauses.rows[0]!.requiredTestLayers = ['integration', 'e2e'];

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]!.readiness.codes).not.toContain('bar_snapshot_projection_stale');
    expect(snapshot.bars[0]!.proof.adequacy?.checks[0]?.wouldBlock).toContain('correct-layer');
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').codes).toContain('bar_snapshot_proof_inadequate');
  });

  it('projects unified sections with shared validation links and preserves absent legacy intent', () => {
    const input = provedFixture(2);
    const rubric = input.rubrics.rows[0]!;
    const first = rubric.criteria[0]!;
    first.intent = { request: 'Export every selected record.', rationale: 'An incomplete export loses work.',
      constraints: ['Include attachments.'], sourceRefs: ['request:export'] };
    first.barHash = computeAcceptanceBarHash(first);
    const barSetHash = computeAcceptanceBarSetHash(rubric.criteria);
    rubric.barSetHash = barSetHash;
    input.planRows.rows[0]!.barSetHash = barSetHash;
    input.clauses.rows.forEach((clause, index) => {
      clause.sourceValId = 'VAL-SHARED';
      clause.sourceBar!.barHash = rubric.criteria[index]!.barHash!;
      clause.sourceBar!.barSetHash = barSetHash;
    });
    const snapshot = projectAcceptanceBarContractSnapshot(input);
    expect(snapshot.bars[0]).toMatchObject({ title: first.title, criterionKey: first.key,
      requirement: { intent: first.intent,
        acceptance: { condition: first.model, falsifier: first.driftMarkers, requiredTestLayers: ['integration'] },
        verification: { method: first.method, check: first.check } } });
    expect(snapshot.bars[1]!.requirement!.intent).toBeNull();
    expect(snapshot.bars.map((bar) => bar.mappings[0]!.sourceValId)).toEqual(['VAL-SHARED', 'VAL-SHARED']);
    expect(snapshot.bars[0]!.workContracts[0]).toMatchObject({ workItemId: 'WI-1', specRevision: 1 });
  });

  it('exposes earlier failed grades and implementer reports separately from independent grading and author acceptance', () => {
    const input = provedFixture(1);
    input.scorecards.rows.push(scorecard({ issueId: 'SC-OLD', rubricRevision: 1,
      criteriaHash: 'criteria-hash-before-change',
      createdAt: '2026-09-03T13:00:00.000Z', supersededBy: 'SC-GRADE',
      ratings: { 'r-1': { rating: 'broken', evidence: 'Export omitted an attachment.' } } }),
    scorecard({ issueId: 'SC-SELF', createdBy: 'su-impl',
      ratings: { 'r-1': { rating: 'healthy', evidence: 'Implementation report.' } } }));
    const snapshot = projectAcceptanceBarContractSnapshot(input);
    expect(snapshot.bars[0]!.grading).toMatchObject({ scorecardId: 'SC-GRADE', state: 'pass' });
    expect(snapshot.bars[0]!.grading.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ scorecardId: 'SC-OLD', rating: 'broken', currentRevision: false,
        authoritative: false, supersededBy: 'SC-GRADE' }),
      expect.objectContaining({ scorecardId: 'SC-SELF', role: 'implementer', authoritative: false }),
      expect.objectContaining({ scorecardId: 'SC-GRADE', role: 'independent', authoritative: true }),
      expect.objectContaining({ scorecardId: 'SC-AUTHOR', role: 'author', authorVerdict: 'accept',
        supersedes: 'SC-GRADE', reasoning: 'Independent evidence is sound.' }),
    ]));
    expect(snapshot.grading.authorVerdict).toMatchObject({ createdBy: 'su-author', rubricRevision: 2,
      supersedes: 'SC-GRADE', scorecardId: 'SC-AUTHOR', state: 'accepted' });
  });

  it('keeps a non-mandatory disclosure visible without making its rating a ship blocker', () => {
    const input = provedFixture(2);
    const rubric = input.rubrics.rows[0]!;
    const disclosure = rubric.criteria[1]!;
    disclosure.role = 'disclosure';
    disclosure.mandatory = false;
    disclosure.passRatings = [];
    disclosure.coversBarKeys = ['R-1'];
    disclosure.barHash = computeAcceptanceBarHash(disclosure);
    const barSetHash = computeAcceptanceBarSetHash(rubric.criteria);
    rubric.barSetHash = barSetHash;
    input.planRows.rows[0]!.barSetHash = barSetHash;
    input.clauses.rows.forEach((clause, index) => {
      clause.sourceBar!.barHash = rubric.criteria[index]!.barHash!;
      clause.sourceBar!.barSetHash = barSetHash;
    });

    const snapshot = projectAcceptanceBarContractSnapshot(input);
    const disclosureBar = snapshot.bars.find((bar) => bar.barKey === 'R-2')!;

    expect(disclosureBar).toMatchObject({
      role: 'disclosure',
      mandatory: false,
      passRatings: [],
      grading: { state: 'not-pass', rating: 'healthy' },
    });
    expect(disclosureBar.readiness.codes).not.toContain('bar_snapshot_grading_not_pass');
    expect(snapshot.readiness.codes).not.toContain('bar_snapshot_grading_not_pass');
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').codes)
      .not.toContain('bar_snapshot_grading_not_pass');
  });

  it('CONTROL: a mandatory outcome with a non-pass rating still blocks shipment', () => {
    const input = provedFixture(1);
    const independent = input.scorecards.rows.find((card) => card.issueId === 'SC-GRADE')!;
    independent.ratings['r-1'] = { rating: 'degraded', evidence: 'The outcome is not yet satisfied.' };

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]!.grading).toMatchObject({ state: 'not-pass', rating: 'degraded' });
    expect(snapshot.bars[0]!.readiness.codes).toContain('bar_snapshot_grading_not_pass');
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').satisfied).toBe(false);
  });

  // D-030 — the repair-then-re-grade dead end. `gradingCurrent` compares only the rubric
  // half (revision + criteriaHash), so a NOT-PASS card whose cited basis was evidence
  // defects stayed `current` forever after those defects were repaired: it stayed
  // `not-pass`, and plan-acceptance-gate returns on not-pass BEFORE the recruiter
  // (`if (!gradingMissing && !gradingStale) return refusal`), so the re-grade its own
  // remediation text asks for could not be summoned by any verb.
  it('stales a non-pass grading whose evidence cohort was bound after it was graded, so a re-grade can be recruited', () => {
    const input = provedFixture(1);
    const independent = input.scorecards.rows.find((card) => card.issueId === 'SC-GRADE')!;
    independent.ratings['r-1'] = { rating: 'degraded', evidence: 'Proof was stale when graded.' };
    const gradedAt = Date.parse(independent.createdAt);
    // The implementer then repairs exactly the evidence that rating cited.
    input.evidence.rows.forEach((row) => {
      row.createdAt = new Date(gradedAt + 60_000).toISOString();
    });

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]!.grading).toMatchObject({ state: 'stale', rating: 'degraded' });
    expect(snapshot.bars[0]!.readiness.codes).toContain('bar_snapshot_grading_stale');
    expect(snapshot.bars[0]!.readiness.codes).not.toContain('bar_snapshot_grading_not_pass');
    // This summons an independent re-grade; it does NOT grant a pass. Still unshippable.
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').satisfied).toBe(false);
  });

  it('CONTROL: a non-pass grading whose evidence predates it stays not-pass, so the escape is not a blanket waiver', () => {
    const input = provedFixture(1);
    const independent = input.scorecards.rows.find((card) => card.issueId === 'SC-GRADE')!;
    independent.ratings['r-1'] = { rating: 'degraded', evidence: 'The outcome is not yet satisfied.' };
    const gradedAt = Date.parse(independent.createdAt);
    input.evidence.rows.forEach((row) => {
      row.createdAt = new Date(gradedAt - 60_000).toISOString();
    });

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]!.grading).toMatchObject({ state: 'not-pass', rating: 'degraded' });
    expect(snapshot.bars[0]!.readiness.codes).toContain('bar_snapshot_grading_not_pass');
  });

  it('CONTROL: a PASSING grading is untouched by later evidence, so repairs do not churn ship-ready bars', () => {
    const input = provedFixture(1);
    const independent = input.scorecards.rows.find((card) => card.issueId === 'SC-GRADE')!;
    const gradedAt = Date.parse(independent.createdAt);
    input.evidence.rows.forEach((row) => {
      row.createdAt = new Date(gradedAt + 60_000).toISOString();
    });

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]!.grading).toMatchObject({ state: 'pass' });
    expect(snapshot.bars[0]!.readiness.codes).not.toContain('bar_snapshot_grading_stale');
  });

  it('keeps historical contracts visible without letting them invalidate a current discharge', () => {
    const input = fixture(1);
    const prior = { ...input.workContracts.rows[0]! };
    input.clauses.rows[0]!.revision = 2;
    input.clauses.rows[0]!.currentRevision = 2;
    input.workContracts.rows[0]!.specRevision = 2;
    input.workContracts.rows.push(prior);
    const snapshot = projectAcceptanceBarContractSnapshot(input);
    expect(snapshot.bars[0]!.workContracts).toHaveLength(2);
    expect(snapshot.bars[0]!.readiness.workContract).toBe('current');
    input.workContracts.rows = [prior];
    expect(projectAcceptanceBarContractSnapshot(input).bars[0]!.readiness.workContract).toBe('stale');
  });
  it('projects exact source revisions, per-BAR trace, authoritative grading, and one content hash', () => {
    const snapshot = projectAcceptanceBarContractSnapshot(provedFixture());

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
        rubricRevision: 2,
        criteriaHash: 'criteria-hash',
        vetting: {
          state: 'current',
          scorecardId: 'SC-VET',
          rubricRevision: 2,
          criteriaHash: 'criteria-hash',
        },
        authorVerdict: {
          state: 'accepted',
          scorecardId: 'SC-AUTHOR',
          verdict: 'accept',
          criteriaHash: 'criteria-hash',
        },
      },
    });
    expect(snapshot.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.bars).toHaveLength(2);
    expect(snapshot.bars[0]).toMatchObject({
      barKey: 'R-1',
      readiness: { state: 'ready', mapping: 'live', method: 'declared', workContract: 'current' },
      proof: { state: 'current', currentEvidence: 2 },
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

  it('accepts a fully exercised outcome and refuses a green module suite for a required integration path', () => {
    const input = provedFixture(1);
    const accepted = projectAcceptanceBarContractSnapshot(input);
    expect(accepted.bars[0]!.proof.adequacy?.state).toBe('pass');
    expect(evaluateAcceptanceBarLifecycle(accepted, 'ship').satisfied).toBe(true);
    input.evidence.rows[0]!.details.adequacy = { ...(input.evidence.rows[0]!.details.adequacy as object), testLayer: 'unit' };
    const blocked = projectAcceptanceBarContractSnapshot(input);
    expect(blocked.bars[0]!.proof.adequacy?.checks[0]?.wouldBlock).toContain('correct-layer');
    expect(evaluateAcceptanceBarLifecycle(blocked, 'ship').codes).toContain('bar_snapshot_proof_inadequate');
  });

  it('does not invent an automated proof floor for a non-automated delivery-plane clause', () => {
    const input = fixture(1);
    input.clauses.rows[0]!.behaviorClass = 'non-automated';
    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]).toMatchObject({ behaviorClass: 'non-automated', requiredTestLayers: [] });
    expect(snapshot.bars[0]!.readiness.codes).not.toContain('bar_snapshot_proof_depth_missing');
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').codes)
      .not.toContain('bar_snapshot_proof_depth_missing');
  });

  // An EXPLICITLY manual BAR (check instrument:'none') must not carry an automated proof
  // floor even on the `tree` plane, where acceptanceBarBehaviorClass projects every clause
  // as `happy-path`. Before this, such a criterion was unshippable by construction: the
  // only escapes were declaring test layers it does not have (which also mutates barHash,
  // breaking the pin) or demoting a mandatory outcome to `disclosure` — both false.
  it('does not invent an automated proof floor for an explicitly manual tree-plane BAR', () => {
    const input = fixture(1);
    input.rubrics.rows[0]!.criteria[0]!.check = { kind: 'instrument', instrumentKey: 'none' };
    // Deliberately left as the production shape: tree plane, happy-path clause, no layers.
    expect(input.clauses.rows[0]!.behaviorClass).toBe('happy-path');

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    // Measured: the manual BAR carries NO readiness codes at all once the exemption applies.
    expect(effectiveCriterionInstrumentKey(input.rubrics.rows[0]!.criteria[0]!)).toBe('none');
    expect(snapshot.bars[0]!.automatedProofRequired).toBe(false);
    expect(snapshot.bars[0]!.readiness.codes).not.toContain('bar_snapshot_proof_depth_missing');
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').codes)
      .not.toContain('bar_snapshot_proof_depth_missing');
  });

  // ANTI-LOOPHOLE (both directions). The exemption is keyed to an explicit authored
  // instrument:'none'; an ordinary automated BAR keeps its floor, so this cannot become a
  // general way to skip proof depth.
  it('still requires proof depth for a tree-plane BAR that declares a structured test check', () => {
    const input = fixture(1);
    input.rubrics.rows[0]!.criteria[0]!.check = {
      kind: 'tests',
      files: ['packages/operator-core/lib/acceptance-bar-contract-snapshot.test.ts'],
    };

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]!.readiness.codes).toContain('bar_snapshot_proof_depth_missing');
  });

  // FAILS CLOSED: an instrument:'none' criterion whose CLAUSE still declares an automated
  // obligation keeps the floor, matching the mixed-projection rule above it. Measured: the
  // floor is kept as `proof_depth_missing`, because `adequacyState` reads the CRITERION's
  // requiredTestLayers (still empty here), not the clause's.
  it('keeps the proof floor when a manual BAR has a clause declaring a test layer', () => {
    const input = fixture(1);
    input.rubrics.rows[0]!.criteria[0]!.check = { kind: 'instrument', instrumentKey: 'none' };
    input.clauses.rows[0]!.requiredTestLayers = ['unit'];

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.bars[0]!.readiness.codes).toContain('bar_snapshot_proof_depth_missing');
  });

  it('uses current evidence across planes for mixed-layer adequacy on a live BAR', () => {
    const input = provedFixture(1);
    const criterion = input.rubrics.rows[0]!.criteria[0]!;
    const clause = input.clauses.rows[0]!;
    criterion.evidencePlane = 'live';
    criterion.requiredTestLayers = ['unit', 'e2e'];
    criterion.barHash = computeAcceptanceBarHash(criterion);
    const barSetHash = computeAcceptanceBarSetHash([criterion]);
    input.rubrics.rows[0]!.barSetHash = barSetHash;
    input.planRows.rows[0]!.barSetHash = barSetHash;
    clause.requiredTestLayers = ['unit', 'e2e'];
    clause.sourceBar!.barHash = criterion.barHash;
    clause.sourceBar!.barSetHash = barSetHash;
    clause.sourceBar!.evidencePlane = 'live';

    const treeUnit = input.evidence.rows[0]!;
    treeUnit.details = {
      evidencePlane: 'tree',
      adequacy: { ...(treeUnit.details.adequacy as object), testLayer: 'unit' },
    };
    const liveE2e = {
      ...treeUnit,
      id: 2,
      evidenceRef: 'test:e2e',
      details: {
        evidencePlane: 'live',
        adequacy: { ...(treeUnit.details.adequacy as object), testLayer: 'e2e' },
      },
    };
    input.evidence.rows = [treeUnit, liveE2e, ...input.evidence.rows.slice(1)];

    const snapshot = projectAcceptanceBarContractSnapshot(input);
    expect(snapshot.bars[0]!.proof.adequacy).toMatchObject({
      state: 'pass',
      checks: [expect.objectContaining({ verdict: 'pass' })],
    });
    expect(snapshot.bars[0]!.proof.evidencePlanes).toEqual(['live', 'tree']);
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').codes).not.toContain('bar_snapshot_proof_inadequate');
  });

  it.each([
    ['unreachable', { pathReachable: false }], ['skipped', { skipped: true }],
    ['failed', { outcome: 'failed' }], ['self-oracle', { oracleIndependent: false }],
  ])('refuses %s proof even when the independent rating claims success', (_name, patch) => {
    const input = provedFixture(1);
    input.evidence.rows[0]!.details.adequacy = { ...(input.evidence.rows[0]!.details.adequacy as object), ...patch };
    const snapshot = projectAcceptanceBarContractSnapshot(input);
    expect(snapshot.bars[0]!.grading.state).toBe('pass');
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').codes).toContain('bar_snapshot_proof_inadequate');
  });

  it('does not treat absent freshness comparisons as current proof', () => {
    const input = provedFixture(1);
    input.evidence.rows[0]!.currentness = fixture(1).evidence.rows[0]!.currentness;
    input.evidence.rows[1]!.currentness = fixture(1).evidence.rows[0]!.currentness;
    const snapshot = projectAcceptanceBarContractSnapshot(input);
    expect(snapshot.bars[0]!.proof.adequacy?.checks[0]?.wouldBlock).toContain('freshness');
    expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').satisfied).toBe(false);
  });

  it('keeps failed history after a successful revision without borrowing its evidence plane', () => {
    const input = provedFixture(1);
    const historical = { ...input.evidence.rows[0]!, id: 99, evidenceRef: 'old-live-failure', specRevision: 0,
      details: { evidencePlane: 'live', adequacy: { outcome: 'failed' } } };
    input.evidence.rows.push(historical);
    const snapshot = projectAcceptanceBarContractSnapshot(input);
    expect(snapshot.bars[0]!.proof.evidenceRefs).toContain('old-live-failure');
    expect(snapshot.bars[0]!.proof.evidencePlanes).toEqual(['tree']);
    expect(snapshot.bars[0]!.proof.adequacy?.state).toBe('pass');
    expect(snapshot.bars[0]!.proof.staleEvidence).toBe(1);
    expect(snapshot.bars[0]!.proof.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidenceRef: 'old-live-failure', specRevision: 0, matchesCurrentSpec: false,
        details: { evidencePlane: 'live', adequacy: { outcome: 'failed' } } }),
      expect.objectContaining({ specRevision: 1, matchesCurrentSpec: true, currentness: { ...input.evidence.rows[0]!.currentness } }),
    ]));
  });

  it.each(['pass', 'failed', 'unknown', 'pending', 'stale'])(
    'shipment selects the latest equivalent registered attempt (%s), retaining immutable history', outcome => {
      const input = provedFixture(1);
      const base = input.evidence.rows[0]!;
      const makeAttempt = (n: number, result: string): AcceptanceBarEvidenceSource[] => {
        const binding = { specId: base.specId, specRevision: base.specRevision,
          testPath: 'test/journey.test.ts', sourcePaths: ['src/journey.ts'], testLayer: 'integration' };
        const pending = { ...base, id: n * 10, evidenceRef: `test-run-group:attempt-${n}:0`, testRunId: null,
          details: { currentMeasurement: { schemaVersion: 1, kind: 'repo-files',
            testPaths: [binding.testPath], sourcePaths: binding.sourcePaths },
          testExecution: { schemaVersion: 1, phase: 'pending', originRunId: `attempt-${n}`, binding },
          adequacy: { testLayer: 'integration', outcome: 'pending', executed: false, collected: false } } };
        return [pending, ...(result === 'pending' ? [] : [{ ...pending, id: n * 10 + 1, testRunId: n,
          details: { ...pending.details, evidencePlane: 'tree',
            testExecution: { ...pending.details.testExecution, phase: 'settled' },
            adequacy: { ...(base.details.adequacy as object), outcome: result } } }])];
      };
      const old = makeAttempt(1, outcome === 'pass' ? 'unknown' : 'pass');
      const fresh = makeAttempt(2, outcome === 'stale' ? 'pass' : outcome);
      if (outcome === 'stale') fresh[1]!.currentness = { ...fresh[1]!.currentness, overall: 'stale',
        staleReasons: ['source-fingerprint-changed'] };
      input.evidence.rows = [...old, ...fresh, input.evidence.rows[1]!];
      if (outcome === 'pass') input.evidence.rows.push({ ...old[1]!, id: 99,
        evidenceKind: 'counterexample', evidenceRef: 'manual-negative-controls:old',
        currentness: { ...old[1]!.currentness, overall: 'stale', staleReasons: ['source-stale'] } });
      const before = JSON.stringify(input.evidence.rows);
      const snapshot = projectAcceptanceBarContractSnapshot(input);
      expect(JSON.stringify(input.evidence.rows)).toBe(before);
      expect(snapshot.bars[0]!.proof.history).toHaveLength(input.evidence.rows.length);
      if (outcome !== 'pending') {
        expect(snapshot.bars[0]!.proof.history?.find(row => row.id === old[1]!.id)?.activeAttempt).toBe(false);
        expect(snapshot.bars[0]!.proof.adequacy?.checks[0]?.evidenceRefs).not.toContain(old[1]!.evidenceRef);
      }
      if (outcome === 'pass') {
        expect(snapshot.bars[0]!.proof.adequacy?.state).toBe('pass');
        expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').codes).not.toContain('bar_snapshot_proof_inadequate');
      } else {
        expect(snapshot.bars[0]!.proof.adequacy?.checks[0]?.wouldBlock)
          .toContain(outcome === 'stale' ? 'freshness' : 'execution-integrity');
        expect(evaluateAcceptanceBarLifecycle(snapshot, 'ship').codes).toContain('bar_snapshot_proof_inadequate');
      }
    },
  );

  it('fails source completeness when BAR meaning no longer matches the server hash', () => {
    const input = fixture(1);
    input.rubrics.rows[0]!.criteria[0]!.model = 'Quietly rewritten outcome.';

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    expect(snapshot.completeness.complete).toBe(false);
    expect(snapshot.completeness.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'bar_snapshot_bar_hash_mismatch', barKey: 'R-1' })]),
    );
  });

  // EI-23525318282609167: the emitter always sets barKey, and the assertion above
  // proves it — but per-bar readiness.codes used to be derived INDEPENDENTLY of
  // `problems`, so the hash-integrity codes reached the contract level and never
  // reached the BAR. Two consequences, and the second is the dangerous one:
  // nextRepair's `bars.find(...)` missed and reported barKey:null, AND a BAR whose
  // meaning no longer matches its stored hash reported state:'ready'. Measured live
  // on acceptance-unified-requirement-contract-2026-09-05: six mismatching BARs all
  // reported clean while the contract said "0 of 6 BAR(s) blocking".
  it('attributes a BAR hash mismatch to the BAR itself, not only to the contract', () => {
    const input = fixture(1);
    input.rubrics.rows[0]!.criteria[0]!.model = 'Quietly rewritten outcome.';

    const snapshot = projectAcceptanceBarContractSnapshot(input);

    const bar = snapshot.bars.find((candidate) => candidate.barKey === 'R-1');
    expect(bar).toBeDefined();
    // The BAR must not report itself clean while its meaning and hash diverge.
    expect(bar!.readiness.codes).toContain('bar_snapshot_bar_hash_mismatch');
    expect(bar!.readiness.state).toBe('blocked');
    // ...and the ranked repair must name a target an operator can act on.
    expect(snapshot.readiness.nextRepair).toEqual(
      expect.objectContaining({ code: 'bar_snapshot_bar_hash_mismatch', barKey: 'R-1' }),
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
  it('lets the canonical amendment candidate repair a legacy structured-check hash only when next hashes validate', () => {
    const input = fixture(1);
    const stored = input.rubrics.rows[0]!;
    const prior = stored.criteria[0]!;
    const legacyHash = prior.barHash!;
    const legacyCriterion: RubricCriterion = {
      ...prior,
      check: { kind: 'tests', files: ['packages/operator-core/lib/acceptance-bar-seed.test.ts'] },
      // Models a row written by the pre-EI-22795002901203049 hash function,
      // which did not bind the already-persisted structured check.
      barHash: legacyHash,
    };
    stored.criteria[0] = legacyCriterion;
    const snapshot = projectAcceptanceBarContractSnapshot(input);
    expect(snapshot.completeness.problems).toContainEqual(
      expect.objectContaining({ code: 'bar_snapshot_bar_hash_mismatch', barKey: 'R-1' }),
    );

    const repairedCriterion = {
      ...legacyCriterion,
      barHash: computeAcceptanceBarHash(legacyCriterion),
    };
    const repairedSetHash = computeAcceptanceBarSetHash([repairedCriterion]);
    const desiredMappings = new Map([['R-1', { planItemIds: ['P-001'] }]]);
    const itemStatuses = new Map([['P-001', 'done']]);
    const contract = {
      rubricRevision: 3,
      subjectPlanRevision: 8,
      barSetHash: repairedSetHash,
      barContract: { ...stored.barContract!, subjectPlanRevision: 8 },
    };
    const repaired = buildAcceptanceBarAmendmentCandidate(
      snapshot,
      [repairedCriterion],
      desiredMappings,
      itemStatuses,
      contract,
    );
    expect(repaired.completeness.problems).not.toContainEqual(
      expect.objectContaining({ code: 'bar_snapshot_bar_hash_mismatch' }),
    );
    expect(evaluateAcceptanceBarLifecycle(repaired, 'pre-vetting').satisfied).toBe(true);

    const malformedCriterion = { ...repairedCriterion, barHash: '0'.repeat(64) };
    const malformed = buildAcceptanceBarAmendmentCandidate(
      snapshot,
      [malformedCriterion],
      desiredMappings,
      itemStatuses,
      { ...contract, barSetHash: computeAcceptanceBarSetHash([malformedCriterion]) },
    );
    expect(malformed.completeness.problems).toContainEqual(
      expect.objectContaining({ code: 'bar_snapshot_bar_hash_mismatch' }),
    );
    expect(evaluateAcceptanceBarLifecycle(malformed, 'pre-vetting').satisfied).toBe(false);
  });

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

  it('names a required proof-layer change instead of reporting a hash-only BAR amendment', () => {
    const before = projectAcceptanceBarContractSnapshot(fixture(1));
    const after = structuredClone(before);
    after.bars[0]!.requiredTestLayers = ['integration'];

    const diff = diffAcceptanceBarContractSnapshots(before, after, 'amend');

    expect(diff.requiresAmendment).toBe(true);
    expect(diff.changes).toEqual([
      expect.objectContaining({
        barKey: 'R-1',
        kinds: ['bar-meaning'],
        fields: ['requiredTestLayers'],
      }),
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

  // WI-2146375. The acceptance-BAR ship gate reads `bar.proof.uncertainEvidence` and, when it is
  // non-zero, raises `bar_snapshot_proof_uncertain` — which `phaseSnapshotCodes` returns at phase
  // 'ship', so it BLOCKS. The count used to include rows whose currentness was `unknown` purely
  // because the reader supplied no comparison input. `defaultReadEvidence` never supplies one and
  // `source_fingerprint` is NOT NULL, so every bound row counted, unconditionally — and since zero
  // rows already raises `bar_snapshot_proof_missing`, the proof leg had NO satisfiable state and no
  // enrolled plan could ship. Measured both ways on :3170 before the fix.
  it('does not call proof uncertain when the reader never asked for a currentness comparison', () => {
    const input = fixture(1);
    const evidence = input.evidence.rows[0]!;
    expect(evidence.currentness.comparisonSupplied).toBe(false);
    expect(evidence.currentness.overall).toBe('unknown');

    expect(projectAcceptanceBarContractSnapshot(input).bars[0]!.proof.uncertainEvidence).toBe(0);
  });

  it('DOES call proof uncertain when a comparison was supplied and came back unknown', () => {
    const input = fixture(1);
    // The control that keeps the test above honest: flipping ONLY `comparisonSupplied` must
    // restore the count. If this ever passes alongside the assertion above, the count is
    // ignoring the dimensions rather than ignoring un-asked questions, and the check is vacuous.
    input.evidence.rows[0]!.currentness.comparisonSupplied = true;

    expect(projectAcceptanceBarContractSnapshot(input).bars[0]!.proof.uncertainEvidence).toBe(1);
  });

  it('does not let uncertain evidence from a superseded spec revision poison current proof', () => {
    const input = fixture(1);
    const evidence = input.evidence.rows[0]!;
    evidence.specRevision += 1;
    evidence.currentness = {
      ...evidence.currentness,
      overall: 'stale',
      comparisonSupplied: true,
      dimensions: {
        ...evidence.currentness.dimensions,
        spec: 'stale',
        environment: 'unknown',
      },
      staleReasons: ['spec-stale'],
      unknownReasons: ['environment-current-fingerprint-not-supplied'],
    };

    expect(projectAcceptanceBarContractSnapshot(input).bars[0]!.proof.uncertainEvidence).toBe(0);
  });
});

/**
 * Plan `bar-reporting-layer-repairs-2026-09-07` — the reporting layer's four
 * projection/evaluator repairs. (Its fifth, R-5/P-005, is an authorization
 * surface and lives beside its own subject in
 * `agent-tools/scorecards/grader-eligibility.test.ts`.)
 *
 * Each `it` below is the corresponding spec clause's `falsifier.probeMethod`
 * executed literally, so the clause and its proof cannot drift apart. Every
 * rule keeps a permanent CONTROL that must fail in the opposite direction —
 * the discipline the sibling blocks in this file already follow, and the only
 * thing that keeps a later green run evidence of anything. The shared defect
 * these four repair (plan D-002) is one confusion: asserting a fact about the
 * AUTHOR where the system only observed a failed read.
 */
describe('BAR reporting-layer repairs (bar-reporting-layer-repairs-2026-09-07)', () => {
  describe('R-1 / P-001 — a readiness verdict is attributable to the BAR that produced it', () => {
    /** One blocked BAR beside one clean BAR — the shape the flat message erased. */
    const oneBlockedOfTwo = () => {
      const input = provedFixture(2);
      // The lever the sibling blocks above already use: a clause demanding a test
      // layer its BAR does not require blocks exactly that one BAR.
      input.clauses.rows[0]!.requiredTestLayers = ['e2e'];
      return projectAcceptanceBarContractSnapshot(input);
    };

    it('names the blocking barKey adjacent to its own codes', () => {
      const verdict = evaluateAcceptanceBarLifecycle(oneBlockedOfTwo(), 'pre-start');

      expect(verdict.blockingBars).toEqual([{ barKey: 'R-1', codes: ['bar_snapshot_projection_stale'] }]);
      expect(verdict.message).toContain('R-1: bar_snapshot_projection_stale');
      // The clean BAR is counted out loud, so "one BAR is blocked" cannot be read as
      // "the whole contract regressed" — the misreading whose wrong next action is
      // `rubrics:amend`, which destroys an in-flight grading card.
      expect(verdict.message).toContain('1 of 2 BAR(s) blocking, 1 clean');
    });

    it('attributes each code to its owning BAR and leaves contract-level empty', () => {
      const verdict = evaluateAcceptanceBarLifecycle(oneBlockedOfTwo(), 'pre-start');

      expect(verdict.codeAttribution).toEqual([{ code: 'bar_snapshot_projection_stale', barKeys: ['R-1'] }]);
      expect(verdict.contractCodes).toEqual([]);
    });

    it('CONTROL: a code no BAR owns is reported as contract-level, not attributed to one', () => {
      // Falsifiability. If attribution swept every code onto some BAR, `contractCodes`
      // would always be empty and the rule above would pass while saying nothing.
      const input = fixture(1);
      input.rubrics = rows([], ACCEPTANCE_BAR_SNAPSHOT_ACTIVE_RUBRIC_LIMIT);

      const verdict = evaluateAcceptanceBarLifecycle(projectAcceptanceBarContractSnapshot(input), 'pre-start');

      expect(verdict.contractCodes).toContain('bar_snapshot_rubric_unresolved');
      expect(verdict.codeAttribution.find((entry) => entry.code === 'bar_snapshot_rubric_unresolved')?.barKeys).toEqual(
        [],
      );
      expect(verdict.message).toContain('contract-level:');
    });
  });

  describe('R-2 / P-002 — an unresolvable rubric is UNKNOWN, never an author-attributable absence', () => {
    it('emits the unresolved code and neither absence code when the plan PINS a rubric', () => {
      const input = fixture(1);
      // The pin is the whole premise: it is in-band evidence the author DID write one.
      expect(input.planRows.rows[0]!.rubricSlug).toBe('acceptance-plan-a');
      input.rubrics = rows([], ACCEPTANCE_BAR_SNAPSHOT_ACTIVE_RUBRIC_LIMIT);

      const codes = projectAcceptanceBarContractSnapshot(input).readiness.codes;

      expect(codes).toContain('bar_snapshot_rubric_unresolved');
      expect(codes).not.toContain('bar_snapshot_rubric_missing');
      expect(codes).not.toContain('bar_snapshot_bar_set_empty');
    });

    it('carries the pin as evidence, so a reader can re-route instead of blaming the author', () => {
      const input = fixture(1);
      input.rubrics = rows([], ACCEPTANCE_BAR_SNAPSHOT_ACTIVE_RUBRIC_LIMIT);

      const problem = projectAcceptanceBarContractSnapshot(input).completeness.problems.find(
        (entry) => entry.code === 'bar_snapshot_rubric_unresolved',
      );

      expect(problem?.detail).toContain('acceptance-plan-a');
      expect(problem?.detail).toContain('at revision 2');
      expect(problem?.detail).not.toContain('acceptance-plan-a@2');
      expect(problem?.detail).toContain('not evidence that none exists');
    });

    it('reports a failed rubric READ as unresolved even with no pin to appeal to', () => {
      const input = fixture(1);
      input.rubrics = rows([], ACCEPTANCE_BAR_SNAPSHOT_ACTIVE_RUBRIC_LIMIT);
      input.planRows.rows[0]!.rubricSlug = null;
      input.readFailures = { rubric: 'connection closed' };

      const codes = projectAcceptanceBarContractSnapshot(input).readiness.codes;

      expect(codes).toContain('bar_snapshot_rubric_unresolved');
      expect(codes).not.toContain('bar_snapshot_rubric_missing');
    });

    it('CONTROL: with no pin AND no read failure, the same empty read IS an absence', () => {
      // The direction that must still fire. Without this, suppressing the absence
      // codes unconditionally would pass every assertion above.
      const input = fixture(1);
      input.rubrics = rows([], ACCEPTANCE_BAR_SNAPSHOT_ACTIVE_RUBRIC_LIMIT);
      input.planRows.rows[0]!.rubricSlug = null;

      const codes = projectAcceptanceBarContractSnapshot(input).readiness.codes;

      expect(codes).toContain('bar_snapshot_rubric_missing');
      expect(codes).toContain('bar_snapshot_bar_set_empty');
      expect(codes).not.toContain('bar_snapshot_rubric_unresolved');
    });
  });

  describe('R-6 / P-004 — rubric evidence follows substantive identity, not revision churn', () => {
    /**
     * Two inputs differing ONLY in the rubric revision counter: same criteria, same
     * `barHash` for every BAR. The recorded cards stay pinned at revision 2.
     */
    const bumpedTo3 = (criteriaHash = 'criteria-hash') => {
      const input = fixture(1);
      const rubric = input.rubrics.rows[0]!;
      const hashesBefore = rubric.criteria.map((entry) => entry.barHash);

      (rubric as unknown as { revision: number }).revision = 3;
      rubric.criteriaHash = criteriaHash;
      input.planRows.rows[0]!.rubricRevision = 3;

      // The premise the clause names: BAR identity is byte-identical either way.
      expect(rubric.criteria.map((entry) => entry.barHash)).toEqual(hashesBefore);
      return projectAcceptanceBarContractSnapshot(input);
    };

    it('keeps an already-recorded grading card and the vetting attestation current', () => {
      const snapshot = bumpedTo3();

      expect(snapshot.bars[0]!.grading.state).toBe('pass');
      expect(snapshot.grading.vetting.state).toBe('current');
      expect(snapshot.bars[0]!.readiness.codes).not.toContain('bar_snapshot_projection_stale');
    });

    it('CONTROL: a same-revision dependency identity change invalidates both', () => {
      const input = fixture(1);
      input.rubrics.rows[0]!.criteriaHash = 'criteria-hash-after-method-change';
      const snapshot = projectAcceptanceBarContractSnapshot(input);

      expect(snapshot.bars[0]!.grading.state).toBe('stale');
      expect(snapshot.grading.vetting.state).toBe('stale');
    });

    it('CONTROL: one-sided legacy identity is unknown and never becomes passing proof', () => {
      const input = fixture(1);
      for (const card of input.scorecards.rows) delete card.criteriaHash;
      for (const card of input.vettingScorecards.rows) {
        if (card.vetting) delete card.vetting.criteriaHash;
      }
      const snapshot = projectAcceptanceBarContractSnapshot(input);

      expect(snapshot.bars[0]!.grading.state).toBe('stale');
      expect(snapshot.grading.vetting.state).toBe('stale');
    });
  });

  describe('R-4 / P-004 — the accepted judgment is recordable apart from the delivered fact', () => {
    const withAuthorVerdict = (verdict: string) => {
      const input = fixture(1);
      const author = input.scorecards.rows.find((card) => card.issueId === 'SC-AUTHOR')!;
      (author as unknown as { acceptance: unknown }).acceptance = {
        verdict,
        reasoning: 'Every reachable criterion is proved; the delivery plane is not this author to reach.',
      };
      return projectAcceptanceBarContractSnapshot(input);
    };

    it('persists a verdict distinguishable from both accept and reject, and reads it back', () => {
      const snapshot = withAuthorVerdict('accept-pending-delivery');

      expect(snapshot.grading.authorVerdict.state).toBe('accepted-pending-delivery');
      expect(snapshot.grading.authorVerdict.verdict).toBe('accept-pending-delivery');
      expect(snapshot.grading.authorVerdict.reasoning).toContain('not this author to reach');
      // Distinguishable from the two verdicts it exists to avoid: `accept` would
      // overclaim delivery and `reject` would be false.
      expect(snapshot.grading.authorVerdict.state).not.toBe('accepted');
      expect(snapshot.grading.authorVerdict.state).not.toBe('rejected');
    });

    it('surfaces it through the readiness projection as its own code', () => {
      const codes = withAuthorVerdict('accept-pending-delivery').readiness.codes;

      expect(codes).toContain('bar_snapshot_author_accepted_pending_delivery');
      // The author's own obligation IS met — the disclosure must not masquerade as
      // a missing or rejected verdict, which is what forces the ceremony to stall.
      expect(codes).not.toContain('bar_snapshot_author_verdict_missing');
      expect(codes).not.toContain('bar_snapshot_author_rejected');
    });

    it('CONTROL: accept and reject keep their own distinct states and codes', () => {
      const accepted = withAuthorVerdict('accept');
      expect(accepted.grading.authorVerdict.state).toBe('accepted');
      expect(accepted.readiness.codes).not.toContain('bar_snapshot_author_accepted_pending_delivery');

      const rejected = withAuthorVerdict('reject');
      expect(rejected.grading.authorVerdict.state).toBe('rejected');
      expect(rejected.readiness.codes).toContain('bar_snapshot_author_rejected');
      expect(rejected.readiness.codes).not.toContain('bar_snapshot_author_accepted_pending_delivery');
    });

    it('CONTROL: an unrecognized verdict does not fall through into the new state', () => {
      // The new branch is a strict equality on one literal, not a catch-all — an
      // unparseable verdict must still read as "no verdict recorded".
      const snapshot = withAuthorVerdict('probably-fine');

      expect(snapshot.grading.authorVerdict.state).toBe('missing');
      expect(snapshot.readiness.codes).not.toContain('bar_snapshot_author_accepted_pending_delivery');
    });
  });
});
