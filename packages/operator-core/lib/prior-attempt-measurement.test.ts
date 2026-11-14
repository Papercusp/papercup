import { describe, expect, it } from 'vitest';
import {
  measurePriorAttemptContext, measurePriorAttemptDelivery, measurePriorAttemptTransitions,
  type PriorAttemptDeliveryObservation, type PriorAttemptDeliveryScope,
  type PriorAttemptMeasurementSample, type PriorAttemptTransitionMeasurementInput,
  type PriorAttemptTransitionScope,
} from './prior-attempt-measurement';
import {
  PRIOR_ATTEMPT_DELIVERY_ORACLE, PRIOR_ATTEMPT_DELIVERY_QUALIFICATION_ORACLE,
  PAPERWORK_TRANSITION_OCCURRENCE_ORACLE,
} from './prior-attempt-measurement.fixtures';

const sample = (tokens: number, rest: Partial<PriorAttemptMeasurementSample> = {}): PriorAttemptMeasurementSample => ({
  estimatedTokens: tokens,
  serializedChars: tokens * 4,
  latencyMs: 1_000,
  omittedRecords: 0,
  authorityRefs: 2,
  expectedAuthorityRefs: 2,
  residueRefs: 1,
  expectedResidueRefs: 1,
  ...rest,
});

describe('measurePriorAttemptContext', () => {
  it('keeps the 200k member cap for the measured ~3k-token P-015 shape', () => {
    const result = measurePriorAttemptContext(
      [sample(2_500), sample(2_922, { omittedRecords: 3 }), sample(3_482)],
      { fleetMemberLimit: 200_000, inputPerMtokUsd: 1.875, cacheReadPerMtokUsd: 0.1875 },
    );
    expect(result.recommendation).toMatchObject({ action: 'keep', currentLimit: 200_000, materialThresholdTokens: 10_000 });
    expect(result.averageCompactionPressure).toBeLessThan(0.02);
    expect(result.p95CompactionPressure).toBeLessThan(0.02);
    expect(result.authorityRefFidelity).toBe(1);
    expect(result.residueRefFidelity).toBe(1);
    expect(result.truncationRate).toBeCloseTo(1 / 3);
  });

  it('maps a material average +40k payload to a commensurate +40k limit', () => {
    const result = measurePriorAttemptContext(
      [sample(38_000), sample(40_000), sample(42_000)],
      { fleetMemberLimit: 200_000, inputPerMtokUsd: 1.875, cacheReadPerMtokUsd: 0.1875 },
    );
    expect(result.recommendation).toEqual(expect.objectContaining({
      action: 'increase', increaseTokens: 40_000, proposedLimit: 240_000,
    }));
  });

  it('computes P95, latency, omission fidelity, pressure, and canonical price-table cost', () => {
    const result = measurePriorAttemptContext(
      [sample(1_000, { latencyMs: 500 }), sample(2_000, { latencyMs: 700, authorityRefs: 1 }), sample(3_000, { latencyMs: 900, residueRefs: 0 })],
      { fleetMemberLimit: 200_000, inputPerMtokUsd: 2, cacheReadPerMtokUsd: 0.2 },
    );
    expect(result).toMatchObject({ averageTokens: 2_000, p95Tokens: 3_000, averageLatencyMs: 700, p95LatencyMs: 900 });
    expect(result.authorityRefFidelity).toBeCloseTo(5 / 6);
    expect(result.residueRefFidelity).toBeCloseTo(2 / 3);
    expect(result.inputCostUsdPerClaim).toBeCloseTo(0.004);
    expect(result.cacheReadCostUsdPerClaim).toBeCloseTo(0.0004);
  });
});

