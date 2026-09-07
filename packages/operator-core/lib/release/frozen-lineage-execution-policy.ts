/**
 * Shared fail-closed policy for work that can select or judge a frozen gate
 * candidate.
 *
 * The persisted repair queue remains the only identity store. This module only
 * projects its marker into the smaller identity every execution boundary needs
 * and compares a captured identity with the live marker immediately before
 * launch. Ordinary staging edits, focused tests, and explicit repair admission
 * are outside the governed operation set by design.
 */
import { readFrozenRepairMarker, type FrozenRepairEditMarker } from './frozen-repair-edit-marker';

export interface FrozenLineageIdentity {
  candidate: string;
  repairHead: string;
  /** The repair queue's monotonic update stamp (`updatedAtMs` on the marker). */
  queueRevision: number;
}

export type FrozenLineageIdentityField = keyof FrozenLineageIdentity;

export interface FrozenLineageIdentityComparison {
  matches: boolean;
  mismatchedFields: FrozenLineageIdentityField[];
  expected: FrozenLineageIdentity;
  actual: FrozenLineageIdentity;
}

export function frozenLineageIdentityFromMarker(
  marker: Pick<FrozenRepairEditMarker, 'candidate' | 'repairHead' | 'updatedAtMs'>,
): FrozenLineageIdentity {
  return {
    candidate: marker.candidate,
    repairHead: marker.repairHead,
    queueRevision: marker.updatedAtMs,
  };
}

export function readFrozenLineageIdentity(path?: string): FrozenLineageIdentity | null {
  const marker = path === undefined ? readFrozenRepairMarker() : readFrozenRepairMarker(path);
  return marker ? frozenLineageIdentityFromMarker(marker) : null;
}

export function compareFrozenLineageIdentity(
  expected: FrozenLineageIdentity,
  actual: FrozenLineageIdentity,
): FrozenLineageIdentityComparison {
  const mismatchedFields: FrozenLineageIdentityField[] = [];
  if (expected.candidate !== actual.candidate) mismatchedFields.push('candidate');
  if (expected.repairHead !== actual.repairHead) mismatchedFields.push('repairHead');
  if (expected.queueRevision !== actual.queueRevision) mismatchedFields.push('queueRevision');
  return {
    matches: mismatchedFields.length === 0,
    mismatchedFields,
    expected,
    actual,
  };
}

export function frozenLineageIdentityMatches(expected: FrozenLineageIdentity, actual: FrozenLineageIdentity): boolean {
  return compareFrozenLineageIdentity(expected, actual).matches;
}

export type FrozenLineageOperation =
  | 'candidate-selection'
  | 'canonical-verification'
  | 'ordinary-edit'
  | 'focused-test'
  | 'repair-admission';

export type FrozenLineageSelectionSource =
  | 'live-repair-head'
  | 'effective-checkout-head'
  | 'staging'
  | 'current-head'
  | 'integration-branch'
  | 'caller-selected-sha'
  | 'unknown';

export const UNSAFE_FROZEN_CANDIDATE_SOURCES = Object.freeze([
  'staging',
  'current-head',
  'integration-branch',
  'caller-selected-sha',
] as const satisfies readonly FrozenLineageSelectionSource[]);

const unsafeSources = new Set<FrozenLineageSelectionSource>(UNSAFE_FROZEN_CANDIDATE_SOURCES);

export function isGovernedFrozenLineageOperation(operation: FrozenLineageOperation): boolean {
  return operation === 'candidate-selection' || operation === 'canonical-verification';
}

export function isUnsafeFrozenCandidateSource(source: FrozenLineageSelectionSource): boolean {
  return unsafeSources.has(source);
}

export interface FrozenLineagePolicyInput {
  operation: FrozenLineageOperation;
  selectionSource: FrozenLineageSelectionSource;
  /** Effective checkout HEAD observed at the execution boundary. */
  checkoutHead?: string | null;
  /** Queue identity captured by the authority boundary that requested the launch. */
  expectedIdentity?: FrozenLineageIdentity | null;
}

export type FrozenLineagePolicyAllowReason = 'no-frozen-queue' | 'operation-not-governed' | 'repair-head-match';

export type FrozenLineagePolicyRefusalReason =
  | 'selection-source-unknown'
  | 'unsafe-candidate-source'
  | 'queue-identity-required'
  | 'queue-identity-mismatch'
  | 'checkout-head-required'
  | 'checkout-head-mismatch';

interface FrozenLineagePolicyBase {
  operation: FrozenLineageOperation;
  selectionSource: FrozenLineageSelectionSource;
}

