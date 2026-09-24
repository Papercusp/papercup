import { describe, expect, it } from 'vitest';
import { getBuildInfo } from '../../build-info';
import type { SpecClauseRevision } from './spec-clauses-store';
import type { SpecEvidenceForAdequacy } from './spec-test-adequacy';
import {
  ADEQUACY_CRITERIA,
  activeSpecEvidence,
  classifySpecEvidenceLineage,
  crossGenerationAuditProbeArgs,
  evaluateSpecTestAdequacy,
  isNonCodeWorkItemKind,
  latestLogicalEvidence,
  requiredProofFloor,
} from './spec-test-adequacy';
import { argsSchema as evaluatorArgsSchema } from './evaluate-spec-test-adequacy';
import { classifySpecEvidenceCurrentness, type EvidenceCurrentInput } from './spec-evidence-store';
import { asStructuredObservation } from '../../harness/improvements/observation-types';
import { resolveLocalRubric } from '../../cupboard/rubric-store';

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

function negativeEvidence(over: Partial<SpecEvidenceForAdequacy> = {}): SpecEvidenceForAdequacy {
  const base = evidence();
  return {
    ...base,
    evidenceKind: 'counterexample',
    evidenceRef: 'counterexample:reconnect',
    details: {
      adequacy: {
        ...((base.details.adequacy ?? {}) as Record<string, unknown>),
        outcome: 'pass',
      },
    },
    ...over,
  };
}

const RECONNECT_FALSIFIER_SCENARIO = 'reconnect-failure';

function caseScopedClause(over: Partial<SpecClauseRevision> = {}): SpecClauseRevision {
  return clause({
    ...over,
    falsifier: {
      observation: 'The reconnect promise is violated.',
      requiredScenarios: [RECONNECT_FALSIFIER_SCENARIO],
    },
  });
}

function caseScopedNegativeEvidence(over: Partial<SpecEvidenceForAdequacy> = {}): SpecEvidenceForAdequacy {
  const base = negativeEvidence(over);
  return {
    ...base,
    details: {
      ...base.details,
      adequacy: {
        ...(base.details.adequacy as Record<string, unknown>),
        targeted: RECONNECT_FALSIFIER_SCENARIO,
        scenarioIds: [RECONNECT_FALSIFIER_SCENARIO],
      },
    },
  };
}

function attempt(
  n: number,
  patch: {
    outcome?: string;
    sources?: string[];
    layer?: string;
    plane?: string;
    scenarios?: string[];
    pair?: string;
    filter?: string;
    phase?: string;
  } = {},
): SpecEvidenceForAdequacy[] {
  const binding = {
    specId: clause().specId,
    specRevision: 1,
    testPath: 'test/reconnect.test.ts',
    sourcePaths: patch.sources ?? ['src/reconnect.ts'],
    testLayer: patch.layer ?? 'integration',
    ...(patch.scenarios ? { scenarioIds: patch.scenarios } : {}),
    ...(patch.pair ? { causalPairId: patch.pair } : {}),
  };
  const base = evidence({
    evidenceKind: 'test',
    evidenceRef: `test-run-group:attempt-${n}:0`,
    coverageEvidenceRef: null,
    testRunId: null,
  });
  const adequacy = {
    ...(base.details.adequacy as object),
    testLayer: binding.testLayer,
    ...(patch.scenarios ? { scenarioIds: patch.scenarios } : {}),
    ...(patch.pair ? { causalPairIds: [patch.pair] } : {}),
  };
  const details = {
    currentMeasurement: {
      schemaVersion: 1,
      kind: 'repo-files',
      sourcePaths: binding.sourcePaths,
      testPaths: [binding.testPath],
    },
    testExecution: { schemaVersion: 1, phase: 'pending', originRunId: `attempt-${n}`, runId: `attempt-${n}`, binding },
    adequacy: { ...adequacy, outcome: 'pending', collected: false, executed: false },
  };
  const pending = { ...base, id: n * 10, createdAt: `2026-09-09T00:${String(n).padStart(2, '0')}:00Z`, details };
  return [
    pending,
    {
      ...pending,
      id: n * 10 + 1,
      testRunId: n,
      details: {
        ...details,
        ...(patch.plane ? { evidencePlane: patch.plane } : {}),
        testExecution: {
          ...details.testExecution,
          phase: patch.phase ?? 'settled',
          ...(patch.filter ? { testNamePattern: patch.filter } : {}),
        },
        adequacy: { ...adequacy, outcome: patch.outcome ?? 'pass', collected: true, executed: true },
      },
    },
  ];
}

