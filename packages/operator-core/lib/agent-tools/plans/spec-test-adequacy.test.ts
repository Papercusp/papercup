import { describe, expect, it } from 'vitest';
import { getBuildInfo } from '../../build-info';
import type { SpecClauseRevision } from './spec-clauses-store';
import type { SpecEvidenceForAdequacy } from './spec-test-adequacy';
import {
  ADEQUACY_CRITERIA,
  classifySpecEvidenceLineage,
  evaluateSpecTestAdequacy,
  latestLogicalEvidence,
  requiredProofFloor,
} from './spec-test-adequacy';
import { argsSchema as evaluatorArgsSchema } from './evaluate-spec-test-adequacy';
import { classifySpecEvidenceCurrentness, type EvidenceCurrentInput } from './spec-evidence-store';
import { asStructuredObservation } from '../../harness/improvements/observation-types';

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
    requiredEvidence: ['integration fixture'],
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
    evidenceKind: 'coverage-census',
    evidenceRef: 'surface:reconnect',
    fingerprints: {
      sourceFingerprint: 'git:abc',
      testFingerprint: 'sha256:test',
      fixtureFingerprint: 'sha256:fixture',
      rubricFingerprint: 'sha256:rubric',
      environmentFingerprint: 'node:24',
    },
    coverageEvidenceRef: 42,
    testRunId: 43,
    details: {
      adequacy: {
        fixtureCalibrated: true,
        falsifiable: true,
        testLayer: 'integration',
        pathReachable: true,
        oracleIndependent: true,
        collected: true,
        skipped: false,
        executed: true,
        outcome: 'passed',
        targeted: true,
        coverageRungs: { l3: true, l4: false },
      },
    },
    currentness: {
      // WI-2146375: every dimension here reads 'current', which is only reachable when a
      // comparison input WAS supplied — `unknown` is what you get when nobody asked.
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
    },
    ...over,
  };
}

