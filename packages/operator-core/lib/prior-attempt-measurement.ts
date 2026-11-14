/** Data-backed context-headroom decision for prior-attempt claim enrichment (P-015/D-011). */

import { createHash } from 'node:crypto';

export interface PriorAttemptMeasurementSample {
  estimatedTokens: number;
  serializedChars: number;
  latencyMs: number;
  omittedRecords: number;
  authorityRefs: number;
  expectedAuthorityRefs: number;
  residueRefs: number;
  expectedResidueRefs: number;
}

export interface PriorAttemptMeasurementOptions {
  fleetMemberLimit: number;
  inputPerMtokUsd: number;
  cacheReadPerMtokUsd: number;
  /** Minimum average share of the current member limit that warrants changing
   * a fleet-wide role cap. Default 5%; also subject to a 10k absolute floor. */
  materialShare?: number;
}

export interface PriorAttemptMeasurement {
  sampleCount: number;
  averageTokens: number;
  p95Tokens: number;
  maxTokens: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
  truncationRate: number;
  averageOmittedRecords: number;
  authorityRefFidelity: number;
  residueRefFidelity: number;
  averageCompactionPressure: number;
  p95CompactionPressure: number;
  inputCostUsdPerClaim: number;
  cacheReadCostUsdPerClaim: number;
  recommendation:
    | { action: 'keep'; currentLimit: number; materialThresholdTokens: number; reason: string }
    | { action: 'increase'; currentLimit: number; increaseTokens: number; proposedLimit: number; materialThresholdTokens: number; reason: string };
}

function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/**
 * Quantify claim-context growth and decide whether it is large enough to alter
 * the fleet-member role cap.  D-011's example maps an observed average +40k to
 * approximately +40k; this rounds a material average up to the next 10k.  A
 * sub-5%/sub-10k average stays within the existing runway rather than quietly
 * raising every member's per-turn cache spend.
 */
export function measurePriorAttemptContext(
  samples: readonly PriorAttemptMeasurementSample[],
  options: PriorAttemptMeasurementOptions,
): PriorAttemptMeasurement {
  const count = samples.length;
  const average = (field: keyof PriorAttemptMeasurementSample): number =>
    count ? samples.reduce((sum, sample) => sum + sample[field], 0) / count : 0;
  const averageTokens = Math.round(average('estimatedTokens'));
  const p95Tokens = percentile(samples.map((sample) => sample.estimatedTokens), 0.95);
  const maxTokens = Math.max(0, ...samples.map((sample) => sample.estimatedTokens));
  const averageLatencyMs = Math.round(average('latencyMs'));
  const p95LatencyMs = percentile(samples.map((sample) => sample.latencyMs), 0.95);
  const materialThresholdTokens = Math.max(
    10_000,
    Math.ceil((options.fleetMemberLimit * (options.materialShare ?? 0.05)) / 1_000) * 1_000,
  );
  const material = averageTokens >= materialThresholdTokens;
  const increaseTokens = Math.ceil(averageTokens / 10_000) * 10_000;
  return {
    sampleCount: count,
    averageTokens,
    p95Tokens,
    maxTokens,
    averageLatencyMs,
    p95LatencyMs,
    truncationRate: ratio(samples.filter((sample) => sample.omittedRecords > 0).length, count),
    averageOmittedRecords: Number(average('omittedRecords').toFixed(2)),
    authorityRefFidelity: ratio(
      samples.reduce((sum, sample) => sum + sample.authorityRefs, 0),
      samples.reduce((sum, sample) => sum + sample.expectedAuthorityRefs, 0),
    ),
    residueRefFidelity: ratio(
      samples.reduce((sum, sample) => sum + sample.residueRefs, 0),
      samples.reduce((sum, sample) => sum + sample.expectedResidueRefs, 0),
    ),
    averageCompactionPressure: ratio(averageTokens, options.fleetMemberLimit),
    p95CompactionPressure: ratio(p95Tokens, options.fleetMemberLimit),
    inputCostUsdPerClaim: (averageTokens / 1_000_000) * options.inputPerMtokUsd,
    cacheReadCostUsdPerClaim: (averageTokens / 1_000_000) * options.cacheReadPerMtokUsd,
    recommendation: material
      ? {
          action: 'increase',
          currentLimit: options.fleetMemberLimit,
          increaseTokens,
          proposedLimit: options.fleetMemberLimit + increaseTokens,
          materialThresholdTokens,
          reason: `average incremental context ${averageTokens} tokens meets the ${materialThresholdTokens}-token materiality threshold`,
        }
      : {
          action: 'keep',
          currentLimit: options.fleetMemberLimit,
          materialThresholdTokens,
          reason: `average incremental context ${averageTokens} tokens is below the ${materialThresholdTokens}-token materiality threshold`,
        },
  };
}

export interface PriorAttemptDeliveryScope {
  workspaceId: string;
  ownerId: string;
  nativeSessionId: string;
  sourceFingerprint: string;
  inputFingerprint: string;
}

export interface PriorAttemptDeliveryObservation {
  scope: PriorAttemptDeliveryScope;
  receiptRef: string | null;
  phase: 'emitted' | 'packed' | 'queued' | 'server-ok' | 'offered' | 'searchable';
  refs: readonly string[];
}