export type FrozenLineagePolicyVerdict =
  | (FrozenLineagePolicyBase & {
      allowed: true;
      reason: FrozenLineagePolicyAllowReason;
      liveIdentity: FrozenLineageIdentity | null;
    })
  | (FrozenLineagePolicyBase & {
      allowed: false;
      reason: FrozenLineagePolicyRefusalReason;
      liveIdentity: FrozenLineageIdentity;
      expectedIdentity: FrozenLineageIdentity | null;
      checkoutHead: string | null;
      mismatchedIdentityFields: FrozenLineageIdentityField[];
      sanctionedRoute: string;
    });

export interface FrozenLineagePolicyProbe {
  /** Injected by tests/callers that already performed the live marker read. */
  marker?: FrozenRepairEditMarker | null;
}

function refusal(
  input: FrozenLineagePolicyInput,
  liveIdentity: FrozenLineageIdentity,
  reason: FrozenLineagePolicyRefusalReason,
  mismatchedIdentityFields: FrozenLineageIdentityField[] = [],
): FrozenLineagePolicyVerdict {
  return {
    allowed: false,
    reason,
    operation: input.operation,
    selectionSource: input.selectionSource,
    liveIdentity,
    expectedIdentity: input.expectedIdentity ?? null,
    checkoutHead: input.checkoutHead ?? null,
    mismatchedIdentityFields,
    sanctionedRoute:
      `Select and re-read live repairHead ${liveIdentity.repairHead} from queue revision ` +
      `${liveIdentity.queueRevision} immediately before launch. Land fixes through ` +
      "release:repair-queue { op:'admit', paths:[...] }.",
  };
}

/**
 * Evaluate one candidate-selection or canonical-verification boundary.
 *
 * Governed work fails closed on an unknown/unsafe source, a missing or stale
 * captured queue identity, a missing checkout observation, or any checkout HEAD
 * other than the current repairHead. Non-governed staging work remains legal.
 */
export function evaluateFrozenLineagePolicy(
  input: FrozenLineagePolicyInput,
  probe: FrozenLineagePolicyProbe = {},
): FrozenLineagePolicyVerdict {
  const marker = 'marker' in probe ? probe.marker : readFrozenRepairMarker();
  if (!marker) {
    return {
      allowed: true,
      reason: 'no-frozen-queue',
      operation: input.operation,
      selectionSource: input.selectionSource,
      liveIdentity: null,
    };
  }

  const liveIdentity = frozenLineageIdentityFromMarker(marker);
  if (!isGovernedFrozenLineageOperation(input.operation)) {
    return {
      allowed: true,
      reason: 'operation-not-governed',
      operation: input.operation,
      selectionSource: input.selectionSource,
      liveIdentity,
    };
  }
  if (input.selectionSource === 'unknown') {
    return refusal(input, liveIdentity, 'selection-source-unknown');
  }
  if (isUnsafeFrozenCandidateSource(input.selectionSource)) {
    return refusal(input, liveIdentity, 'unsafe-candidate-source');
  }
  if (!input.expectedIdentity) {
    return refusal(input, liveIdentity, 'queue-identity-required');
  }
  const comparison = compareFrozenLineageIdentity(input.expectedIdentity, liveIdentity);
  if (!comparison.matches) {
    return refusal(input, liveIdentity, 'queue-identity-mismatch', comparison.mismatchedFields);
  }
  if (!input.checkoutHead) {
    return refusal(input, liveIdentity, 'checkout-head-required');
  }
  if (input.checkoutHead !== liveIdentity.repairHead) {
    return refusal(input, liveIdentity, 'checkout-head-mismatch');
  }
  return {
    allowed: true,
    reason: 'repair-head-match',
    operation: input.operation,
    selectionSource: input.selectionSource,
    liveIdentity,
  };
}

export function renderFrozenLineagePolicyRefusal(verdict: FrozenLineagePolicyVerdict): string | null {
  if (verdict.allowed) return null;
  const identity = verdict.liveIdentity;
  const mismatch = verdict.mismatchedIdentityFields.length
    ? ` Mismatched identity fields: ${verdict.mismatchedIdentityFields.join(', ')}.`
    : '';
  return (
    `frozen_lineage_refused:${verdict.reason}: ${verdict.operation} selected source ` +
    `'${verdict.selectionSource}' with checkout HEAD ${verdict.checkoutHead ?? 'unmeasured'}. ` +
    `Live queue identity is candidate=${identity.candidate}, repairHead=${identity.repairHead}, ` +
    `queueRevision=${identity.queueRevision}.${mismatch} ${verdict.sanctionedRoute}`
  );
}