describe('measurePriorAttemptDelivery', () => {
  // Prospective synthetic reader controls, not original live pilot receipts.
  // Oracle source review: coord-send-0be5cbfc547444206d587f0407d4879153842fdede340ed2fd32a0dcde085011.
  const oracle = PRIOR_ATTEMPT_DELIVERY_ORACLE;
  const observation = (
    refs: readonly string[],
    phase: PriorAttemptDeliveryObservation['phase'] = 'emitted',
  ): PriorAttemptDeliveryObservation => ({
    scope: oracle.scope, receiptRef: 'fixture:original-emission', phase, refs,
  });

  it.each(oracle.cases)('$name', fixture => {
    const observations = [
      ...(fixture.confirmedRefs.length ? [observation(fixture.confirmedRefs)] : []),
      observation(fixture.offeredRefs, 'offered'),
      observation(fixture.searchableRefs, 'searchable'),
    ];
    const result = measurePriorAttemptDelivery({
      scope: oracle.scope, requiredRefs: oracle.requiredRefs,
      applicableRefs: oracle.applicableRefs, observations, complete: fixture.complete,
    });
    expect(result).toMatchObject(fixture.expected);
  });

  it.each(PRIOR_ATTEMPT_DELIVERY_QUALIFICATION_ORACLE)('$name', fixture => {
    const overrides: {
      receiptRef?: string | null;
      scope?: Partial<PriorAttemptDeliveryScope>;
      requiredRefs?: readonly string[];
      phase?: PriorAttemptDeliveryObservation['phase'];
    } = fixture;
    const result = measurePriorAttemptDelivery({
      scope: oracle.scope, requiredRefs: overrides.requiredRefs ?? oracle.requiredRefs,
      applicableRefs: oracle.applicableRefs, complete: true,
      observations: [{
        ...observation(oracle.requiredRefs),
        ...('receiptRef' in overrides ? { receiptRef: overrides.receiptRef! } : {}),
        scope: { ...oracle.scope, ...overrides.scope },
        phase: overrides.phase ?? 'emitted',
      }],
    });
    expect(result.verdict).toBe(fixture.expected);
    expect(result.unknownReasons.length).toBeGreaterThan(0);
  });

  it('counts applicable non-required references as precise without enlarging required recall', () => {
    expect(measurePriorAttemptDelivery({
      scope: oracle.scope, requiredRefs: oracle.requiredRefs,
      applicableRefs: oracle.applicableRefs, complete: true,
      observations: [observation(oracle.applicableRefs)],
    })).toMatchObject({ verdict: 'pass', recall: 1, precision: 1, confirmed: 3 });
  });

  it('does not let valid emissions hide an ineligible original receipt in the declared census', () => {
    expect(measurePriorAttemptDelivery({
      scope: oracle.scope, requiredRefs: oracle.requiredRefs,
      applicableRefs: oracle.applicableRefs, complete: true,
      observations: [observation(oracle.requiredRefs), { ...observation([]), receiptRef: null }],
    })).toMatchObject({ verdict: 'unknown', recall: 1, precision: 1 });
  });
});