export interface PriorAttemptDeliveryMeasurementInput {
  scope: PriorAttemptDeliveryScope;
  requiredRefs: readonly string[];
  applicableRefs: readonly string[];
  observations: readonly PriorAttemptDeliveryObservation[];
  /** Whether the original receipt census for this exact scope is complete. */
  complete: boolean;
}

const deliveryScopeKeys = [
  'workspaceId', 'ownerId', 'nativeSessionId', 'sourceFingerprint', 'inputFingerprint',
] as const;

/** Reference-set fidelity only: callers must resolve original client-emission
 * receipts before supplying observations. This neither establishes complete
 * source-text delivery nor counts exactly-once outcome occurrences. Synthetic
 * reader fixtures cannot establish that a live pilot ran.
 */
export function measurePriorAttemptDelivery(input: PriorAttemptDeliveryMeasurementInput) {
  const required = new Set(input.requiredRefs);
  const applicable = new Set(input.applicableRefs);
  const confirmed = new Set<string>();
  const receiptRefs = new Set<string>();
  const unknownReasons = new Set<string>();
  const nonblank = (value: string): boolean => value.trim().length > 0;
  const validOracle = required.size > 0
    && [...required].every(ref => nonblank(ref) && applicable.has(ref))
    && [...applicable].every(nonblank);
  const validScope = deliveryScopeKeys.every(key => nonblank(input.scope[key]));
  if (!validOracle) unknownReasons.add('invalid-required-or-applicable-reference-set');
  if (!validScope) unknownReasons.add('invalid-measurement-scope');
  if (!input.complete) unknownReasons.add('incomplete-receipt-census');

  for (const observation of input.observations) {
    // Availability and successful server execution are not client emission.
    if (observation.phase !== 'emitted') continue;
    if (!observation.receiptRef || !nonblank(observation.receiptRef)) {
      unknownReasons.add('missing-original-emission-receipt');
      continue;
    }
    if (!validScope || deliveryScopeKeys.some(key => observation.scope[key] !== input.scope[key])) {
      unknownReasons.add('emission-receipt-scope-mismatch');
      continue;
    }
    if (!observation.refs.every(nonblank)) {
      unknownReasons.add('invalid-emitted-reference');
      continue;
    }
    receiptRefs.add(observation.receiptRef);
    for (const ref of observation.refs) confirmed.add(ref);
  }
  if (!receiptRefs.size) unknownReasons.add('no-qualified-client-emission');

  const missingRefs = [...required].filter(ref => !confirmed.has(ref));
  const inapplicableRefs = [...confirmed].filter(ref => !applicable.has(ref));
  const recall = validOracle ? (required.size - missingRefs.length) / required.size : null;
  const precision = validOracle && confirmed.size
    ? (confirmed.size - inapplicableRefs.length) / confirmed.size : null;
  const verdict: 'pass' | 'fail' | 'unknown' = unknownReasons.size ? 'unknown'
    : missingRefs.length || inapplicableRefs.length ? 'fail' : 'pass';
  return {
    verdict, recall, precision, confirmed: confirmed.size,
    confirmedRefs: [...confirmed], missingRefs, inapplicableRefs,
    receiptRefs: [...receiptRefs], unknownReasons: [...unknownReasons],
  };
}

export interface PriorAttemptTransitionScope extends PriorAttemptDeliveryScope {
  runtimeFingerprint: string;
  specFingerprint: string;
}

export interface PriorAttemptExpectedTransition {
  logicalReceiptId: string;
  transitionRef: string;
}

export interface PriorAttemptTransitionReceipt extends PriorAttemptExpectedTransition {
  receiptRef: string | null;
  physicalAttemptId: string;
  scope: PriorAttemptTransitionScope | null;
  outcome: 'accepted' | 'idempotent-noop' | 'failed';
}

export interface PriorAttemptTransitionMeasurementInput {
  scope: PriorAttemptTransitionScope;
  expectedTransitions: readonly PriorAttemptExpectedTransition[];
  physicalAttemptIds: readonly string[];
  receipts: readonly PriorAttemptTransitionReceipt[];
  complete: boolean;
  /** Resolved independent review of the frozen expectation bytes, serialized
   * as JSON.stringify(expectedTransitions). Availability of a review is not a join. */
  oracleReview: {
    receiptRef: string | null;
    expectationSha256: string | null;
    authorId: string;
    reviewerId: string;
  } | null;
}

const transitionScopeKeys = [...deliveryScopeKeys, 'runtimeFingerprint', 'specFingerprint'] as const;

/** Measure original outcome receipts, not reference-set delivery. Callers must
 * resolve the original review and runtime/source/input/spec joins before passing
 * them here. This pure reader cannot authenticate a receipt or qualify a live
 * pilot. Every physical attempt is retained, including failed and no-op attempts;
 * state-changing occurrences are counted BEFORE grouping logical transitions.
 * Incomplete/ineligible evidence stays UNKNOWN, even beside a contradiction.
 */
