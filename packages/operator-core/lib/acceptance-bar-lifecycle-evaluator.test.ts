import { describe, expect, it } from 'vitest';
import type { AcceptanceBarContractSnapshot, AcceptanceBarTrace } from './acceptance-bar-contract-snapshot';
import { evaluateAcceptanceBarContract, evaluateAcceptanceBarLifecycle } from './acceptance-bar-lifecycle-evaluator';

function bar(overrides: Partial<AcceptanceBarTrace> = {}): AcceptanceBarTrace {
  return {
    barKey: 'R-1',
    criterionKey: 'r-1',
    barHash: 'a'.repeat(64),
    model: 'The outcome is true.',
    method: '',
    check: null,
    replication: null,
    falsifier: 'The outcome is absent.',
    role: 'outcome',
    mandatory: true,
    requiredScope: ['tree'],
    evidencePlane: 'tree',
    passRatings: ['healthy'],
    coversBarKeys: [],
    provenance: {
      lifecycle: 'pre-implementation',
      declaredAt: '2026-09-04T12:00:00.000Z',
      declaredBy: 'su-author',
    },
    mappings: [
      {
        planItemId: 'P-001',
        planItemStatus: 'todo',
        specId: 'spec-1',
        specRevision: 1,
        specContentHash: 'spec-hash',
        sourceBarHash: 'a'.repeat(64),
        sourceBarSetHash: 'b'.repeat(64),
        sourceRubricRevision: 1,
        evidencePlane: 'tree',
      },
    ],
    workContracts: [
      {
        workItemId: 'WI-1',
        specId: 'spec-1',
        specRevision: 1,
        specFingerprint: 'spec-hash',
        current: true,
      },
    ],
    proof: {
      state: 'missing',
      currentEvidence: 0,
      staleEvidence: 0,
      kinds: [],
      evidenceRefs: [],
      uncertainEvidence: 0,
      evidencePlanes: [],
    },
    grading: {
      state: 'missing',
      scorecardId: null,
      rubricRevision: null,
      gradedBy: null,
      selectedVia: null,
      rating: null,
      evidence: null,
    },
    readiness: {
      state: 'ready',
      codes: [],
      mapping: 'live',
      method: 'missing',
      workContract: 'current',
    },
    ...overrides,
  };
}

function snapshot(overrides: Partial<AcceptanceBarContractSnapshot> = {}): AcceptanceBarContractSnapshot {
  const trace = bar();
  return {
    schemaVersion: 1,
    contentHash: 'c'.repeat(64),
    planSlug: 'plan-a',
    applicable: true,
    plan: {
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      planSlug: 'plan-a',
      status: 'active',
      revision: 1,
      contentHash: 'plan-content',
      adoptionEpoch: 1,
      cohort: 'post-epoch',
      barSetHash: 'b'.repeat(64),
      rubricSlug: 'acceptance-plan-a',
      rubricRevision: 1,
      seededAt: '2026-09-04T12:00:00.000Z',
      seededBy: 'su-author',
    },
    rubric: {
      rubricId: 'acceptance-plan-a',
      revision: 1,
      criteriaHash: 'criteria',
      barSetHash: 'b'.repeat(64),
      contract: {
        schemaVersion: 1,
        adoptionEpoch: 1,
        cohort: 'post-epoch',
        subjectPlanRevision: 1,
        seededAt: '2026-09-04T12:00:00.000Z',
        seededBy: 'su-author',
      },
      createdBy: 'su-author',
      ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
      classRef: null,
    },
    sourceRevisions: { subjectPlan: 1, rubricPlan: 1, clauses: [], workContracts: [], scorecardIds: [] },
    bounded: {
      plans: { rowsRead: 1, limit: 1, truncated: false },
      rubrics: { rowsRead: 1, limit: 2, truncated: false },
      planItems: { rowsRead: 1, limit: 500, truncated: false },
      clauses: { rowsRead: 1, limit: 1000, truncated: false },
      workContracts: { rowsRead: 1, limit: 1000, truncated: false },
      evidence: { rowsRead: 0, limit: 2000, truncated: false },
      scorecards: { rowsRead: 0, limit: 50, truncated: false },
      vetting: { rowsRead: 0, limit: 50, truncated: false },
      lineage: { rowsRead: 1, limit: 1000, truncated: false },
    },
    completeness: { complete: true, truncated: false, problems: [] },
    lineage: { identities: ['su-impl'], parties: [], complete: true },
    grading: {
      authoritativeScorecardId: null,
      gradedBy: null,
      selectedVia: null,
      rubricRevision: null,
      vetting: { state: 'missing', scorecardId: null, rubricRevision: null },
      authorVerdict: { state: 'missing', scorecardId: null, verdict: null },
    },
    bars: [trace],
    readiness: { state: 'ready', codes: [], nextRepair: null },
    ...overrides,
  };
}

