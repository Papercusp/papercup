import { describe, expect, it } from 'vitest';
import type { SpecClauseRevision } from './spec-clauses-store';
import type { SpecEvidenceForAdequacy } from './spec-test-adequacy';
import { evaluateSpecTestAdequacy, requiredProofFloor } from './spec-test-adequacy';
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
    '%s recipe reproduces the current cohort instead of reviving legacy proof',
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
        current,
        classRef: 'plan-class-feature-ship',
      });
      const recipe =
        surface === 'emitted'
          ? original.scorecardDraft.rerunRecipe
          : asStructuredObservation({ rerunRecipe: original.scorecardDraft.rerunRecipe })?.rerunRecipe;
      expect(recipe).toBeDefined();
      const args = evaluatorArgsSchema.parse(recipe!.args);
      const rerun = evaluateSpecTestAdequacy({
        clause: clause(),
        evidence: reload(args.current),
        current: args.current,
        classRef: args.classRef,
      });
      expect(original.evidenceRefs).toEqual([selected.evidenceRef]);
      expect(rerun.evidenceRefs).toEqual(original.evidenceRefs);
      expect(rerun.ratings).toEqual(original.ratings);
      expect(rerun.verdict).toBe(original.verdict);
      const withoutFingerprints = evaluateSpecTestAdequacy({
        clause: clause(),
        evidence: reload(),
        classRef: args.classRef,
      });
      expect(withoutFingerprints.evidenceRefs).toContain(legacy.evidenceRef);
      expect(withoutFingerprints.verdict).not.toBe(original.verdict);
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
      classRef,
    });
    const recipe = result.scorecardDraft?.rerunRecipe;
    if (!recipe) throw new Error('expected a scorecardDraft with a rerunRecipe');
    return recipe;
  }

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