export function measurePriorAttemptTransitions(input: PriorAttemptTransitionMeasurementInput) {
  const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  const key = (transition: PriorAttemptExpectedTransition): string =>
    JSON.stringify([transition.logicalReceiptId, transition.transitionRef]);
  const unknownReasons = new Set<string>();
  const failureReasons = new Set<string>();
  const expected = new Map(input.expectedTransitions.map(transition => [key(transition), transition]));
  if (!expected.size || expected.size !== input.expectedTransitions.length
    || new Set(input.expectedTransitions.map(transition => transition.logicalReceiptId)).size !== expected.size
    || input.expectedTransitions.some(transition => !nonblank(transition.logicalReceiptId) || !nonblank(transition.transitionRef))) {
    unknownReasons.add('invalid-expected-transition-population');
  }
  const review = input.oracleReview;
  if (!review || !nonblank(review.receiptRef) || !nonblank(review.authorId) || !nonblank(review.reviewerId)
    || review.authorId === review.reviewerId
    || review.expectationSha256 !== createHash('sha256').update(JSON.stringify(input.expectedTransitions)).digest('hex')) {
    unknownReasons.add('unreviewed-or-changed-expectation-bytes');
  }
  const validScope = transitionScopeKeys.every(field => nonblank(input.scope[field]));
  if (!validScope) unknownReasons.add('invalid-measurement-scope');
  if (!input.complete) unknownReasons.add('incomplete-receipt-census');
  const physicalAttempts = new Set(input.physicalAttemptIds);
  if (!physicalAttempts.size || physicalAttempts.size !== input.physicalAttemptIds.length
    || input.physicalAttemptIds.some(id => !nonblank(id))) {
    unknownReasons.add('invalid-physical-attempt-population');
  }

  const qualified: PriorAttemptTransitionReceipt[] = [];
  const originalRefs = new Set<string>();
  for (const receipt of input.receipts) {
    if (!nonblank(receipt.receiptRef)) {
      unknownReasons.add('missing-original-outcome-receipt');
      continue;
    }
    if (originalRefs.has(receipt.receiptRef)) unknownReasons.add('repeated-original-outcome-receipt');
    originalRefs.add(receipt.receiptRef);
    if (!validScope || !receipt.scope || transitionScopeKeys.some(field => receipt.scope![field] !== input.scope[field])) {
      unknownReasons.add('outcome-receipt-scope-mismatch');
      continue;
    }
    if (!physicalAttempts.has(receipt.physicalAttemptId)) {
      unknownReasons.add('undeclared-physical-attempt');
      continue;
    }
    if (!nonblank(receipt.logicalReceiptId) || !nonblank(receipt.transitionRef)
      || !['accepted', 'idempotent-noop', 'failed'].includes(receipt.outcome)) {
      unknownReasons.add('invalid-outcome-receipt');
      continue;
    }
    qualified.push(receipt);
  }

  const missingPhysicalAttemptIds = input.physicalAttemptIds.filter(id => !qualified.some(receipt => receipt.physicalAttemptId === id));
  if (missingPhysicalAttemptIds.length) unknownReasons.add('missing-physical-attempt');
  for (const id of physicalAttempts) {
    if (qualified.filter(receipt => receipt.physicalAttemptId === id).length > 1) {
      failureReasons.add('contradictory-physical-attempt-outcomes');
    }
  }

  const accepted = qualified.filter(receipt => receipt.outcome === 'accepted');
  const acceptedCounts = new Map<string, number>();
  for (const receipt of accepted) acceptedCounts.set(key(receipt), (acceptedCounts.get(key(receipt)) ?? 0) + 1);
  const missingTransitions = input.expectedTransitions.filter(transition => !acceptedCounts.has(key(transition)));
  const duplicateTransitions = input.expectedTransitions.filter(transition => (acceptedCounts.get(key(transition)) ?? 0) > 1);
  const unexpectedAcceptedReceiptRefs = accepted.filter(receipt => !expected.has(key(receipt))).map(receipt => receipt.receiptRef!);
  if (missingTransitions.length) failureReasons.add('missing-accepted-transition');
  if (duplicateTransitions.length) failureReasons.add('duplicate-accepted-transition');
  if (unexpectedAcceptedReceiptRefs.length) failureReasons.add('unexpected-accepted-transition');
  if (qualified.some(receipt => !expected.has(key(receipt)))) failureReasons.add('unexpected-transition-outcome');

  const verdict: 'pass' | 'fail' | 'unknown' = unknownReasons.size ? 'unknown' : failureReasons.size ? 'fail' : 'pass';
  return {
    verdict,
    acceptedOccurrences: accepted.length,
    idempotentNoops: qualified.filter(receipt => receipt.outcome === 'idempotent-noop').length,
    failedAttempts: qualified.filter(receipt => receipt.outcome === 'failed').length,
    physicalAttemptIds: [...input.physicalAttemptIds],
    receipts: [...input.receipts],
    missingPhysicalAttemptIds, missingTransitions, duplicateTransitions, unexpectedAcceptedReceiptRefs,
    unknownReasons: [...unknownReasons], failureReasons: [...failureReasons],
  };
}