describe('AcceptanceBarLifecycleEvaluator — phase-aware BAR contract', () => {
  it('allows a complete BAR with an empty METHOD at pre-start', () => {
    const verdict = evaluateAcceptanceBarLifecycle(snapshot(), 'pre-start');
    expect(verdict.satisfied).toBe(true);
    expect(verdict.codes).toEqual([]);
  });

  it('rejects missing identity/falsifier/mapping structure before start', () => {
    const current = snapshot({
      bars: [
        bar({
          barHash: null,
          falsifier: '',
          mappings: [],
          readiness: {
            state: 'blocked',
            codes: ['bar_snapshot_mapping_missing'],
            mapping: 'missing',
            method: 'missing',
            workContract: 'missing',
          },
        }),
      ],
    });
    const verdict = evaluateAcceptanceBarLifecycle(current, 'pre-start');
    expect(verdict.satisfied).toBe(false);
    expect(verdict.codes).toEqual(
      expect.arrayContaining([
        'bar_snapshot_bar_hash_missing',
        'bar_snapshot_falsifier_missing',
        'bar_snapshot_mapping_missing',
      ]),
    );
    expect(verdict.blockingBars[0]?.barKey).toBe('R-1');
  });

  it('requires METHOD and a structured/manual check before vetting and grading', () => {
    const missing = evaluateAcceptanceBarLifecycle(snapshot(), 'pre-vetting');
    expect(missing.codes).toEqual(
      expect.arrayContaining(['bar_snapshot_method_missing', 'bar_snapshot_check_missing']),
    );

    const ready = evaluateAcceptanceBarLifecycle(
      snapshot({
        grading: {
          authoritativeScorecardId: null,
          gradedBy: null,
          selectedVia: null,
          rubricRevision: null,
          vetting: { state: 'current', scorecardId: 'SC-V', rubricRevision: 1 },
          authorVerdict: { state: 'missing', scorecardId: null, verdict: null },
        },
        bars: [
          bar({
            method: 'Run the manual replication drill.',
            check: { kind: 'instrument', instrumentKey: 'none' },
            readiness: { state: 'ready', codes: [], mapping: 'live', method: 'declared', workContract: 'current' },
          }),
        ],
      }),
      'pre-grading',
    );
    expect(ready.satisfied).toBe(true);
  });

  it('requires current proof, pass grading, vetting, and accepted author verdict at ship', () => {
    const blocked = evaluateAcceptanceBarLifecycle(
      snapshot({
        grading: {
          authoritativeScorecardId: 'SC-1',
          gradedBy: 'su-grader',
          selectedVia: 'floor',
          rubricRevision: 1,
          vetting: { state: 'current', scorecardId: 'SC-V', rubricRevision: 1 },
          authorVerdict: { state: 'accepted', scorecardId: 'SC-A', verdict: 'accept' },
        },
        bars: [bar({ method: 'Run tests.', check: { kind: 'tests', files: ['x.test.ts'] } })],
      }),
      'ship',
    );
    expect(blocked.codes).toEqual(expect.arrayContaining(['bar_snapshot_proof_missing']));

    const green = evaluateAcceptanceBarLifecycle(
      snapshot({
        grading: {
          authoritativeScorecardId: 'SC-1',
          gradedBy: 'su-grader',
          selectedVia: 'floor',
          rubricRevision: 1,
          vetting: { state: 'current', scorecardId: 'SC-V', rubricRevision: 1 },
          authorVerdict: { state: 'accepted', scorecardId: 'SC-A', verdict: 'accept' },
        },
        bars: [
          bar({
            method: 'Run tests.',
            check: { kind: 'tests', files: ['x.test.ts'] },
            requiredTestLayers: ['integration'],
            proof: {
              state: 'current',
              currentEvidence: 1,
              staleEvidence: 0,
              kinds: ['test'],
              evidenceRefs: ['x'],
              adequacy: { state: 'pass', checks: [{ specId: 'spec-1', revision: 1, verdict: 'pass', wouldBlock: [], evidenceRefs: ['x'] }] },
              uncertainEvidence: 0,
              evidencePlanes: [],
            },
            grading: {
              state: 'pass',
              scorecardId: 'SC-1',
              rubricRevision: 1,
              gradedBy: 'su-grader',
              selectedVia: 'floor',
              rating: 'healthy',
              evidence: 'pass',
            },
          }),
        ],
      }),
      'ship',
    );
    expect(green.satisfied).toBe(true);
  });

  it('fails closed on uncertain or wrong-plane evidence, and skips legacy snapshots', () => {
    const uncertain = evaluateAcceptanceBarLifecycle(
      snapshot({
        grading: {
          authoritativeScorecardId: 'SC-1',
          gradedBy: 'su-grader',
          selectedVia: 'floor',
          rubricRevision: 1,
          vetting: { state: 'current', scorecardId: 'SC-V', rubricRevision: 1 },
          authorVerdict: { state: 'accepted', scorecardId: 'SC-A', verdict: 'accept' },
        },
        bars: [
          bar({
            method: 'Run the live drill.',
            check: { kind: 'instrument', instrumentKey: 'live-check' },
            evidencePlane: 'live',
            proof: {
              state: 'current',
              currentEvidence: 1,
              staleEvidence: 0,
              kinds: ['operational'],
              evidenceRefs: ['live'],
              uncertainEvidence: 1,
              evidencePlanes: ['tree'],
            },
            grading: {
              state: 'pass',
              scorecardId: 'SC-1',
              rubricRevision: 1,
              gradedBy: 'su-grader',
              selectedVia: 'floor',
              rating: 'healthy',
              evidence: 'pass',
            },
          }),
        ],
      }),
      'ship',
    );
    expect(uncertain.codes).toEqual(
      expect.arrayContaining(['bar_snapshot_proof_uncertain', 'bar_snapshot_evidence_plane_unmet']),
    );
    expect(evaluateAcceptanceBarContract(snapshot({ applicable: false }), 'ship').satisfied).toBe(true);
  });

  it('keeps the explicit pure-investigation classRef escape hatch for a zero-BAR rubric', () => {
    const investigation = snapshot({
      rubric: {
        rubricId: 'acceptance-investigation',
        revision: 1,
        criteriaHash: 'criteria',
        barSetHash: null,
        contract: snapshot().rubric!.contract,
        createdBy: 'su-author',
        ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
        classRef: 'plan-class-investigation',
      },
      bars: [],
    });
    expect(evaluateAcceptanceBarLifecycle(investigation, 'pre-start').satisfied).toBe(true);
    expect(evaluateAcceptanceBarLifecycle(investigation, 'ship').satisfied).toBe(true);
  });
});