describe('spec-test-adequacy per-clause evaluator', () => {
  it('grades the newest server-created version even when an older row has a future observedAt', () => {
    const evidenceRef = 'test/reconnect.integration.ts#recorded';
    const older = evidence({
      id: 41,
      evidenceRef,
      observedAt: '2099-08-20T00:00:00.000Z',
      createdAt: '2026-08-20T00:00:00.000Z',
      coverageEvidenceRef: null,
      testRunId: null,
      details: { adequacy: { executed: false, skipped: true, coverageRungs: { l3: false } } },
      currentness: {
        ...evidence().currentness,
        overall: 'unknown',
        provenance: 'not-supplied',
        unknownReasons: ['source-current-fingerprint-not-supplied'],
      },
    });
    const newer = evidence({
      id: 42,
      evidenceRef,
      observedAt: '2020-08-20T00:01:00.000Z',
      createdAt: '2026-08-20T00:01:00.000Z',
    });

    expect(latestLogicalEvidence([older, newer])).toEqual([newer]);
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [older, newer],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.verdict).toBe('pass');
    expect(result.evidenceRefs).toEqual([evidenceRef]);
    expect(result.ratings['execution-integrity'].rating).toBe('pass');
  });

  it('produces a complete scorecards:emit draft for a current L3 feature proof', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence()],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.verdict).toBe('pass');
    expect(result.requiredProofFloor).toBe('l3');
    expect(result.wouldBlock).toEqual([]);
    expect(result.scorecardDraft).toMatchObject({
      rubricRef: 'spec-test-adequacy',
      subject: { kind: 'plan', ref: 'reconnect-plan#SPEC-003-01@1' },
      terminal: true,
      rerunRecipe: {
        schemaVersion: 1,
        evaluator: 'plans:evaluate-spec-test-adequacy',
        selection: {
          planSlug: 'reconnect-plan',
          specId: 'SPEC-003-01',
          specRevision: 1,
          specFingerprint: 'sha256:spec-v1',
          evidence: [{ evidenceKind: 'coverage-census', evidenceRef: 'surface:reconnect' }],
        },
        current: { supplied: false, fingerprints: [] },
        derivation: {
          kind: 'listSpecEvidence.currentness',
          classifier: 'classifySpecEvidenceCurrentness',
          unknownWhenMissing: true,
        },
      },
    });
    expect(Object.keys(result.ratings)).toHaveLength(8);
    expect(result.ratings['correct-layer'].rating).toBe('pass');
    expect(result.ratings['execution-integrity'].rating).toBe('pass');
    for (const [criterion, rating] of Object.entries(result.ratings)) {
      expect(rating.evidence).toContain('surface:reconnect');
      expect(rating.evidence).not.toMatch(
        /^Every bound proof dimension is current\.?$|^Bound proof was collected, not skipped, executed, and produced a successful outcome\.?$/,
      );
    }
    expect(result.ratings.traceability.evidence).toContain('kind=coverage-census');
    expect(result.ratings['execution-integrity'].evidence).toContain('testRunId=43');
    expect(result.ratings['plan-class-risk-floor'].evidence).toContain('coverageRungs=l3:true|l4:false');
  });

  it('puts an exact executable evaluator probe in every rating evidence string', () => {
    const bound = evidence();
    const current: EvidenceCurrentInput[] = [
      {
        evidenceKind: bound.evidenceKind,
        evidenceRef: bound.evidenceRef,
        ...bound.fingerprints,
      },
    ];
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [bound],
      current,
      harness: 'papercusp',
      classRef: 'plan-class-feature-ship',
    });
    const recipe = result.scorecardDraft.rerunRecipe;
    expect(evaluatorArgsSchema.safeParse(recipe.args).success).toBe(true);
    expect(recipe.args.harness).toBe('papercusp');
    expect(recipe.args.current).toEqual([
      {
        evidenceKind: bound.evidenceKind,
        evidenceRef: bound.evidenceRef,
        ...bound.fingerprints,
      },
    ]);
    const args = JSON.stringify(recipe.args);

    for (const criterion of ADEQUACY_CRITERIA) {
      expect(result.ratings[criterion].evidence).toContain(
        `Re-run plans:evaluate-spec-test-adequacy with args=${args}; ` +
          `inspect rows[0].ratings[${JSON.stringify(criterion)}].`,
      );
    }
  });

  it.each([
    ['test-run id', { evidenceRef: '/tmp/session-proof.log', coverageEvidenceRef: null, testRunId: 43 }, 'durable'],
    ['coverage evidence id', { evidenceRef: '/tmp/session-proof.log', coverageEvidenceRef: 42, testRunId: null }, 'durable'],
    ['work-item ref', { evidenceRef: 'WI-10000512', coverageEvidenceRef: null, testRunId: null }, 'durable'],
    ['engineer-issue ref', { evidenceRef: 'EI-22595744337561241', coverageEvidenceRef: null, testRunId: null }, 'durable'],
    ['feature ref', { evidenceRef: 'F-1234', coverageEvidenceRef: null, testRunId: null }, 'durable'],
    ['artifact ref', { evidenceRef: 'artifact:scorecard-42', coverageEvidenceRef: null, testRunId: null }, 'durable'],
    ['test-run ref', { evidenceRef: 'test-run:42', coverageEvidenceRef: null, testRunId: null }, 'durable'],
    ['durable file probe', { evidenceRef: 'test/reconnect.integration.ts#proof', coverageEvidenceRef: null, testRunId: null }, 'durable'],
    ['temporary path', { evidenceRef: '/tmp/pui-counterexample.log', coverageEvidenceRef: null, testRunId: null }, 'ephemeral'],
    ['bash command', { evidenceRef: 'bash -lc "run proof"', coverageEvidenceRef: null, testRunId: null }, 'ephemeral'],
    ['session-local marker', { evidenceRef: 'session-local:proof', coverageEvidenceRef: null, testRunId: null }, 'ephemeral'],
    ['unanchored ref', { evidenceRef: 'surface:reconnect', coverageEvidenceRef: null, testRunId: null }, 'unknown'],
  ] as const)('classifies %s evidence lineage as %s', (_label, over, expected) => {
    expect(classifySpecEvidenceLineage(over).lineage).toBe(expected);
  });

  it('fails traceability and the overall verdict for ephemeral-only proof', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence({ evidenceRef: '/tmp/pui-p001-counterexample-guard.log', coverageEvidenceRef: null, testRunId: null })],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.traceability.rating).toBe('fail');
    expect(result.ratings.traceability.evidence).toContain('Ephemeral-only evidence');
    expect(result.ratings.traceability.evidence).toContain('lineage=ephemeral');
    expect(result.wouldBlock).toContain('traceability');
    expect(result.verdict).toBe('fail');
  });

  it('marks an otherwise complete but unanchored proof unknown', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence({ evidenceRef: 'surface:reconnect', coverageEvidenceRef: null, testRunId: null })],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.traceability.rating).toBe('unknown');
    expect(result.ratings.traceability.evidence).toContain('no durable rerun anchor');
    expect(result.wouldBlock).toContain('traceability');
    expect(result.verdict).toBe('unknown');
  });

  it('does not pass execution-integrity from author-attested booleans without a ledger reference', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [
        evidence({
          evidenceRef: 'packages/operator-core/lib/reconnect.integration.test.ts#targeted-counterexamples',
          coverageEvidenceRef: null,
          testRunId: null,
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['execution-integrity'].rating).toBe('unknown');
    expect(result.ratings['execution-integrity'].evidence).toContain(
      'no testRunId or coverageEvidenceRef in the execution ledger',
    );
    expect(result.ratings['execution-integrity'].evidence).toContain('executed=true');
    expect(result.verdict).toBe('unknown');
  });

  it('does not let a ledger-backed sibling hide an unbacked executable binding', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [
        evidence({ evidenceRef: 'test/reconnect.integration.ts#recorded', coverageEvidenceRef: 42, testRunId: null }),
        evidence({
          evidenceRef: 'test/reconnect.integration.ts#attested-only',
          coverageEvidenceRef: null,
          testRunId: null,
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['execution-integrity'].rating).toBe('unknown');
    expect(result.ratings['execution-integrity'].evidence).toContain('attested-only');
    expect(result.verdict).toBe('unknown');
  });

  it('surfaces a provisional scorecard proof base in every criterion evidence string', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [
        evidence({
          provisionalProofBase: true,
          provisionalScorecard: {
            issueId: 'EI-123',
            stampedAt: '2026-08-20T17:09:00.000Z',
            violatableKeys: ['criterion-a'],
          },
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.verdict).toBe('pass');
    for (const criterion of ADEQUACY_CRITERIA) {
      expect(result.ratings[criterion].evidence).toContain('provisionalProofBase=true');
      expect(result.ratings[criterion].evidence).toContain('EI-123');
    }
  });

  it('emits a submittable get-spec-evidence probe when the required layer is missing', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [
        evidence({
          details: {
            adequacy: {
              testLayer: 'unit',
              pathReachable: true,
            },
          },
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });
    const correctLayerEvidence = result.ratings['correct-layer'].evidence;

    expect(correctLayerEvidence).toContain(
      'Probe plans:get-spec-evidence with args={"slug":"reconnect-plan","specIds":["SPEC-003-01"]}.',
    );
    expect(correctLayerEvidence).not.toMatch(/\b(planSlug|specId|specRevision|specFingerprint)=/);
  });

  it('requires targeted L4 for high-risk, bugfix, migration, and mutation-required clauses', () => {
    expect(requiredProofFloor(clause({ behaviorClass: 'authorization' }), 'plan-class-feature-ship')).toBe('l4');
    expect(requiredProofFloor(clause(), 'plan-class-bugfix')).toBe('l4');
    expect(requiredProofFloor(clause(), 'plan-class-migration')).toBe('l4');
    expect(requiredProofFloor(clause({ mutationRequired: true }), 'plan-class-feature-ship')).toBe('l4');

    const result = evaluateSpecTestAdequacy({
      clause: clause({ behaviorClass: 'concurrency' }),
      evidence: [evidence()],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.verdict).toBe('fail');
    expect(result.ratings['plan-class-risk-floor']).toMatchObject({ rating: 'fail' });
    expect(result.wouldBlock).toContain('plan-class-risk-floor');
  });

  it('accepts exact targeted mutation proof and only a justified current approved L4 waiver', () => {
    const highRisk = clause({ behaviorClass: 'concurrency' });
    const mutation = evidence({
      evidenceKind: 'mutation',
      evidenceRef: 'mutant:drop-dedupe',
      details: {
        adequacy: {
          falsifiable: true,
          oracleIndependent: true,
          collected: true,
          skipped: false,
          executed: true,
          outcome: 'killed',
          targeted: true,
        },
      },
    });
    const proved = evaluateSpecTestAdequacy({
      clause: highRisk,
      evidence: [evidence(), mutation],
      classRef: 'plan-class-feature-ship',
    });
    expect(proved.ratings['plan-class-risk-floor'].rating).toBe('pass');

    const waived = evaluateSpecTestAdequacy({
      clause: clause({
        behaviorClass: 'concurrency',
        exemption: {
          testAdequacyWaivers: {
            l4: {
              justification: 'The external transport cannot be mutated in this environment.',
              approvalRef: 'D-099',
              expiresAt: '2026-09-01T00:00:00.000Z',
            },
          },
        },
      }),
      evidence: [evidence()],
      classRef: 'plan-class-feature-ship',
      now: new Date('2026-08-20T00:00:00.000Z'),
    });
    expect(waived.ratings['plan-class-risk-floor']).toMatchObject({ rating: 'waived' });
    expect(waived.verdict).toBe('pass');

    const expired = evaluateSpecTestAdequacy({
      clause: clause({
        behaviorClass: 'concurrency',
        exemption: {
          testAdequacyWaivers: {
            l4: {
              justification: 'The external transport cannot be mutated in this environment.',
              approvalRef: 'D-099',
              expiresAt: '2026-08-19T00:00:00.000Z',
            },
          },
        },
      }),
      evidence: [evidence()],
      classRef: 'plan-class-feature-ship',
      now: new Date('2026-08-20T00:00:00.000Z'),
    });
    expect(expired.ratings['plan-class-risk-floor'].rating).toBe('fail');
  });

  it('accepts stronger targeted L4 counterexample proof for an L3 floor', () => {
    const counterexample = evidence({
      evidenceKind: 'counterexample',
      evidenceRef: 'counterexample:reject-future-window',
      details: {
        adequacy: {
          fixtureCalibrated: true,
          falsifiable: true,
          testLayer: 'integration',
          pathReachable: true,
          oracleIndependent: true,
          collected: true,
          skipped: false,
          executed: true,
          outcome: 'pass',
          targeted: true,
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [counterexample],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.requiredProofFloor).toBe('l3');
    expect(result.ratings['plan-class-risk-floor']).toMatchObject({ rating: 'pass' });
    expect(result.ratings['plan-class-risk-floor'].evidence).toContain(
      'counterexample:reject-future-window',
    );
    expect(result.verdict).toBe('pass');
  });

  it('fails stale proof and reports unknown metadata without converting it to pass', () => {
    const stale = evidence({
      currentness: {
        ...evidence().currentness,
        overall: 'stale',
        staleReasons: ['source-stale'],
      },
    });
    const staleResult = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [stale],
      classRef: 'plan-class-feature-ship',
    });
    expect(staleResult.ratings.freshness.rating).toBe('fail');
    expect(staleResult.verdict).toBe('fail');

    const unknownFreshness = evidence({
      evidenceRef: 'surface:unknown-history',
      currentness: {
        ...evidence().currentness,
        overall: 'unknown',
        dimensions: {
          ...evidence().currentness.dimensions,
          source: 'unknown',
        },
        unknownReasons: ['source_fingerprint_absent'],
      },
    });
    const unknownFreshnessResult = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [unknownFreshness],
      classRef: 'plan-class-feature-ship',
    });
    expect(unknownFreshnessResult.ratings.freshness).toMatchObject({
      rating: 'unknown',
      evidence: expect.stringContaining('source_fingerprint_absent'),
    });
    expect(unknownFreshnessResult.evidenceRefs).toEqual(['surface:unknown-history']);
    expect(unknownFreshnessResult.verdict).toBe('unknown');

    const incomplete = evidence({ details: { adequacy: { coverageRungs: { l3: true } } } });
    const unknown = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [incomplete],
      classRef: 'plan-class-feature-ship',
    });
    expect(unknown.ratings['execution-integrity'].rating).toBe('unknown');
    expect(unknown.ratings['oracle-independence'].rating).toBe('unknown');
    expect(unknown.verdict).toBe('fail');
  });

  it('does not rate caller-attested fingerprint equality as fresh', () => {
    const attested = evidence({
      currentness: classifySpecEvidenceCurrentness(
        {
          spec_is_current: true,
          source_fingerprint: 'git:abc',
          test_fingerprint: 'sha256:test',
          fixture_fingerprint: 'sha256:fixture',
          rubric_fingerprint: 'sha256:rubric',
          environment_fingerprint: 'node:24',
          coverage_evidence_ref: 42,
          coverage_evidence_present: true,
          test_run_id: 43,
          test_run_present: true,
        },
        {
          evidenceKind: 'coverage-census',
          evidenceRef: 'surface:reconnect',
          sourceFingerprint: 'git:abc',
          testFingerprint: 'sha256:test',
          fixtureFingerprint: 'sha256:fixture',
          rubricFingerprint: 'sha256:rubric',
          environmentFingerprint: 'node:24',
        },
      ),
    });
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [attested],
      current: [
        {
          evidenceKind: attested.evidenceKind,
          evidenceRef: attested.evidenceRef,
          ...attested.fingerprints,
        },
      ],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.freshness).toMatchObject({ rating: 'unknown' });
    expect(result.ratings.freshness.evidence).toContain('attested-current');
    expect(result.verdict).toBe('unknown');
  });

  it('grades only the exact current cohort when historical stale or unknown bindings coexist', () => {
    const staleHistorical = evidence({
      evidenceRef: 'surface:historical-stale',
      currentness: {
        ...evidence().currentness,
        overall: 'stale',
        dimensions: {
          ...evidence().currentness.dimensions,
          source: 'stale',
        },
        staleReasons: ['source_fingerprint_mismatch'],
      },
      details: {
        adequacy: {
          fixtureCalibrated: false,
          falsifiable: false,
          testLayer: 'integration',
          pathReachable: false,
          oracleIndependent: false,
          collected: false,
          skipped: true,
          executed: false,
          outcome: 'failed',
          coverageRungs: { l3: false },
        },
      },
    });
    const unknownHistorical = evidence({
      evidenceRef: 'surface:historical-unknown',
      currentness: {
        ...evidence().currentness,
        overall: 'unknown',
        dimensions: {
          ...evidence().currentness.dimensions,
          test: 'unknown',
        },
        unknownReasons: ['test_fingerprint_absent'],
      },
    });
    const current = evidence({ evidenceRef: 'surface:current' });

    const passing = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [staleHistorical, unknownHistorical, current],
      classRef: 'plan-class-feature-ship',
    });
    expect(passing.verdict).toBe('pass');
    expect(passing.ratings.freshness.rating).toBe('pass');
    expect(passing.evidenceRefs).toEqual(['surface:current']);

    const incompleteCurrent = evidence({
      evidenceRef: 'surface:current-incomplete',
      details: { adequacy: { coverageRungs: { l3: true } } },
    });
    const notSatisfiedByHistory = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [staleHistorical, incompleteCurrent],
      classRef: 'plan-class-feature-ship',
    });
    expect(notSatisfiedByHistory.evidenceRefs).toEqual(['surface:current-incomplete']);
    expect(notSatisfiedByHistory.ratings['execution-integrity'].rating).toBe('unknown');
    expect(notSatisfiedByHistory.ratings['oracle-independence'].rating).toBe('unknown');
    expect(notSatisfiedByHistory.verdict).not.toBe('pass');
  });

  it('keeps omitted bindings in the graded population when current fingerprints are partial', () => {
    const selected = evidence({ evidenceRef: 'surface:selected' });
    const omitted = evidence({ evidenceRef: 'surface:omitted' });
    const current: EvidenceCurrentInput[] = [
      {
        evidenceKind: selected.evidenceKind,
        evidenceRef: selected.evidenceRef,
        ...selected.fingerprints,
      },
    ];
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [selected, omitted].map((row) => ({
        ...row,
        currentness: classifySpecEvidenceCurrentness(
          {
            spec_is_current: true,
            source_fingerprint: row.fingerprints.sourceFingerprint,
            test_fingerprint: row.fingerprints.testFingerprint,
            fixture_fingerprint: row.fingerprints.fixtureFingerprint,
            rubric_fingerprint: row.fingerprints.rubricFingerprint,
            environment_fingerprint: row.fingerprints.environmentFingerprint,
            coverage_evidence_ref: row.coverageEvidenceRef,
            coverage_evidence_present: true,
            test_run_id: row.testRunId,
            test_run_present: true,
          },
          current.find(
            (input) => input.evidenceKind === row.evidenceKind && input.evidenceRef === row.evidenceRef,
          ),
        ),
      })),
      current,
      classRef: 'plan-class-feature-ship',
    });

    expect(result.evidenceRefs).toEqual(['surface:omitted', 'surface:selected']);
    expect(result.ratings.freshness.rating).toBe('unknown');
    expect(result.ratings.freshness.evidence).toContain('surface:omitted');
    expect(result.verdict).toBe('unknown');
  });

  it('never lets evidence for another revision establish traceability', () => {
    const historical = evidence({ specRevision: 0 });
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [historical],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings.traceability.rating).toBe('fail');
    expect(result.evidenceRefs).toEqual([]);
  });

  it('treats malformed untyped binding details as unknown instead of throwing or passing', () => {
    const malformed = evidence({
      details: {
        adequacy: {
          outcome: 42,
          collected: 'yes',
          skipped: 0,
          coverageRungs: { l3: 'true' },
        },
      },
    });
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [malformed],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings['execution-integrity'].rating).toBe('unknown');
    expect(result.ratings['plan-class-risk-floor'].rating).toBe('unknown');
    expect(result.verdict).not.toBe('pass');
  });
});

