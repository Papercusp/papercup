/**
 * Shared contract for waits whose completion event is produced asynchronously.
 *
 * Push delivery remains the primary path.  This certificate gives a bounded
 * timeout wake enough information to re-check the producer authoritatively and
 * decide whether to park again or surface a stalled/absent producer for
 * ownership takeover.
 */

export const PRODUCER_HEALTH_CERTIFICATE_VERSION = 1 as const;

export interface ProducerIdentity {
  /** Stable producer family, for example `green-checkpoint`. */
  kind: string;
  /** Stable instance/run identifier within the family. */
  id: string;
}

export interface ProducerOwnerReference {
  ownerId: string | null;
  workItemId: string | null;
}

export interface ProducerHealthCertificate {
  version: typeof PRODUCER_HEALTH_CERTIFICATE_VERSION;
  producer: ProducerIdentity;
  owner: ProducerOwnerReference;
  /** When the certificate was constructed. */
  issuedAtMs: number;
  /** Latest authoritative progress known when the wait was armed. */
  lastProgressAtMs: number | null;
  /** Latest authoritative completion-event fire known when the wait was armed. */
  lastFireAtMs: number | null;
  /** Maximum expected interval between producer progress signals. */
  expectedCadenceMs: number;
  /** Earliest instant at which the fallback verifier may classify a timeout. */
  verificationDeadlineMs: number;
  /** Producer-family inputs needed by its authoritative verifier. */
  details?: Record<string, unknown>;
}

export interface ProducerHealthObservation {
  checkedAtMs: number;
  /** False only when the authoritative producer record no longer exists. */
  producerPresent: boolean;
  lastProgressAtMs: number | null;
  lastFireAtMs: number | null;
  /** Authoritative completion state; does not infer completion from liveness. */
  completedAtMs: number | null;
  /** Source-specific evidence suitable for a leader brief or checkpoint. */
  evidence?: Record<string, unknown>;
}

export type VerifiedWaitTimeoutClassification =
  | "progressing"
  | "stalled"
  | "absent"
  | "already-complete";

export type VerifiedWaitNextAction = "re-await" | "resume" | "wake-owner-or-takeover";

export interface VerifiedWaitTimeoutResult {
  classification: VerifiedWaitTimeoutClassification;
  nextAction: VerifiedWaitNextAction;
  producer: ProducerIdentity;
  owner: ProducerOwnerReference;
  checkedAtMs: number;
  verificationDeadlineMs: number;
  lastProgressAtMs: number | null;
  lastFireAtMs: number | null;
  evidence?: Record<string, unknown>;
}

function latestTimestamp(...values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value != null);
  return present.length > 0 ? Math.max(...present) : null;
}

/**
 * Classify one authoritative producer re-check after the certificate deadline.
 * A timeout is deliberately not treated as failure by itself.
 */
export function classifyVerifiedWaitTimeout(
  certificate: ProducerHealthCertificate,
  observation: ProducerHealthObservation,
): VerifiedWaitTimeoutResult {
  if (certificate.expectedCadenceMs <= 0 || !Number.isFinite(certificate.expectedCadenceMs)) {
    throw new RangeError("expectedCadenceMs must be a finite positive number");
  }
  if (observation.checkedAtMs < certificate.verificationDeadlineMs) {
    throw new RangeError("producer health cannot be classified before the verification deadline");
  }

  const base = {
    producer: certificate.producer,
    owner: certificate.owner,
    checkedAtMs: observation.checkedAtMs,
    verificationDeadlineMs: certificate.verificationDeadlineMs,
    lastProgressAtMs: observation.lastProgressAtMs,
    lastFireAtMs: observation.lastFireAtMs,
    ...(observation.evidence ? { evidence: observation.evidence } : {}),
  };

  if (observation.completedAtMs != null || observation.lastFireAtMs != null) {
    return { ...base, classification: "already-complete", nextAction: "resume" };
  }

  if (!observation.producerPresent) {
    return { ...base, classification: "absent", nextAction: "wake-owner-or-takeover" };
  }

  const baselineActivity = latestTimestamp(
    certificate.lastProgressAtMs,
    certificate.lastFireAtMs,
    certificate.issuedAtMs,
  );
  const observedActivity = latestTimestamp(observation.lastProgressAtMs, observation.lastFireAtMs);
  const advanced = observedActivity != null && baselineActivity != null && observedActivity > baselineActivity;
  const fresh =
    observedActivity != null && observation.checkedAtMs - observedActivity <= certificate.expectedCadenceMs;

  if (advanced || fresh) {
    return { ...base, classification: "progressing", nextAction: "re-await" };
  }

  return { ...base, classification: "stalled", nextAction: "wake-owner-or-takeover" };
}