describe('measurePriorAttemptTransitions', () => {
  // Frozen before implementation; independent source review: WI-6554700010045886#1223518,
  // manifest SHA256 0f4120b13ef59382f0ee818e7ac8c2c29f966236f3703867fe88b34dc04284d2.
  // The joins below are synthetic reader controls, never native pilot proof.
  const oracle = PAPERWORK_TRANSITION_OCCURRENCE_ORACLE;
  const scope: PriorAttemptTransitionScope = {
    ...PRIOR_ATTEMPT_DELIVERY_ORACLE.scope,
    runtimeFingerprint: 'fixture:runtime', specFingerprint: 'fixture:spec',
  };
  const inputFor = (fixture = oracle.cases[0] as typeof oracle.cases[number]): PriorAttemptTransitionMeasurementInput => ({
    scope, expectedTransitions: oracle.expectedTransitions,
    physicalAttemptIds: fixture.physicalAttemptIds,
    receipts: fixture.receipts.map(receipt => ({ ...receipt, scope })), complete: true,
    oracleReview: {
      receiptRef: 'fixture:independent-review', authorId: 'fixture:author', reviewerId: 'fixture:reviewer',
      expectationSha256: '7ce19d9556dfdd53441cb8b83376d914f1312f5ac07ba62567afde89254ee487',
    },
  });

  it.each(oracle.cases)('$name', fixture => {
    const input = inputFor(fixture);
    const before = structuredClone(input);
    const result = measurePriorAttemptTransitions(input);
    expect(result).toMatchObject(fixture.expected);
    expect(result.physicalAttemptIds).toEqual(fixture.physicalAttemptIds);
    expect(result.receipts).toEqual(input.receipts);
    expect(input).toEqual(before);
  });

  it.each(oracle.qualificationControls)('$id', control => {
    const input = inputFor();
    switch (control.id) {
      case 'empty-expected-transition-population': input.expectedTransitions = []; break;
      case 'missing-original-receipt': input.receipts = [{ ...input.receipts[0]!, receiptRef: null }]; break;
      case 'unreviewed-or-changed-expectation-bytes': input.oracleReview = null; break;
      case 'unjoined-runtime-source-input-or-spec-identity': input.receipts = [{ ...input.receipts[0]!, scope: null }]; break;
    }
    const result = measurePriorAttemptTransitions(input);
    expect(result.verdict).toBe(control.expected);
    expect(result.unknownReasons.length).toBeGreaterThan(0);
  });

  it('rejects changed expectation bytes even when the observed acceptance matches them', () => {
    const input = inputFor();
    input.expectedTransitions = [{ logicalReceiptId: 'logical-1', transitionRef: 'changed-expectation' }];
    input.receipts = [{ ...input.receipts[0]!, transitionRef: 'changed-expectation' }];
    expect(measurePriorAttemptTransitions(input)).toMatchObject({
      verdict: 'unknown', acceptedOccurrences: 1, unknownReasons: ['unreviewed-or-changed-expectation-bytes'],
    });
  });

  it.each(['receiptRef', 'expectationSha256', 'authorId', 'reviewerId'] as const)('requires review %s', field => {
    const input = inputFor();
    input.oracleReview = { ...input.oracleReview!, [field]: '' };
    expect(measurePriorAttemptTransitions(input).verdict).toBe('unknown');
  });

  it('does not qualify a same-author review', () => {
    const input = inputFor();
    input.oracleReview = { ...input.oracleReview!, reviewerId: input.oracleReview!.authorId };
    expect(measurePriorAttemptTransitions(input).verdict).toBe('unknown');
  });

  it.each(Object.keys(scope) as (keyof PriorAttemptTransitionScope)[])('requires the original receipt to join %s', field => {
    const input = inputFor();
    input.receipts = [{ ...input.receipts[0]!, scope: { ...scope, [field]: 'foreign' } }];
    expect(measurePriorAttemptTransitions(input)).toMatchObject({ verdict: 'unknown', acceptedOccurrences: 0 });
  });

  it('fails surplus accepted transitions without allowing an equal total to substitute for the expected transition', () => {
    const input = inputFor();
    input.receipts = [{ ...input.receipts[0]!, logicalReceiptId: 'logical-extra' }];
    expect(measurePriorAttemptTransitions(input)).toMatchObject({
      verdict: 'fail', acceptedOccurrences: 1,
      missingTransitions: oracle.expectedTransitions, unexpectedAcceptedReceiptRefs: ['original:1'],
    });
  });

  it.each(['exact', 'duplicate-first', 'foreign-second'] as const)(
    'preserves each expected transition in a multi-transition population (%s)', kind => {
      const input = inputFor();
      // Additional synthetic reader controls requested by the independent source
      // review. These do not modify the frozen single-transition pilot oracle.
      input.expectedTransitions = [
        ...oracle.expectedTransitions,
        { logicalReceiptId: 'logical-2', transitionRef: 'resume:fixture#P-004' },
      ];
      input.oracleReview = {
        ...input.oracleReview!,
        expectationSha256: '7159793f901c21a86942f6953ccd6a9f412b5b95cc32f6bf0ad7016f2dd5be03',
      };
      input.physicalAttemptIds = ['attempt-1', 'attempt-2'];
      input.receipts = [input.receipts[0]!, {
        receiptRef: 'original:2', physicalAttemptId: 'attempt-2', scope, outcome: 'accepted',
        ...(kind === 'duplicate-first' ? input.expectedTransitions[0]! : input.expectedTransitions[1]!),
        ...(kind === 'foreign-second' ? { transitionRef: 'resume:unexpected' } : {}),
      }];
      const result = measurePriorAttemptTransitions(input);
      expect(result).toMatchObject({
        verdict: kind === 'exact' ? 'pass' : 'fail', acceptedOccurrences: 2,
        unknownReasons: [], missingPhysicalAttemptIds: [],
        missingTransitions: kind === 'exact' ? [] : [input.expectedTransitions[1]],
        duplicateTransitions: kind === 'duplicate-first' ? [input.expectedTransitions[0]] : [],
        unexpectedAcceptedReceiptRefs: kind === 'foreign-second' ? ['original:2'] : [],
      });
      expect(result.receipts).toEqual(input.receipts);
    },
  );

  it('rejects two conflicting outcomes for one physical attempt', () => {
    const input = inputFor();
    input.receipts = [...input.receipts, { ...input.receipts[0]!, receiptRef: 'original:conflict', outcome: 'failed' }];
    expect(measurePriorAttemptTransitions(input)).toMatchObject({
      verdict: 'fail', failureReasons: ['contradictory-physical-attempt-outcomes'],
    });
  });

  it('requires an accepted occurrence even when every attempt is explicitly an idempotent no-op', () => {
    const input = inputFor();
    input.receipts = [{ ...input.receipts[0]!, outcome: 'idempotent-noop' }];
    expect(measurePriorAttemptTransitions(input)).toMatchObject({ verdict: 'fail', acceptedOccurrences: 0, idempotentNoops: 1 });
  });

  it('retains a contradiction but keeps an incomplete census unknown', () => {
    const input = inputFor(oracle.cases[3]);
    input.complete = false;
    expect(measurePriorAttemptTransitions(input)).toMatchObject({
      verdict: 'unknown', acceptedOccurrences: 2, failureReasons: ['duplicate-accepted-transition'],
      unknownReasons: ['incomplete-receipt-census'],
    });
  });

  it('cannot interpret repeated observations of one original receipt as qualified extra state changes', () => {
    const input = inputFor();
    input.receipts = [...input.receipts, input.receipts[0]!];
    expect(measurePriorAttemptTransitions(input)).toMatchObject({
      verdict: 'unknown', unknownReasons: ['repeated-original-outcome-receipt'],
    });
  });

  it.each(['empty', 'duplicate', 'blank', 'undeclared'] as const)('keeps a %s physical-attempt population unknown', kind => {
    const input = inputFor();
    if (kind === 'empty') input.physicalAttemptIds = [];
    if (kind === 'duplicate') input.physicalAttemptIds = ['attempt-1', 'attempt-1'];
    if (kind === 'blank') input.physicalAttemptIds = [''];
    if (kind === 'undeclared') input.receipts = [{ ...input.receipts[0]!, physicalAttemptId: 'attempt-2' }];
    expect(measurePriorAttemptTransitions(input).verdict).toBe('unknown');
  });
});