describe('rerunRecipe is submittable to its own evaluator', () => {
  it.each(['emitted', 'persisted'] as const)(
    '%s recipe preserves the full evidence population when current fingerprints are partial',
    (surface) => {
      const selected = evidence({ evidenceRef: 'surface:replacement' });
      const legacy = evidence({ evidenceRef: 'surface:rejected-legacy' });
      const current: EvidenceCurrentInput[] = [
        {
          evidenceKind: selected.evidenceKind,
          evidenceRef: selected.evidenceRef,
          ...selected.fingerprints,
        },
      ];
      // Re-run the store's real classifier, as a fresh tool call does. Reusing the
      // already-classified fixture would conceal a recipe that omitted `current`.
      const reload = (inputs?: EvidenceCurrentInput[]) =>
        [selected, legacy].map((row) => ({
          ...row,
          currentness: classifySpecEvidenceCurrentness(
            {
              spec_is_current: true,
              source_fingerprint: row.fingerprints.sourceFingerprint,
              test_fingerprint: row.fingerprints.testFingerprint,
              fixture_fingerprint: row.fingerprints.fixtureFingerprint,
              rubric_fingerprint: row.fingerprints.rubricFingerprint,
              environment_fingerprint: row.fingerprints.environmentFingerprint,
              coverage_evidence_ref: row.coverageEvidenceRef,
              coverage_evidence_present: true,
              test_run_id: row.testRunId,
              test_run_present: true,
            },
            inputs?.find((input) => input.evidenceKind === row.evidenceKind && input.evidenceRef === row.evidenceRef),
          ),
        }));
      const original = evaluateSpecTestAdequacy({
        clause: clause(),
        evidence: reload(current),
        harness: 'papercusp',
        current,
        classRef: 'plan-class-feature-ship',
      });
      const recipe =
        surface === 'emitted'
          ? original.scorecardDraft.rerunRecipe
          : asStructuredObservation({ rerunRecipe: original.scorecardDraft.rerunRecipe })?.rerunRecipe;
      expect(recipe).toBeDefined();
      const args = evaluatorArgsSchema.parse(recipe!.args);
      expect(args.harness).toBe('papercusp');
      const rerunCurrent = Array.isArray(args.current)
        ? args.current
        : args.current?.supplied
          ? args.current.fingerprints
          : undefined;
      const rerun = evaluateSpecTestAdequacy({
        clause: clause(),
        evidence: reload(rerunCurrent),
        harness: args.harness,
        current: rerunCurrent,
        classRef: args.classRef,
      });
      expect(original.evidenceRefs).toEqual([legacy.evidenceRef, selected.evidenceRef]);
      expect(rerun.evidenceRefs).toEqual(original.evidenceRefs);
      expect(rerun.ratings).toEqual(original.ratings);
      expect(rerun.verdict).toBe(original.verdict);
      const withoutFingerprints = evaluateSpecTestAdequacy({
        clause: clause(),
        evidence: reload(),
        classRef: args.classRef,
      });
      expect(withoutFingerprints.evidenceRefs).toContain(legacy.evidenceRef);
      // Both paths retain the full exact population: the caller-supplied fingerprint
      // is attested-current for one binding, while the omitted binding is unknown.
      // The important distinction is that the missing binding remains visible rather
      // than allowing a partial input to manufacture a passing subset.
      expect(withoutFingerprints.verdict).toBe('unknown');
      expect(withoutFingerprints.ratings.freshness.evidence).toContain('current[] was omitted');
      expect(withoutFingerprints.ratings.freshness.evidence).toContain('not evidence that stored bindings are stale');
      expect(withoutFingerprints.ratings.freshness.evidence).toContain('rerunRecipe.current.fingerprints');
    },
  );

  it('preserves an explicitly empty currentness input through emission and readback', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [],
      current: [],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.scorecardDraft.rerunRecipe.args).toHaveProperty('current', []);
    expect(
      asStructuredObservation({ rerunRecipe: result.scorecardDraft.rerunRecipe })?.rerunRecipe?.args,
    ).toHaveProperty('current', []);
    const omitted = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [],
      classRef: 'plan-class-feature-ship',
    });
    expect(omitted.scorecardDraft.rerunRecipe.args).not.toHaveProperty('current');
    expect(
      asStructuredObservation({ rerunRecipe: omitted.scorecardDraft.rerunRecipe })?.rerunRecipe?.args,
    ).not.toHaveProperty('current');
  });

  function recipeFor(classRef: 'plan-class-feature-ship' | 'plan-class-bugfix' = 'plan-class-feature-ship') {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence()],
      harness: 'papercusp',
      classRef,
    });
    const recipe = result.scorecardDraft?.rerunRecipe;
    if (!recipe) throw new Error('expected a scorecardDraft with a rerunRecipe');
    return recipe;
  }

  it('stamps each generated recipe with the loaded evaluator build identity', () => {
    expect(recipeFor().evaluatorBuild).toEqual(getBuildInfo());
  });

  it("records args that PARSE against the evaluator's own schema, classRef included", () => {
    const recipe = recipeFor();
    expect(recipe.evaluator).toBe('plans:evaluate-spec-test-adequacy');

    // Validated against the evaluator's REAL exported schema, not a copy of its field
    // names — a guard that restated the names would pass through the exact drift it
    // exists to catch.
    const parsed = evaluatorArgsSchema.safeParse(recipe.args);
    expect(parsed.success).toBe(true);

    expect(recipe.args.slug).toBe('reconnect-plan');
    expect(recipe.args.specIds).toEqual(['SPEC-003-01']);
    expect(recipe.args.includeDraft).toBe(true);
  });

  it('carries the classRef the verdicts were produced under, so no re-runner has to guess', () => {
    // classRef is a four-value enum that moves plan-class-risk-floor, so a recipe that
    // omitted it let a wrong guess silently change the verdict being reproduced.
    expect(recipeFor('plan-class-feature-ship').classRef).toBe('plan-class-feature-ship');
    expect(recipeFor('plan-class-bugfix').classRef).toBe('plan-class-bugfix');
    expect(recipeFor('plan-class-bugfix').args.classRef).toBe('plan-class-bugfix');
  });

  it('CALIBRATION: the legacy selection shape is REJECTED by that same schema', () => {
    // Without this control the test above could pass against a schema that accepts
    // anything. `selection` is the shape the recipe used to publish as its only
    // payload; submitting it is what produced `invalid_args` in the field.
    const recipe = recipeFor();
    const legacy = evaluatorArgsSchema.safeParse(recipe.selection);
    expect(legacy.success).toBe(false);

    // And specifically because classRef is missing — the field a re-runner had to guess.
    const withoutClassRef = { slug: 'reconnect-plan', specIds: ['SPEC-003-01'] };
    expect(evaluatorArgsSchema.safeParse(withoutClassRef).success).toBe(false);
  });
});