describe('active registered test attempts (EI-22773954051523742)', () => {
  it('retires an older unknown attempt after a wider-source rerun, without changing history', () => {
    const old = attempt(1, { outcome: 'unknown' });
    const fresh = attempt(2, { sources: ['src/reconnect.ts', 'src/reporter.ts'] });
    const rows = [...old, ...fresh];
    const unchanged = JSON.stringify(rows);
    expect(latestLogicalEvidence(rows)).toEqual([old[1], fresh[1]]);
    expect(activeSpecEvidence(rows)).toEqual([fresh[1]]);
    expect(JSON.stringify(rows)).toBe(unchanged);
    expect(
      evaluateSpecTestAdequacy({
        clause: caseScopedClause(),
        evidence: [...rows, caseScopedNegativeEvidence()],
        classRef: 'plan-class-feature-ship',
      }).verdict,
    ).toBe('pass');
  });

  it.each(['failed', 'unknown', 'pending'])('never selects a past pass over a newer %s', (outcome) => {
    const old = attempt(1);
    const fresh = attempt(2, { outcome });
    if (outcome === 'pending') fresh.pop();
    const rows = [...old, ...fresh];
    expect(activeSpecEvidence(rows)).toEqual([fresh.at(-1)]);
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [...rows, negativeEvidence()],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.wouldBlock).toContain('execution-integrity');
  });

  it.each(['unknown', 'stale'] as const)('does not hide %s freshness behind another current passing proof', (state) => {
    const fresh = attempt(2);
    fresh[1]!.currentness = {
      ...fresh[1]!.currentness,
      overall: state,
      provenance: 'not-supplied',
      unknownReasons: state === 'unknown' ? ['server-measurement-unavailable'] : [],
      staleReasons: state === 'stale' ? ['source-fingerprint-changed'] : [],
    };
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [...attempt(1), ...fresh, negativeEvidence()],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.evidenceRefs).toContain(fresh[1]!.evidenceRef);
    expect(result.wouldBlock).toContain('freshness');
  });

  it.each([
    { sources: ['src/other.ts'] },
    { sources: ['src/one.ts'] },
    { layer: 'unit' },
    { plane: 'live' },
    { scenarios: ['scenario-a'] },
    { pair: 'cause-a' },
    { filter: 'one selected test' },
  ])('keeps distinct obligations or narrower measured scope: %j', (patch) => {
    const old = attempt(1, { sources: ['src/reconnect.ts', 'src/one.ts'], outcome: 'failed' });
    const fresh = attempt(2, patch);
    expect(activeSpecEvidence([...old, ...fresh])).toEqual([old[1], fresh[1]]);
    expect(
      evaluateSpecTestAdequacy({
        clause: clause(),
        evidence: [...old, ...fresh, negativeEvidence()],
        classRef: 'plan-class-feature-ship',
      }).wouldBlock,
    ).toContain('execution-integrity');
  });

  it('cannot reverse attempt order by annotating or future-dating old evidence', () => {
    const old = attempt(1);
    const fresh = attempt(2, { outcome: 'failed' });
    const late = { ...old[1]!, id: 99, createdAt: '2099-01-01T00:00:00Z', observedAt: '2099-01-01T00:00:00Z' };
    expect(activeSpecEvidence([...old, ...fresh, late])).toEqual([fresh[1]]);
  });

  it('allows matching reviewed planes but does not borrow an older different plane', () => {
    const old = attempt(1, { plane: 'live' });
    const fresh = attempt(2, { plane: 'tree' });
    expect(activeSpecEvidence([...old, ...fresh])).toEqual([old[1], fresh[1]]);
    const matching = attempt(3, { plane: 'tree' });
    expect(activeSpecEvidence([...fresh, ...matching])).toEqual([matching[1]]);
  });

  it('fails closed without original registration and for altered registered obligations', () => {
    const old = attempt(1, { outcome: 'failed' });
    const fresh = attempt(2);
    expect(activeSpecEvidence([old[1]!, ...fresh])).toEqual([old[1], fresh[1]]);
    const altered = {
      ...fresh[1]!,
      details: {
        ...fresh[1]!.details,
        adequacy: { ...(fresh[1]!.details.adequacy as object), scenarioIds: ['unregistered'] },
      },
    };
    expect(activeSpecEvidence([...old, fresh[0]!, altered])).toEqual([old[1], altered]);
  });

  it('keeps changed root, fixture, counterexample and separate work-item proof distinct', () => {
    const old = attempt(1, { outcome: 'failed' });
    for (const mutate of [
      (row: SpecEvidenceForAdequacy) => {
        row.workItemId = 'WI-102';
      },
      (row: SpecEvidenceForAdequacy) => {
        row.evidenceKind = 'counterexample';
      },
      (row: SpecEvidenceForAdequacy) => {
        row.fingerprints = { ...row.fingerprints, fixtureFingerprint: 'different' };
      },
      (row: SpecEvidenceForAdequacy) => {
        row.details.currentMeasurement = {
          ...(row.details.currentMeasurement as object),
          rootHarnessSlug: 'another-root',
        };
      },
    ]) {
      const fresh = structuredClone(attempt(2));
      fresh.forEach(mutate);
      expect(activeSpecEvidence([...old, ...fresh])).toEqual([old[1], fresh[1]]);
    }
  });

  it('does not classify stale manual negative-control history as a registered attempt from copied metadata', () => {
    const rows = attempt(2);
    const historical = {
      ...rows[1]!,
      evidenceKind: 'counterexample' as const,
      evidenceRef: 'manual-negative-controls:old',
      currentness: { ...rows[1]!.currentness, overall: 'stale' as const, staleReasons: ['source-stale'] },
    };
    const result = evaluateSpecTestAdequacy({
      clause: caseScopedClause(),
      evidence: [...rows, historical, caseScopedNegativeEvidence()],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.verdict).toBe('pass');
    expect(result.evidenceRefs).not.toContain(historical.evidenceRef);
    expect(historical.currentness.overall).toBe('stale');
  });
});

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
      clause: caseScopedClause(),
      evidence: [older, newer, caseScopedNegativeEvidence()],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.verdict).toBe('pass');
    expect(result.evidenceRefs).toEqual([evidenceRef, 'counterexample:reconnect'].sort());
    expect(result.ratings['execution-integrity'].rating).toBe('pass');
  });

  it('lets a ledger-backed re-bind filed under a DIFFERENT work item supersede an unbacked row', () => {
    // Regression: the logical key once included workItemId, so a corrected
    // re-bind of the SAME proof by a different binder landed BESIDE the stale
    // row instead of superseding it. The table is append-only by design, so the
    // stale row was unreachable and dragged execution-integrity to 'unknown'
    // forever via the any-drags unbackedExecution rule.
    const evidenceRef = 'test-run:18136690:R-2-integration-leg@2d6cd439b6';
    const stale = evidence({
      id: 51,
      workItemId: 'WI-1980934',
      evidenceRef,
      createdAt: '2026-09-16T10:18:56.016Z',
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
    const rebound = evidence({
      id: 52,
      workItemId: 'WI-10001789',
      evidenceRef,
      createdAt: '2026-09-18T02:36:09.882Z',
    });

    expect(latestLogicalEvidence([stale, rebound])).toEqual([rebound]);
    const result = evaluateSpecTestAdequacy({
      clause: caseScopedClause(),
      evidence: [stale, rebound, caseScopedNegativeEvidence()],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings['execution-integrity'].rating).toBe('pass');
    expect(result.verdict).toBe('pass');
  });

  it('produces a complete scorecards:emit draft for a current L3 feature proof', () => {
    const result = evaluateSpecTestAdequacy({
      clause: caseScopedClause(),
      evidence: [evidence(), caseScopedNegativeEvidence()],
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
          evidence: expect.arrayContaining([
            { evidenceKind: 'coverage-census', evidenceRef: 'surface:reconnect' },
            { evidenceKind: 'counterexample', evidenceRef: 'counterexample:reconnect' },
          ]),
        },
        current: { supplied: false, fingerprints: [] },
        derivation: {
          kind: 'listSpecEvidence.currentness',
          classifier: 'classifySpecEvidenceCurrentness',
          unknownWhenMissing: true,
        },
      },
    });
    // 9 since P-002 added `disclosed-gap`. Deliberately a literal, not
    // ADEQUACY_CRITERIA.length — a derived count cannot catch an unintended criterion.
    expect(Object.keys(result.ratings)).toHaveLength(9);
    expect(result.ratings['correct-layer'].rating).toBe('pass');
    expect(result.ratings['execution-integrity'].rating).toBe('pass');
    for (const [criterion, rating] of Object.entries(result.ratings)) {
      expect(rating.evidence).toMatch(/surface:reconnect|counterexample:reconnect/);
      expect(rating.evidence).not.toMatch(
        /^Every bound proof dimension is current\.?$|^Bound proof was collected, not skipped, executed, and produced a successful outcome\.?$/,
      );
    }
    expect(result.ratings.traceability.evidence).toContain('kind=coverage-census');
    expect(result.ratings['execution-integrity'].evidence).toContain('testRunId=43');
    expect(result.ratings['plan-class-risk-floor'].evidence).toContain('coverageRungs=l3:true|l4:false');
  });

  it('does not treat a binder falsifiability attestation as a demonstrated negative control', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence()],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.falsifiability).toMatchObject({
      rating: 'unknown',
      suggestion: expect.stringContaining('successful ledger-backed mutation or counterexample'),
    });
    expect(result.ratings.falsifiability.evidence).toContain('Binder-attested falsifiable=true');
    expect(result.ratings.falsifiability.evidence).toContain('no mutation or counterexample binding is bound');
    expect(result.wouldBlock).toContain('falsifiability');
    expect(result.verdict).toBe('unknown');
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
    const args = JSON.stringify(crossGenerationAuditProbeArgs(recipe));

    for (const criterion of ADEQUACY_CRITERIA) {
      expect(result.ratings[criterion].evidence).toContain(
        `Re-run plans:evaluate-spec-test-adequacy with args=${args}; ` +
          `inspect rows[0].ratings[${JSON.stringify(criterion)}].`,
      );
    }
  });

  it.each([
    ['test-run id', { evidenceRef: '/tmp/session-proof.log', coverageEvidenceRef: null, testRunId: 43 }, 'durable'],
    [
      'coverage evidence id',
      { evidenceRef: '/tmp/session-proof.log', coverageEvidenceRef: 42, testRunId: null },
      'durable',
    ],
    ['work-item ref', { evidenceRef: 'WI-10000512', coverageEvidenceRef: null, testRunId: null }, 'durable'],
    [
      'engineer-issue ref',
      { evidenceRef: 'EI-22595744337561241', coverageEvidenceRef: null, testRunId: null },
      'durable',
    ],
    ['feature ref', { evidenceRef: 'F-1234', coverageEvidenceRef: null, testRunId: null }, 'durable'],
    ['artifact ref', { evidenceRef: 'artifact:scorecard-42', coverageEvidenceRef: null, testRunId: null }, 'durable'],
    ['test-run ref', { evidenceRef: 'test-run:42', coverageEvidenceRef: null, testRunId: null }, 'durable'],
    [
      'durable file probe',
      { evidenceRef: 'test/reconnect.integration.ts#proof', coverageEvidenceRef: null, testRunId: null },
      'durable',
    ],
    [
      'temporary path',
      { evidenceRef: '/tmp/pui-counterexample.log', coverageEvidenceRef: null, testRunId: null },
      'ephemeral',
    ],
    ['bash command', { evidenceRef: 'bash -lc "run proof"', coverageEvidenceRef: null, testRunId: null }, 'ephemeral'],
    [
      'session-local marker',
      { evidenceRef: 'session-local:proof', coverageEvidenceRef: null, testRunId: null },
      'ephemeral',
    ],
    ['unanchored ref', { evidenceRef: 'surface:reconnect', coverageEvidenceRef: null, testRunId: null }, 'unknown'],
  ] as const)('classifies %s evidence lineage as %s', (_label, over, expected) => {
    expect(classifySpecEvidenceLineage(over).lineage).toBe(expected);
  });

  it('fails traceability and the overall verdict for ephemeral-only proof', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [
        evidence({ evidenceRef: '/tmp/pui-p001-counterexample-guard.log', coverageEvidenceRef: null, testRunId: null }),
      ],
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
      clause: caseScopedClause(),
      evidence: [
        evidence({
          provisionalProofBase: true,
          provisionalScorecard: {
            issueId: 'EI-123',
            stampedAt: '2026-08-20T17:09:00.000Z',
            violatableKeys: ['criterion-a'],
          },
        }),
        caseScopedNegativeEvidence({
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

  it('emits a submittable get-specs probe for the declared required layer when evidence is missing', () => {
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
      harness: 'papercusp',
      classRef: 'plan-class-feature-ship',
    });
    const correctLayerEvidence = result.ratings['correct-layer'].evidence;

    expect(correctLayerEvidence).toContain(
      'Probe plans:get-specs with args={"harness":"papercusp","slug":"reconnect-plan","specIds":["SPEC-003-01"]}; inspect specs[0].requiredTestLayers.',
    );
    expect(correctLayerEvidence).toContain('expected ["integration"]');
    expect(correctLayerEvidence).not.toContain('Probe plans:get-spec-evidence');
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

  it('does not assign an executable proof floor to the canonical non-code task kind', () => {
    const nonCodeClause = clause({
      behaviorClass: 'lifecycle',
      requiredTestLayers: ['integration'],
      mutationRequired: true,
    });

    expect(isNonCodeWorkItemKind(' TASK ')).toBe(true);
    expect(requiredProofFloor(nonCodeClause, 'plan-class-bugfix', 'task')).toBe('none');
    expect(requiredProofFloor(nonCodeClause, 'plan-class-bugfix', 'change')).toBe('l4');

    const result = evaluateSpecTestAdequacy({
      clause: nonCodeClause,
      evidence: [],
      classRef: 'plan-class-bugfix',
      workItemKind: 'task',
    });
    expect(result.requiredProofFloor).toBe('none');
    expect(result.ratings['plan-class-risk-floor'].rating).toBe('not-applicable');
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
    expect(waived.ratings.falsifiability.rating).toBe('unknown');
    expect(waived.verdict).toBe('unknown');

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

  it('counts a mutation probe only when it targets a declared clause scenario', () => {
    const mutation = evidence({
      evidenceKind: 'mutation',
      evidenceRef: 'mutation-probe:drop-dedupe:caught',
      details: {
        adequacy: {
          falsifiable: true,
          oracleIndependent: true,
          collected: true,
          skipped: false,
          executed: true,
          outcome: 'caught',
          targeted: 'promotion-readable',
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: clause({
        behaviorClass: 'concurrency',
        falsifier: {
          observation: 'The promoted directive cannot be read from the open standing state.',
          requiredScenarios: ['promotion-readable', 'refused-transition-preserved'],
        },
      }),
      evidence: [evidence(), mutation],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['plan-class-risk-floor'].rating).toBe('pass');
    expect(result.ratings.falsifiability.rating).toBe('pass');
    expect(result.ratings['execution-integrity'].rating).toBe('pass');
  });

  it('does not credit a sibling-case mutation failure to this clause', () => {
    const mutation = evidence({
      evidenceKind: 'mutation',
      evidenceRef: 'mutation-probe:refused-transition:caught',
      details: {
        adequacy: {
          falsifiable: true,
          oracleIndependent: true,
          collected: true,
          skipped: false,
          executed: true,
          outcome: 'caught',
          targeted: 'refused-transition-preserved',
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: clause({
        behaviorClass: 'concurrency',
        falsifier: {
          observation: 'The promoted directive cannot be read from the open standing state.',
          requiredScenarios: ['promotion-readable'],
        },
      }),
      evidence: [evidence(), mutation],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.falsifiability.rating).toBe('unknown');
    expect(result.ratings.falsifiability.evidence).toContain('do not name a scenario declared in falsifier.requiredScenarios');
    expect(result.verdict).not.toBe('pass');
  });

  it('does not treat legacy boolean targeted=true as a clause-case link', () => {
    const mutation = evidence({
      evidenceKind: 'mutation',
      evidenceRef: 'mutation-probe:unscoped:caught',
      details: {
        adequacy: {
          falsifiable: true,
          oracleIndependent: true,
          collected: true,
          skipped: false,
          executed: true,
          outcome: 'caught',
          targeted: true,
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: clause({
        behaviorClass: 'concurrency',
        falsifier: {
          observation: 'The promoted directive cannot be read from the open standing state.',
          requiredScenarios: ['promotion-readable'],
        },
      }),
      evidence: [evidence(), mutation],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.falsifiability.rating).toBe('unknown');
  });

  // WI-10002724: a clause declaring NO falsifier.requiredScenarios has no scenario id to name, so
  // a target naming its own specId (lower-cased) is its clause-scoped claim.
  describe('clause without declared falsifier scenarios', () => {
    const mutationTargeting = (targeted: boolean | string) =>
      evidence({
        evidenceKind: 'mutation',
        evidenceRef: `mutation-probe:self-target:${String(targeted)}`,
        details: {
          adequacy: {
            falsifiable: true,
            oracleIndependent: true,
            collected: true,
            skipped: false,
            executed: true,
            outcome: 'caught',
            targeted,
          },
        },
      });

    it('passes a mutation binding that targets the clause\'s own specId', () => {
      const result = evaluateSpecTestAdequacy({
        clause: clause(),
        evidence: [evidence(), mutationTargeting('spec-003-01')],
        classRef: 'plan-class-feature-ship',
      });

      expect(clause().falsifier).toBeNull();
      expect(result.ratings.falsifiability.rating).toBe('pass');
      expect(result.ratings.falsifiability.evidence).toContain('which declares no falsifier scenarios');
    });

    it('does not credit a mutation binding that targets a sibling spec', () => {
      const result = evaluateSpecTestAdequacy({
        clause: clause(),
        evidence: [evidence(), mutationTargeting('spec-003-02')],
        classRef: 'plan-class-feature-ship',
      });

      expect(result.ratings.falsifiability.rating).toBe('unknown');
      expect(result.ratings.falsifiability.evidence).toContain("do not target this clause's own specId");
      expect(result.ratings.falsifiability.suggestion).toContain("adequacy.targeted = 'spec-003-01'");
    });

    it('does not treat boolean targeted=true as the clause-scoped target', () => {
      const result = evaluateSpecTestAdequacy({
        clause: clause(),
        evidence: [evidence(), mutationTargeting(true)],
        classRef: 'plan-class-feature-ship',
      });

      expect(result.ratings.falsifiability.rating).toBe('unknown');
    });

    it('does not let a self-target bypass declared falsifier scenarios', () => {
      const result = evaluateSpecTestAdequacy({
        clause: clause({
          falsifier: {
            observation: 'The promoted directive cannot be read from the open standing state.',
            requiredScenarios: ['promotion-readable'],
          },
        }),
        evidence: [evidence(), mutationTargeting('spec-003-01')],
        classRef: 'plan-class-feature-ship',
      });

      expect(result.ratings.falsifiability.rating).toBe('unknown');
      expect(result.ratings.falsifiability.evidence).toContain('do not name a scenario declared in falsifier.requiredScenarios');
    });
  });

  it('accepts stronger targeted L4 counterexample proof for an L3 floor', () => {
    const scenarioId = 'reject-future-window';
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
          targeted: scenarioId,
          scenarioIds: [scenarioId],
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: clause({
        falsifier: {
          observation: 'A future event window is rejected.',
          requiredScenarios: [scenarioId],
        },
      }),
      evidence: [counterexample],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.requiredProofFloor).toBe('l3');
    expect(result.ratings['plan-class-risk-floor']).toMatchObject({ rating: 'pass' });
    expect(result.ratings['plan-class-risk-floor'].evidence).toContain('counterexample:reject-future-window');
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

  it('explains partially server-measured opaque dimensions without calling them missing', () => {
    const row = evidence({
      currentness: {
        ...evidence().currentness,
        overall: 'unknown',
        provenance: 'partially-server-measured',
        comparisonSupplied: true,
        unknownReasons: ['current-fingerprints-partially-attested-not-independently-measured:environment'],
      },
    });
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [row],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.freshness).toMatchObject({ rating: 'unknown' });
    expect(result.ratings.freshness.evidence).toContain(
      'Repository fingerprints were server-measured, but applicable non-repository dimensions were only caller-attested',
    );
    expect(result.ratings.freshness.evidence).not.toContain('Current fingerprints are missing');
  });

  // RECURRENCE GUARD (WI-10002320). A replayed tuple that MATCHED its stored values is
  // capped at 'unknown' precisely BECAUSE it matched — so the one thing the message must
  // never say is that fingerprints are missing. Without its own arm the chain fell through
  // to 'Current fingerprints are missing', which states the opposite of what happened and
  // sends the reader hunting for absent evidence that was never absent.
  //
  // Calibration: the sibling test above feeds a row differing ONLY in provenance
  // ('partially-server-measured') and asserts ITS distinct message, so a regression that
  // collapses these arms into one fails whichever arm it swallowed — neither assertion can
  // pass vacuously while the other still holds.
  it('explains a matched replayed snapshot without calling its fingerprints missing', () => {
    const row = evidence({
      currentness: {
        ...evidence().currentness,
        overall: 'unknown',
        provenance: 'replayed-snapshot',
        comparisonSupplied: true,
        unknownReasons: ['current-fingerprints-replayed-not-independently-measured'],
      },
    });
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [row],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.freshness).toMatchObject({ rating: 'unknown' });
    expect(result.ratings.freshness.evidence).toContain('nothing is missing and nothing is stale');
    expect(result.ratings.freshness.evidence).not.toContain('Current fingerprints are missing');
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
    const current = caseScopedNegativeEvidence({ evidenceRef: 'surface:current' });

    const passing = evaluateSpecTestAdequacy({
      clause: caseScopedClause(),
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
          current.find((input) => input.evidenceKind === row.evidenceKind && input.evidenceRef === row.evidenceRef),
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

  it('leaves fixture calibration not-applicable for a tree-only spec despite an explicit flag on non-fixture evidence', () => {
    const row = evidence({
      evidenceKind: 'counterexample',
      evidenceRef: 'counterexample:tree-only-spec',
      fingerprints: {
        ...evidence().fingerprints,
        fixtureFingerprint: null,
      },
      details: {
        adequacy: {
          ...((evidence().details.adequacy ?? {}) as Record<string, unknown>),
          fixtureCalibrated: true,
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: clause({
        behaviorClass: 'observability',
        requiredEvidence: ['tree'],
        requiredTestLayers: ['integration', 'unit'],
      }),
      evidence: [row],
      classRef: 'plan-class-bugfix',
    });

    expect(result.ratings['fixture-calibration'].rating).toBe('not-applicable');
    expect(result.ratings['fixture-calibration'].evidence).toContain('No fixture binding or fixture fingerprint is present');
    expect(result.ratings['fixture-calibration'].evidence).toContain('fixtureCalibrated=true');
  });

  it('does not report exact fixture or mutation bindings as spec-scoped absence when current grading narrows the cohort', () => {
    const currentTest = evidence({
      evidenceKind: 'test',
      evidenceRef: 'packages/operator-core/lib/interview-prep.test.ts#current',
      fingerprints: {
        ...evidence().fingerprints,
        fixtureFingerprint: null,
      },
      details: {
        adequacy: {
          ...((evidence().details.adequacy ?? {}) as Record<string, unknown>),
          fixtureCalibrated: undefined,
          falsifiable: true,
        },
      },
    });
    const unknownFixture = evidence({
      evidenceKind: 'fixture',
      evidenceRef: 'packages/operator-core/lib/interview-prep-evidence/servicenow-staff-ml-manual-review.json',
      currentness: {
        ...evidence().currentness,
        overall: 'unknown',
        provenance: 'not-supplied',
        comparisonSupplied: false,
        unknownReasons: ['fixture-current-fingerprint-not-supplied'],
      },
      details: {
        adequacy: {
          ...((evidence().details.adequacy ?? {}) as Record<string, unknown>),
          fixtureCalibrated: true,
        },
      },
    });
    const unknownMutation = evidence({
      evidenceKind: 'mutation',
      evidenceRef: 'mutation-probe:reinsert-superseded-requisition:2026-09-08',
      currentness: {
        ...evidence().currentness,
        overall: 'unknown',
        provenance: 'not-supplied',
        comparisonSupplied: false,
        unknownReasons: ['source-current-fingerprint-not-supplied'],
      },
      details: {
        adequacy: {
          ...((evidence().details.adequacy ?? {}) as Record<string, unknown>),
          outcome: 'killed',
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: clause({ requiredEvidence: ['integration test'] }),
      evidence: [currentTest, unknownFixture, unknownMutation],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.evidenceRefs).toEqual([currentTest.evidenceRef]);
    expect(result.ratings['fixture-calibration'].rating).toBe('unknown');
    expect(result.ratings['fixture-calibration'].evidence).toContain('2 exact fixture binding(s) are outside');
    expect(result.ratings.falsifiability.evidence).not.toContain('no mutation or counterexample binding is bound');
    expect(result.ratings.falsifiability.evidence).toContain('1 mutation or counterexample binding(s) exist');
    // EI-23756870948948211: pin WHICH branch this case exercises. `unknownMutation` carries
    // provenance:'not-supplied', so it is excluded from the grading cohort while still satisfying
    // isSuccessfulExecutableEvidence — this is the genuinely-outside-the-cohort case, and the
    // cohort explanation is TRUE here. Its sibling test below covers the in-cohort case, where
    // that same sentence would be false. Keeping both pinned is what stops the two causes being
    // collapsed back into one untested assertion.
    expect(result.ratings.falsifiability.evidence).toContain('outside the current grading cohort');
  });

  it('names the unmet executable-evidence conjunct instead of asserting an untested cohort cause', () => {
    // EI-23756870948948211: a mutation binding authored the normal way sets evidenceKind + a
    // ledger ref + outcome and OMITS adequacy.collected/skipped/executed. It sits INSIDE the
    // grading cohort and fails isSuccessfulExecutableEvidence on those three booleans — but the
    // refusal used to blame "outside the current grading cohort", a cause it never tested and
    // which is impossible here. That misdirection cost ~15 respawns across three agents.
    const incompleteMutation = evidence({
      evidenceKind: 'mutation',
      evidenceRef: 'mutation-probe:unset-adequacy-booleans',
      details: {
        adequacy: {
          fixtureCalibrated: true,
          falsifiable: true,
          testLayer: 'integration',
          pathReachable: true,
          oracleIndependent: true,
          outcome: 'killed',
          targeted: true,
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: clause({ requiredEvidence: ['integration test'] }),
      evidence: [incompleteMutation],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings.falsifiability.rating).toBe('unknown');
    // The row IS in the cohort, so the cohort-narrowing explanation would be a false statement.
    expect(result.ratings.falsifiability.evidence).not.toContain('outside the current grading cohort');
    expect(result.ratings.falsifiability.evidence).toContain('in the current grading cohort');
    // The actionable half: name the conjuncts that were actually unmet, and distinguish an unset
    // boolean from an explicit false, because the two are fixed by different edits.
    expect(result.ratings.falsifiability.evidence).toContain('collected=unset');
    expect(result.ratings.falsifiability.evidence).toContain('skipped=unset');
    expect(result.ratings.falsifiability.evidence).toContain('executed=unset');
    expect(result.ratings.falsifiability.suggestion).toContain('collected=unset');
  });

  // WI-10002082 (RETRACTED fix — this guard is what replaced it). A branch reporting "your binding
  // was stranded by the read projection" was added here and removed: it is unreachable, because
  // supersession preserves `evidenceKind` on BOTH routes (`latestLogicalEvidence` keys on it, and
  // attempt-supersession matches `scope.key`, whose `registrationKey` carries it). A dropped
  // mutation row therefore always leaves a same-kind survivor for the two REAL causes to report,
  // so the bare-absence fall-through is true whenever it prints. Make supersession kind-agnostic
  // and this test fails — at which point that fall-through becomes a false absence and the removed
  // branch has to come back.
  it('projection supersession cannot strand a mutation binding', () => {
    const mutationAttempt = attempt(1).map((row) => ({ ...row, evidenceKind: 'mutation' as const }));

    // Cross-kind: a newer wider-source TEST rerun does NOT retire a mutation attempt.
    const testRerun = attempt(2, { sources: ['src/reconnect.ts', 'src/reporter.ts'] });
    expect(activeSpecEvidence([...mutationAttempt, ...testRerun])).toContain(mutationAttempt[1]!);

    // Same-kind: supersession DOES apply — and the survivor is itself a mutation row, so the
    // dropped binding is never the only mutation binding in the clause population.
    const newerMutation = attempt(2, { sources: ['src/reconnect.ts', 'src/reporter.ts'] }).map(
      (row) => ({ ...row, evidenceKind: 'mutation' as const }),
    );
    const sameKind = activeSpecEvidence([...mutationAttempt, ...newerMutation]);
    expect(sameKind).not.toContain(mutationAttempt[1]!);
    expect(sameKind.some((row) => row.evidenceKind === 'mutation')).toBe(true);

    // Corollary: the refusal never reports a bare absence while a selector-matching mutation
    // binding exists in the table.
    const result = evaluateSpecTestAdequacy({
      clause: clause({ requiredEvidence: ['integration test'] }),
      evidence: [...mutationAttempt, ...newerMutation],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings.falsifiability.evidence).not.toContain(
      'no mutation or counterexample binding is bound',
    );
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

  it('fails correct-layer until every canonical acceptance scenario has successful ledger-backed path proof', () => {
    const scenarioClause = clause({
      falsifier: {
        observation: 'Stale or wrong-subject context wins.',
        requiredScenarios: ['stale-vs-decision', 'wrong-subject-exclusion'],
      },
    });
    const baseAdequacy = evidence().details.adequacy as Record<string, unknown>;
    const staleDecision = evidence({
      evidenceRef: 'packages/operator-core/lib/history.test.ts#stale-vs-decision',
      details: { adequacy: { ...baseAdequacy, scenarioIds: ['stale-vs-decision'] } },
    });
    const incomplete = evaluateSpecTestAdequacy({
      clause: scenarioClause,
      evidence: [staleDecision],
      classRef: 'plan-class-feature-ship',
    });
    expect(incomplete.ratings['correct-layer'].rating).toBe('fail');
    expect(incomplete.ratings['correct-layer'].evidence).toContain('wrong-subject-exclusion');

    const wrongSubject = evidence({
      evidenceRef: 'packages/operator-core/lib/history.test.ts#wrong-subject-exclusion',
      details: { adequacy: { ...baseAdequacy, scenarioIds: ['wrong-subject-exclusion'] } },
    });
    const complete = evaluateSpecTestAdequacy({
      clause: scenarioClause,
      evidence: [staleDecision, wrongSubject],
      classRef: 'plan-class-feature-ship',
    });
    expect(complete.ratings['correct-layer'].rating).toBe('pass');
    expect(complete.ratings['correct-layer'].evidence).toContain('Every canonical acceptance scenario');
  });

  it('does not count unexecuted or unbacked scenario tags as scenario coverage', () => {
    const baseAdequacy = evidence().details.adequacy as Record<string, unknown>;
    const scenarioClause = clause({
      falsifier: { observation: 'The scenario is missed.', requiredScenarios: ['goal-auto-start'] },
    });
    const unbacked = evidence({
      evidenceRef: 'packages/operator-core/lib/history.test.ts#goal-auto-start',
      testRunId: null,
      coverageEvidenceRef: null,
      details: { adequacy: { ...baseAdequacy, scenarioIds: ['goal-auto-start'] } },
    });
    const result = evaluateSpecTestAdequacy({
      clause: scenarioClause,
      evidence: [unbacked],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings['correct-layer'].rating).toBe('fail');
    expect(result.ratings['execution-integrity'].rating).toBe('unknown');
  });

  it('requires exactly one successful negative and repaired recurrence binding per causal pair id', () => {
    const pairClause = clause({
      falsifier: {
        observation: 'The original failure recurs.',
        causalPairing: 'one-to-one',
      },
    });
    const baseAdequacy = evidence().details.adequacy as Record<string, unknown>;
    const negative = evidence({
      evidenceKind: 'counterexample',
      evidenceRef: 'packages/operator-core/lib/history.test.ts#before-missing-goal-history',
      details: {
        adequacy: {
          ...baseAdequacy,
          outcome: 'killed',
          causalPairIds: ['missing-goal-history'],
        },
      },
    });
    const withoutRecurrence = evaluateSpecTestAdequacy({
      clause: pairClause,
      evidence: [negative],
      classRef: 'plan-class-feature-ship',
    });
    expect(withoutRecurrence.ratings['execution-integrity'].rating).toBe('fail');
    expect(withoutRecurrence.ratings['execution-integrity'].evidence).toContain(
      'missing-goal-history:expected 1 recurrence binding, found 0',
    );

    const recurrence = evidence({
      evidenceKind: 'test',
      evidenceRef: 'packages/operator-core/lib/history.test.ts#after-missing-goal-history',
      details: {
        adequacy: {
          ...baseAdequacy,
          outcome: 'passed',
          causalPairIds: ['missing-goal-history'],
        },
      },
    });
    const complete = evaluateSpecTestAdequacy({
      clause: pairClause,
      evidence: [negative, recurrence],
      classRef: 'plan-class-feature-ship',
    });
    expect(complete.ratings['execution-integrity'].rating).toBe('pass');
    expect(complete.ratings['execution-integrity'].evidence).toContain('Every original failure has exactly one');
  });

  it('rejects a collapsed causal pair even when one row claims every required scenario', () => {
    const pairClause = clause({
      falsifier: {
        observation: 'Either original failure recurs.',
        requiredScenarios: ['missing-history', 'missing-recovery'],
        causalPairing: 'one-to-one',
      },
    });
    const baseAdequacy = evidence().details.adequacy as Record<string, unknown>;
    const negative = evidence({
      evidenceKind: 'counterexample',
      evidenceRef: 'packages/operator-core/lib/history.test.ts#before-missing-history',
      details: {
        adequacy: {
          ...baseAdequacy,
          outcome: 'killed',
          causalPairIds: ['missing-history'],
        },
      },
    });
    const collapsedRecurrence = evidence({
      evidenceKind: 'test',
      evidenceRef: 'packages/operator-core/lib/history.test.ts#after-collapsed-pair',
      details: {
        adequacy: {
          ...baseAdequacy,
          scenarioIds: ['missing-history', 'missing-recovery'],
          causalPairIds: ['missing-history'],
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: pairClause,
      evidence: [negative, collapsedRecurrence],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['correct-layer'].rating).toBe('pass');
    expect(result.ratings['execution-integrity'].rating).toBe('fail');
    expect(result.ratings['execution-integrity'].evidence).toContain(
      'canonical causalPairId(s) missing: missing-recovery',
    );
  });

  it('rejects a killed outcome on the repaired recurrence side of a causal pair', () => {
    const pairClause = clause({
      falsifier: { observation: 'The original failure recurs.', causalPairing: 'one-to-one' },
    });
    const baseAdequacy = evidence().details.adequacy as Record<string, unknown>;
    const negative = evidence({
      evidenceKind: 'counterexample',
      evidenceRef: 'packages/operator-core/lib/history.test.ts#before-missing-goal-history',
      details: {
        adequacy: {
          ...baseAdequacy,
          outcome: 'killed',
          causalPairIds: ['missing-goal-history'],
        },
      },
    });
    const killedRecurrence = evidence({
      evidenceKind: 'test',
      evidenceRef: 'packages/operator-core/lib/history.test.ts#after-missing-goal-history',
      details: {
        adequacy: {
          ...baseAdequacy,
          outcome: 'killed',
          causalPairIds: ['missing-goal-history'],
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: pairClause,
      evidence: [negative, killedRecurrence],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['execution-integrity'].rating).toBe('fail');
    expect(result.ratings['execution-integrity'].evidence).toContain(
      'missing-goal-history:recurrence binding is not successful ledger-backed repaired proof',
    );
  });

  it('rejects a multi-pair row and orphan recurrence under a one-to-one contract', () => {
    const pairClause = clause({
      falsifier: { observation: 'Either original failure recurs.', causalPairing: 'one-to-one' },
    });
    const baseAdequacy = evidence().details.adequacy as Record<string, unknown>;
    const negative = evidence({
      evidenceKind: 'counterexample',
      evidenceRef: 'packages/operator-core/lib/history.test.ts#combined-before',
      details: {
        adequacy: {
          ...baseAdequacy,
          outcome: 'killed',
          causalPairIds: ['missing-history', 'missing-recovery'],
        },
      },
    });
    const orphan = evidence({
      evidenceKind: 'test',
      evidenceRef: 'packages/operator-core/lib/history.test.ts#orphan-after',
      details: {
        adequacy: {
          ...baseAdequacy,
          causalPairIds: ['unrelated-repair'],
        },
      },
    });
    const result = evaluateSpecTestAdequacy({
      clause: pairClause,
      evidence: [negative, orphan],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings['execution-integrity'].rating).toBe('fail');
    expect(result.ratings['execution-integrity'].evidence).toContain('expected exactly one causalPairId');
    expect(result.ratings['execution-integrity'].evidence).toContain(
      'unrelated-repair:expected 1 negative binding, found 0',
    );
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
      expect(args.evidenceRefs).toEqual([legacy.evidenceRef, selected.evidenceRef].sort());
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
    const recipe = recipeFor();
    expect(recipe.evaluatorBuild).toEqual(getBuildInfo());
    expect(recipe.args.evaluatorBuild).toEqual(getBuildInfo());
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
    expect(recipe.args.evidenceRefs).toEqual(['surface:reconnect']);
    expect(recipe.args).toMatchObject({
      specRevision: 1,
      specFingerprint: 'sha256:spec-v1',
      replaySnapshot: true,
      limit: 25,
    });
    expect(recipe.args.includeDraft).toBe(true);
  });

  it('keeps each inline grading-audit probe on the exact immutable evidence selection', () => {
    const current: EvidenceCurrentInput[] = [
      {
        planSlug: 'reconnect-plan',
        specId: 'SPEC-003-01',
        specRevision: 1,
        specFingerprint: 'sha256:spec-v1',
        evidenceKind: 'coverage-census',
        evidenceRef: 'surface:reconnect',
        ...evidence().fingerprints,
      },
    ];
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence()],
      harness: 'papercusp',
      current,
      classRef: 'plan-class-bugfix',
      rerunSelection: { workItemIds: ['WI-101'] },
    });
    const inline = result.ratings.traceability.evidence.match(
      /Re-run plans:evaluate-spec-test-adequacy with args=(\{.*\}); inspect rows\[0\]\.ratings\[/,
    )?.[1];
    expect(inline).toBeDefined();
    const args = JSON.parse(inline!) as Record<string, unknown>;
    const recipe = result.scorecardDraft.rerunRecipe;

    expect(evaluatorArgsSchema.safeParse(args).success).toBe(true);
    expect(args).toEqual(crossGenerationAuditProbeArgs(recipe));
    expect(args).toEqual(recipe.args);
    expect(args).toMatchObject({
      harness: 'papercusp',
      slug: 'reconnect-plan',
      classRef: 'plan-class-bugfix',
      specIds: ['SPEC-003-01'],
      workItemIds: ['WI-101'],
      evaluatorBuild: getBuildInfo(),
      evidenceRefs: ['surface:reconnect'],
      current,
      specRevision: 1,
      specFingerprint: 'sha256:spec-v1',
      replaySnapshot: true,
      includeDraft: true,
      limit: 25,
    });
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

describe('disclosed-gap criterion (P-002: a disclosure cannot coexist with a machine PASS)', () => {
  it('rates not-applicable and stays out of wouldBlock when no binding discloses a gap', () => {
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [evidence()],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['disclosed-gap'].rating).toBe('not-applicable');
    expect(result.ratings['disclosed-gap'].evidence).toContain('No bound proof');
    expect(result.wouldBlock).not.toContain('disclosed-gap');
  });

  it('fails the clause and names the gap text when the disclosure is nested under adequacy', () => {
    const base = evidence();
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [
        evidence({
          details: {
            adequacy: {
              ...(base.details.adequacy as Record<string, unknown>),
              disclosedGap: 'reconnect path is only covered for the single-subscriber case',
            },
          },
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['disclosed-gap'].rating).toBe('fail');
    expect(result.ratings['disclosed-gap'].evidence).toContain(
      'reconnect path is only covered for the single-subscriber case',
    );
    expect(result.wouldBlock).toContain('disclosed-gap');
    expect(result.verdict).toBe('fail');
  });

  it('fails on a TOP-LEVEL disclosure too, which the binder accepts without error', () => {
    // plans:bind-spec-evidence takes a free-form `details` object, so `details.disclosedGap`
    // is written with no complaint. Reading only the nested spelling would silently drop
    // exactly the disclosure this criterion exists to catch.
    const base = evidence();
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [
        evidence({
          details: { ...base.details, disclosedGap: ['fixture pins a stubbed clock'] },
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['disclosed-gap'].rating).toBe('fail');
    expect(result.ratings['disclosed-gap'].evidence).toContain('fixture pins a stubbed clock');
    expect(result.wouldBlock).toContain('disclosed-gap');
  });

  it('does not treat a blank or whitespace-only disclosure as a disclosure', () => {
    const base = evidence();
    const result = evaluateSpecTestAdequacy({
      clause: clause(),
      evidence: [
        evidence({
          details: {
            adequacy: { ...(base.details.adequacy as Record<string, unknown>), disclosedGap: ['   ', ''] },
          },
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['disclosed-gap'].rating).toBe('not-applicable');
    expect(result.wouldBlock).not.toContain('disclosed-gap');
  });
});

// EI-23793489732627099 — the non-code exemption used to reach ONLY plan-class-risk-floor.
//
// How this survived is worth recording, because the guard that should have caught it
// existed and passed: 'does not assign an executable proof floor to the canonical
// non-code task kind' asserts `requiredProofFloor === 'none'` and the single
// plan-class-risk-floor rating, then stops. That is exactly the half that WORKED. The
// promise a reader takes from its name — that non-code work is not blocked by executable
// proof — was never asserted, and the verdict it implies was 'unknown' the whole time.
// So these tests assert the END-TO-END verdict, which is the thing that was actually
// broken and the only assertion that could have failed.
describe('non-code clauses can reach an all-pass verdict (EI-23793489732627099)', () => {
  /** The most complete binding NON-CODE work can honestly produce: no ledger run, no coverage row. */
  function operationalEvidence(over: Partial<SpecEvidenceForAdequacy> = {}): SpecEvidenceForAdequacy {
    return evidence({
      evidenceKind: 'operational',
      evidenceRef: 'work-item:WI-10002010',
      coverageEvidenceRef: null,
      testRunId: null,
      fingerprints: {
        sourceFingerprint: 'git:abc',
        testFingerprint: null,
        fixtureFingerprint: null,
        rubricFingerprint: null,
        environmentFingerprint: null,
      },
      details: {
        adequacy: {
          fixtureCalibrated: true,
          falsifiable: true,
          pathReachable: true,
          oracleIndependent: true,
          collected: true,
          skipped: false,
          executed: true,
          outcome: 'passed',
          targeted: true,
        },
      },
      ...over,
    });
  }

  /** A clause describing non-code work: no required test layer, not automatable. */
  const nonCodeClause = clause({
    behavior: 'Every deferred filing reaches a recorded disposition.',
    behaviorClass: 'non-automated',
    requiredTestLayers: [],
    requiredEvidence: ['recorded disposition'],
  });

  it('reaches verdict pass with honest operational evidence and nothing ledger-backed', () => {
    const result = evaluateSpecTestAdequacy({
      clause: nonCodeClause,
      evidence: [operationalEvidence()],
      classRef: 'plan-class-bugfix',
      workItemKind: 'task',
    });

    expect(result.requiredProofFloor).toBe('none');
    // The assertion the original guard was missing.
    expect(result.verdict).toBe('pass');
    expect(result.wouldBlock).toEqual([]);
    expect(result.ratings.falsifiability.rating).toBe('not-applicable');
    expect(result.ratings['execution-integrity'].rating).toBe('not-applicable');
    // The exemption must SAY it applied, so a reader is never left guessing why a
    // criterion that normally demands a ledger row came back clean.
    expect(result.ratings.falsifiability.evidence).toContain("requiredProofFloor='none'");
  });

  // The safety boundary, and the reason this is scoped to 'unknown' alone. 'unknown'
  // means the criterion could not be ESTABLISHED, which for non-code work is structural.
  // 'fail' means bound evidence positively reports something bad — that is real
  // information about real evidence, and no exemption may grade it away.
  it('still blocks when bound evidence positively reports failure, exemption or not', () => {
    const contradicted = operationalEvidence({
      details: {
        adequacy: {
          fixtureCalibrated: true,
          falsifiable: false,
          pathReachable: true,
          oracleIndependent: true,
          collected: true,
          skipped: false,
          executed: true,
          outcome: 'passed',
          targeted: true,
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: nonCodeClause,
      evidence: [contradicted],
      classRef: 'plan-class-bugfix',
      workItemKind: 'task',
    });

    expect(result.requiredProofFloor).toBe('none');
    expect(result.ratings.falsifiability.rating).toBe('fail');
    expect(result.wouldBlock).toContain('falsifiability');
    expect(result.verdict).toBe('fail');
  });

  it('still blocks a stale binding, which is a fail rather than an unestablished unknown', () => {
    const stale = operationalEvidence({
      currentness: {
        comparisonSupplied: true,
        provenance: 'server-measured',
        overall: 'stale',
        dimensions: {
          spec: 'current',
          source: 'stale',
          test: 'current',
          fixture: 'current',
          rubric: 'current',
          environment: 'current',
          coverageEvidence: 'current',
          testRun: 'current',
        },
        staleReasons: ['source moved since observation'],
        unknownReasons: [],
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: nonCodeClause,
      evidence: [stale],
      classRef: 'plan-class-bugfix',
      workItemKind: 'task',
    });

    expect(result.requiredProofFloor).toBe('none');
    expect(result.ratings.freshness.rating).toBe('fail');
    expect(result.wouldBlock).toContain('freshness');
  });

  // NEGATIVE CONTROL. Without this, every assertion above is satisfiable by an
  // evaluator that simply stopped grading executable proof for everyone — which would
  // be a far worse bug than the one being fixed, and would look identical from the
  // passing tests alone.
  it('does NOT exempt code work: an executable floor still demands ledger-backed proof', () => {
    const codeClause = clause({ behaviorClass: 'happy-path', requiredTestLayers: ['integration'] });

    const result = evaluateSpecTestAdequacy({
      clause: codeClause,
      evidence: [operationalEvidence()],
      classRef: 'plan-class-feature-ship',
      workItemKind: 'change',
    });

    expect(result.requiredProofFloor).not.toBe('none');
    expect(result.ratings['execution-integrity'].rating).not.toBe('not-applicable');
    expect(result.verdict).not.toBe('pass');
  });

  // EI-23958122348412546 — the SAME exemption, one level deeper, and the case every test
  // above structurally COULD NOT reach. All of them bind `operational`, which IS an
  // EXECUTABLE_EVIDENCE_KIND, so `executable.length` was always >= 1 and execution-integrity
  // always rated 'unknown' — the one rating the exemption was scoped to. Declared honestly as
  // `manual`, non-code evidence yields ZERO executable rows, execution-integrity rated a bare
  // 'fail', and the exemption skipped it. The clause blocked plan ship with no reachable
  // repair: verbatim the failure EI-23793489732627099 above says it fixed.
  //
  // This is why the fix is `absenceOnly` rather than "also downgrade 'fail'": the rating alone
  // cannot distinguish "no executable artifact exists, by nature" from "the artifact exists and
  // reports something bad", and only the first is exemptible.
  /** What non-code work produces when it declares its kind HONESTLY: zero executable rows. */
  function manualEvidence(over: Partial<SpecEvidenceForAdequacy> = {}): SpecEvidenceForAdequacy {
    return operationalEvidence({ evidenceKind: 'manual', ...over });
  }

  it('reaches verdict pass with honest MANUAL evidence, which binds zero executable rows', () => {
    const result = evaluateSpecTestAdequacy({
      clause: nonCodeClause,
      evidence: [manualEvidence()],
      classRef: 'plan-class-bugfix',
      workItemKind: 'task',
    });

    expect(result.requiredProofFloor).toBe('none');
    expect(result.verdict).toBe('pass');
    expect(result.wouldBlock).toEqual([]);
    expect(result.ratings['execution-integrity'].rating).toBe('not-applicable');
    // The exemption must SAY it downgraded a fail, and say which kind of fail — otherwise a
    // reader cannot tell this clean result from one that graded adverse evidence away.
    expect(result.ratings['execution-integrity'].evidence).toContain('absence of executable proof');
  });

  // THE INVERTED INCENTIVE, asserted directly rather than implied. Before the fix the WEAKER
  // binding passed and the HONEST one failed: `operational` with author-attested booleans and
  // no ledger anchor rated 'unknown' and was exempted, while `manual` rated 'fail' and was not.
  // An author was rewarded for overstating the kind of evidence they held. Asserting the two
  // together is what makes that asymmetry a test failure rather than a judgement call.
  it('does not rank honest manual evidence BELOW a weaker unanchored executable row', () => {
    const args = { clause: nonCodeClause, classRef: 'plan-class-bugfix', workItemKind: 'task' } as const;
    const honest = evaluateSpecTestAdequacy({ ...args, evidence: [manualEvidence()] });
    const overstated = evaluateSpecTestAdequacy({ ...args, evidence: [operationalEvidence()] });

    expect(overstated.verdict).toBe('pass');
    expect(honest.verdict).toBe('pass');
    expect(honest.wouldBlock).toEqual(overstated.wouldBlock);
  });

  // SAFETY BOUNDARY for the WIDENED exemption. The block above proved a 'fail' from
  // falsifiable=false still blocks; this proves the same for a failed OUTCOME, which reaches
  // execution-integrity through `explicitBadExecution` — the branch that must never set
  // `absenceOnly`. Without this, widening the exemption to 'fail' could quietly grade away
  // every adverse execution result, and the passing tests above would look identical.
  it('still blocks a FAILED outcome on an executable row — that fail is not absence-shaped', () => {
    const failed = operationalEvidence({
      details: {
        adequacy: {
          fixtureCalibrated: true,
          falsifiable: true,
          pathReachable: true,
          oracleIndependent: true,
          collected: true,
          skipped: false,
          executed: true,
          outcome: 'failed',
          targeted: true,
        },
      },
    });

    const result = evaluateSpecTestAdequacy({
      clause: nonCodeClause,
      evidence: [failed],
      classRef: 'plan-class-bugfix',
      workItemKind: 'task',
    });

    expect(result.requiredProofFloor).toBe('none');
    expect(result.ratings['execution-integrity'].rating).toBe('fail');
    expect(result.wouldBlock).toContain('execution-integrity');
    expect(result.verdict).not.toBe('pass');
  });
});

// EI-23499682118230306 recurrence guard — the SAME drift class as EI-13292, one pair up.
// `ADEQUACY_CRITERIA` (what the evaluator RATES) and rubrics/spec-test-adequacy/rubric.json
// (what the rubric DECLARES) are two copies of one list, and they silently diverged: the
// evaluator gained `disclosed-gap` while the bundle stayed at 8 keys, so scorecards:emit
// refused the evaluator's OWN scorecardDraft with "unexpected criterion key(s): disclosed-gap"
// — no spec-test-adequacy card could be emitted AT ALL for a clause with a disclosed gap.
// Pin the bundle to the evaluator's own list so the two can never silently diverge again.
// review-system-rework-reduction-2026-09-23 P-002 spec C. An amendment that changes only a
// clause's test layers or check re-projects it and CARRIES its bindings onto the new
// revision verbatim (carryUnchangedBarEvidenceBindings copies `details`). The carried row
// must be judged against the NEW revision's layers, never pass on its old ones.
describe('a carried binding is re-validated against the new clause revision (P-002 C)', () => {
  it('passes at the old layers and fails correct-layer once a layers-only amendment raises them', () => {
    const carriedRow = evidence();
    const before = evaluateSpecTestAdequacy({
      clause: clause(), evidence: [carriedRow], classRef: 'plan-class-feature-ship',
    });
    expect(before.ratings['correct-layer'].rating).toBe('pass');

    const raised = clause({
      revision: 2, currentRevision: 2, contentHash: 'sha256:spec-v2', requiredTestLayers: ['integration', 'e2e'],
    });
    const carried = { ...carriedRow, specRevision: 2, specFingerprint: 'sha256:spec-v2' };
    const after = evaluateSpecTestAdequacy({ clause: raised, evidence: [carried], classRef: 'plan-class-feature-ship' });

    expect(after.ratings['correct-layer'].rating).toBe('fail');
  });
});

describe('spec-test-adequacy rubric bundle', () => {
  it('declares exactly the criteria the evaluator rates (EI-23499682118230306)', () => {
    const bundled = resolveLocalRubric('spec-test-adequacy');
    expect(bundled, 'rubrics/spec-test-adequacy/rubric.json must resolve').not.toBeNull();

    const declared = bundled!.criteria.map((c) => c.key);
    // Order-insensitive: emit compares key SETS, so a reorder is not drift.
    expect([...declared].sort()).toEqual([...ADEQUACY_CRITERIA].sort());
  });
});
