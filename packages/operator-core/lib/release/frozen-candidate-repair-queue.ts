/**
 * Pure policy for the green-checkpoint's serialized frozen-candidate repair queue.
 *
 * The gate and the routine metadata writer both need the same answer to four safety
 * questions: whether a fixer may be dispatched, whether a live/unknown fixer makes the
 * current tick inconclusive, which exact repair head must be verified, and whether the
 * tested patch is present on staging before promotion. Keeping those answers here avoids
 * recreating a second queue in either caller. This module deliberately performs no git,
 * filesystem, database, or process work.
 */

export const FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION = 3 as const;
export const FROZEN_REPAIR_STAGING_MISMATCH_SIGNATURE = 'repair-staging-mismatch';

/** These bounds stop unattended fixer churn. Exhaustion retains the candidate at the queue
 * head; it never authorizes a newer moving-tip candidate. */
export const DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS = Object.freeze({
  maxAttempts: 3,
  maxAgeMs: 4 * 60 * 60 * 1_000,
});

/**
 * A queue dispatch is an external side effect, so the metadata row needs a short-lived
 * ownership lease around the read -> launch -> finalize window.  The lease is deliberately
 * much shorter than the four-hour repair budget: a crashed launcher can be recovered on the
 * next checkpoint tick without permanently wedging the frozen queue.
 */
export const FROZEN_REPAIR_DISPATCH_RESERVATION_TTL_MS = 5 * 60 * 1_000;

const MAX_PERSISTED_FAILURES = 50;
const MAX_PERSISTED_FAILURE_CHARS = 500;

export type FrozenCandidateRepairPhase =
  | 'ready-to-test'
  | 'awaiting-fixer'
  | 'ready-to-verify'
  | 'ready-to-promote'
  | 'blocked';
export type FrozenCandidateBlockedReason = 'attempts-exhausted' | 'wall-clock-exhausted';

export interface FrozenRepairDispatchReservation {
  token: string;
  claimedAtMs: number;
  expiresAtMs: number;
}

export interface FrozenCandidateRepairQueue {
  schemaVersion: 1 | typeof FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION;
  phase: FrozenCandidateRepairPhase;
  /** The fixed C persisted before its first suite. Never moves for this queue entry. */
  candidate: string;
  /** The green pin observed when C was selected. */
  base: string | null;
  /** The head fixes move FORWARD from. Verification and promotion target this exact SHA. */
  repairHead: string;
  /** Initial gate process's PAPERCUSP_TEST_RUN_GROUP. Later verifiers keep their own runId;
   * this stable identity is only for affected-task proof reuse. Null means execute fully. */
  affectedTestProofGroup?: string | null;
  /** Gate-owned isolation path. Agents never switch the canonical shared checkout. */
  worktreePath: string;
  /** Number of fixer attempts actually dispatched (not reds observed or suites run). */
  attempts: number;
  openedAtMs: number;
  updatedAtMs: number;
  /** Current/last spawn. A completion from any other spawn is stale and rejected. */
  fixerSpawnId: string | null;
  /** Automation may stop, but the queue head remains immutable until it is green. */
  blockedReason?: FrozenCandidateBlockedReason;
  /** Short-lived CAS lease held only while one process launches this queue's fixer. */
  dispatchReservation?: FrozenRepairDispatchReservation;
  failingTests: string[];
}

export interface FrozenRepairQueueLimits {
  maxAttempts: number;
  maxAgeMs: number;
}

export type FrozenRepairQueueDecision =
  | {
      kind: 'run-normal-gate';
      runSuite: true;
      recordVerdict: true;
    }
  | {
      kind: 'test-candidate';
      candidate: string;
      gateDisposition: 'initial-candidate';
      runSuite: true;
      recordVerdict: true;
    }
  | {
      kind: 'dispatch-fixer';
      reason: 'unassigned' | 'fixer-dead';
      nextAttempt: number;
      repairHead: string;
      worktreePath: string;
      runSuite: false;
      recordVerdict: false;
    }
  | {
      kind: 'wait-for-fixer';
      fixerSpawnId: string;
      liveness: 'live' | 'unknown';
      gateDisposition: 'inconclusive';
      runSuite: false;
      recordVerdict: false;
    }
  | {
      kind: 'wait-for-dispatch-reservation';
      reservationToken: string;
      reservationExpiresAtMs: number;
      gateDisposition: 'inconclusive';
      runSuite: false;
      recordVerdict: false;
    }
  | {
      kind: 'verify-repair';
      candidate: string;
      originalCandidate: string;
      gateDisposition: 'repair-verification';
      runSuite: true;
      recordVerdict: true;
    }
  | {
      kind: 'inspect-staging-patch';
      candidate: string;
      originalCandidate: string;
      runSuite: false;
      recordVerdict: false;
    }
  | {
      kind: 'hold-staging-mismatch';
      candidate: string;
      originalCandidate: string;
      gateDisposition: 'inconclusive';
      runSuite: false;
      recordVerdict: false;
    }
  | {
      kind: 'promote-repair';
      candidate: string;
      originalCandidate: string;
      runSuite: false;
      recordVerdict: false;
    }
  | {
      kind: 'hold-exhausted';
      reason: FrozenCandidateBlockedReason;
      candidate: string;
      repairHead: string;
      gateDisposition: 'blocked';
      runSuite: false;
      recordVerdict: false;
    };

export interface FrozenRepairQueueObservation {
  nowMs: number;
  /** `null` means the liveness read failed; fail closed against duplicate dispatch. */
  fixerAlive?: boolean | null;
  /** Required only after a repair verified green. `null` means not measured yet. */
  stagingContainsRepair?: boolean | null;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseDispatchReservation(value: unknown): FrozenRepairDispatchReservation | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!nonBlank(row.token) || !validTimestamp(row.claimedAtMs) || !validTimestamp(row.expiresAtMs)) return null;
  if ((row.expiresAtMs as number) < (row.claimedAtMs as number)) return null;
  return {
    token: row.token,
    claimedAtMs: row.claimedAtMs as number,
    expiresAtMs: row.expiresAtMs as number,
  };
}

function assertTimestamp(value: number, label: string): void {
  if (!validTimestamp(value)) throw new Error(`${label} must be a finite non-negative timestamp`);
}

function assertLimits(limits: FrozenRepairQueueLimits): void {
  if (!Number.isInteger(limits.maxAttempts) || limits.maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer');
  }
  if (!Number.isFinite(limits.maxAgeMs) || limits.maxAgeMs <= 0) {
    throw new Error('maxAgeMs must be a positive finite duration');
  }
}

function boundedFailures(values: readonly string[]): string[] {
  return values
    .filter(nonBlank)
    .slice(0, MAX_PERSISTED_FAILURES)
    .map((value) => value.slice(0, MAX_PERSISTED_FAILURE_CHARS));
}

function requirePhase(queue: FrozenCandidateRepairQueue, phase: FrozenCandidateRepairPhase, operation: string): void {
  if (queue.phase !== phase) {
    throw new Error(`${operation} requires phase ${phase}; found ${queue.phase}`);
  }
}

function requireCurrentHead(queue: FrozenCandidateRepairQueue, repairHead: string): void {
  if (queue.repairHead !== repairHead) {
    throw new Error(`stale repair result for ${repairHead}; queue expects ${queue.repairHead}`);
  }
}

/** Persist the immutable candidate before its first suite. A process crash or moving staging
 * tip cannot replace it; the next gate invocation resumes this exact SHA. */
export function createFrozenCandidateQueue(input: {
  candidate: string;
  base: string | null;
  worktreePath: string;
  failingTests?: readonly string[];
  affectedTestProofGroup?: string | null;
  nowMs: number;
}): FrozenCandidateRepairQueue {
  if (!nonBlank(input.candidate)) throw new Error('candidate must be non-empty');
  if (input.base !== null && !nonBlank(input.base)) throw new Error('base must be null or non-empty');
  if (!nonBlank(input.worktreePath)) throw new Error('worktreePath must be non-empty');
  assertTimestamp(input.nowMs, 'nowMs');
  return {
    schemaVersion: FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION,
    phase: 'ready-to-test',
    candidate: input.candidate,
    base: input.base,
    repairHead: input.candidate,
    affectedTestProofGroup: nonBlank(input.affectedTestProofGroup)
      ? input.affectedTestProofGroup
      : null,
    worktreePath: input.worktreePath,
    attempts: 0,
    openedAtMs: input.nowMs,
    updatedAtMs: input.nowMs,
    fixerSpawnId: null,
    failingTests: boundedFailures(input.failingTests ?? []),
  };
}

/** Compatibility constructor for callers that first learn about the candidate at its red
 * verdict. New production orchestration persists through createFrozenCandidateQueue earlier. */
export function createFrozenCandidateRepairQueue(
  input: Parameters<typeof createFrozenCandidateQueue>[0],
): FrozenCandidateRepairQueue {
  return markFrozenCandidateVerificationRed(
    createFrozenCandidateQueue(input),
    { failingTests: input.failingTests, nowMs: input.nowMs },
  );
}

/** Parse a JSONB metadata value without letting a malformed queue steer the release gate. */
export function parseFrozenCandidateRepairQueue(value: unknown): FrozenCandidateRepairQueue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1 && row.schemaVersion !== 2 && row.schemaVersion !== FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION) return null;
  if (
    row.phase !== 'ready-to-test' &&
    row.phase !== 'awaiting-fixer' &&
    row.phase !== 'ready-to-verify' &&
    row.phase !== 'ready-to-promote' &&
    row.phase !== 'blocked'
  )
    return null;
  if (!nonBlank(row.candidate) || !nonBlank(row.repairHead) || !nonBlank(row.worktreePath)) {
    return null;
  }
  if (row.base !== null && !nonBlank(row.base)) return null;
  if (!Number.isInteger(row.attempts) || (row.attempts as number) < 0) return null;
  if (!validTimestamp(row.openedAtMs) || !validTimestamp(row.updatedAtMs)) return null;
  if ((row.updatedAtMs as number) < (row.openedAtMs as number)) return null;
  if (row.fixerSpawnId !== null && !nonBlank(row.fixerSpawnId)) return null;
  const dispatchReservation = parseDispatchReservation(row.dispatchReservation);
  if (dispatchReservation === null) return null;
  if (!Array.isArray(row.failingTests) || !row.failingTests.every((v) => typeof v === 'string')) {
    return null;
  }
  if ((row.phase === 'ready-to-verify' || row.phase === 'ready-to-promote') && (row.attempts as number) < 1)
    return null;
  if ((row.phase === 'ready-to-verify' || row.phase === 'ready-to-promote') && !nonBlank(row.fixerSpawnId))
    return null;
  const blockedReason =
    row.blockedReason === 'attempts-exhausted' || row.blockedReason === 'wall-clock-exhausted'
      ? row.blockedReason
      : undefined;
  if (row.phase === 'blocked' && !blockedReason) return null;
  return {
    schemaVersion: FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION,
    phase: row.phase,
    candidate: row.candidate,
    base: row.base as string | null,
    repairHead: row.repairHead,
    // v1/missing/malformed proof state keeps the queue valid but forces full execution.
    affectedTestProofGroup: nonBlank(row.affectedTestProofGroup)
      ? row.affectedTestProofGroup
      : null,
    worktreePath: row.worktreePath,
    attempts: row.attempts as number,
    openedAtMs: row.openedAtMs,
    updatedAtMs: row.updatedAtMs,
    fixerSpawnId: row.fixerSpawnId as string | null,
    ...(blockedReason ? { blockedReason } : {}),
    ...(dispatchReservation ? { dispatchReservation } : {}),
    failingTests: boundedFailures(row.failingTests as string[]),
  };
}

/** Decide the next orchestration step. A queue always wins over a moving staging tip. */
export function decideFrozenCandidateRepairQueue(
  queue: FrozenCandidateRepairQueue | null,
  observation: FrozenRepairQueueObservation,
  limits: FrozenRepairQueueLimits = DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS,
): FrozenRepairQueueDecision {
  assertTimestamp(observation.nowMs, 'nowMs');
  assertLimits(limits);
  if (!queue) return { kind: 'run-normal-gate', runSuite: true, recordVerdict: true };

  if (queue.phase === 'ready-to-test') {
    return {
      kind: 'test-candidate',
      candidate: queue.candidate,
      gateDisposition: 'initial-candidate',
      runSuite: true,
      recordVerdict: true,
    };
  }
  if (queue.phase === 'blocked') {
    return {
      kind: 'hold-exhausted',
      reason: queue.blockedReason!,
      candidate: queue.candidate,
      repairHead: queue.repairHead,
      gateDisposition: 'blocked',
      runSuite: false,
      recordVerdict: false,
    };
  }

  const ageMs = Math.max(0, observation.nowMs - queue.openedAtMs);
  // Going green inside the budget satisfies D-001 even if promotion bookkeeping crosses the
  // boundary a moment later. The normal promotion freshness checks still apply downstream.
  if (queue.phase !== 'ready-to-promote' && ageMs >= limits.maxAgeMs) {
    return {
      kind: 'hold-exhausted',
      reason: 'wall-clock-exhausted',
      candidate: queue.candidate,
      repairHead: queue.repairHead,
      gateDisposition: 'blocked',
      runSuite: false,
      recordVerdict: false,
    };
  }

  if (queue.phase === 'awaiting-fixer') {
    if (
      queue.dispatchReservation &&
      queue.dispatchReservation.expiresAtMs > observation.nowMs
    ) {
      return {
        kind: 'wait-for-dispatch-reservation',
        reservationToken: queue.dispatchReservation.token,
        reservationExpiresAtMs: queue.dispatchReservation.expiresAtMs,
        gateDisposition: 'inconclusive',
        runSuite: false,
        recordVerdict: false,
      };
    }
    if (!queue.fixerSpawnId || observation.fixerAlive === false) {
      if (queue.attempts >= limits.maxAttempts) {
        return {
          kind: 'hold-exhausted',
          reason: 'attempts-exhausted',
          candidate: queue.candidate,
          repairHead: queue.repairHead,
          gateDisposition: 'blocked',
          runSuite: false,
          recordVerdict: false,
        };
      }
      return {
        kind: 'dispatch-fixer',
        reason: queue.fixerSpawnId ? 'fixer-dead' : 'unassigned',
        nextAttempt: queue.attempts + 1,
        repairHead: queue.repairHead,
        worktreePath: queue.worktreePath,
        runSuite: false,
        recordVerdict: false,
      };
    }
    return {
      kind: 'wait-for-fixer',
      fixerSpawnId: queue.fixerSpawnId,
      liveness: observation.fixerAlive === true ? 'live' : 'unknown',
      gateDisposition: 'inconclusive',
      runSuite: false,
      recordVerdict: false,
    };
  }

  if (queue.phase === 'ready-to-verify') {
    return {
      kind: 'verify-repair',
      candidate: queue.repairHead,
      originalCandidate: queue.candidate,
      gateDisposition: 'repair-verification',
      runSuite: true,
      recordVerdict: true,
    };
  }

  if (observation.stagingContainsRepair == null) {
    return {
      kind: 'inspect-staging-patch',
      candidate: queue.repairHead,
      originalCandidate: queue.candidate,
      runSuite: false,
      recordVerdict: false,
    };
  }
  if (!observation.stagingContainsRepair) {
    return {
      kind: 'hold-staging-mismatch',
      candidate: queue.repairHead,
      originalCandidate: queue.candidate,
      gateDisposition: 'inconclusive',
      runSuite: false,
      recordVerdict: false,
    };
  }
  return {
    kind: 'promote-repair',
    candidate: queue.repairHead,
    originalCandidate: queue.candidate,
    runSuite: false,
    recordVerdict: false,
  };
}

/** A first red transitions the already-persisted candidate into repair without changing C. */
export function markFrozenCandidateVerificationRed(
  queue: FrozenCandidateRepairQueue,
  input: { failingTests?: readonly string[]; nowMs: number },
): FrozenCandidateRepairQueue {
  requirePhase(queue, 'ready-to-test', 'initial candidate red');
  assertTimestamp(input.nowMs, 'nowMs');
  return {
    ...queue,
    phase: 'awaiting-fixer',
    updatedAtMs: input.nowMs,
    failingTests: boundedFailures(input.failingTests ?? []),
  };
}

/** Stop automated churn while preserving the same immutable queue head. */
export function markFrozenRepairExhausted(
  queue: FrozenCandidateRepairQueue,
  input: { reason: FrozenCandidateBlockedReason; nowMs: number },
): FrozenCandidateRepairQueue {
  assertTimestamp(input.nowMs, 'nowMs');
  return {
    ...queue,
    phase: 'blocked',
    blockedReason: input.reason,
    updatedAtMs: input.nowMs,
    fixerSpawnId: null,
  };
}

/** Record a successful launch. Replacing a dead spawn is allowed; the decision helper owns the
 * liveness check and this transition owns the monotonically increasing attempt count. */
export function markFrozenRepairFixerDispatched(
  queue: FrozenCandidateRepairQueue,
  input: { spawnId: string; nowMs: number },
  limits: FrozenRepairQueueLimits = DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS,
): FrozenCandidateRepairQueue {
  requirePhase(queue, 'awaiting-fixer', 'fixer dispatch');
  if (!nonBlank(input.spawnId)) throw new Error('spawnId must be non-empty');
  assertTimestamp(input.nowMs, 'nowMs');
  assertLimits(limits);
  if (input.nowMs - queue.openedAtMs >= limits.maxAgeMs) {
    throw new Error('repair queue wall-clock budget is exhausted');
  }
  if (queue.attempts >= limits.maxAttempts) {
    throw new Error('repair queue attempt budget is exhausted');
  }
  return {
    ...queue,
    attempts: queue.attempts + 1,
    updatedAtMs: input.nowMs,
    fixerSpawnId: input.spawnId,
  };
}

/** Move forward only from the current spawn's completion. Late completions from replaced/dead
 * fixers cannot retarget verification onto a stale head. */
export function markFrozenRepairFixerFinished(
  queue: FrozenCandidateRepairQueue,
  input: { spawnId: string; repairHead: string; nowMs: number },
): FrozenCandidateRepairQueue {
  requirePhase(queue, 'awaiting-fixer', 'fixer completion');
  if (!nonBlank(input.repairHead)) throw new Error('repairHead must be non-empty');
  assertTimestamp(input.nowMs, 'nowMs');
  if (!queue.fixerSpawnId || queue.fixerSpawnId !== input.spawnId) {
    throw new Error(`stale fixer completion from ${input.spawnId}`);
  }
  return {
    ...queue,
    phase: 'ready-to-verify',
    repairHead: input.repairHead,
    updatedAtMs: input.nowMs,
  };
}

/** A red verification retries FORWARD from the head that was just tested; it never retreats to
 * a historical prefix and never adopts the moving staging tip. */
export function markFrozenRepairVerificationRed(
  queue: FrozenCandidateRepairQueue,
  input: { repairHead: string; failingTests?: readonly string[]; nowMs: number },
): FrozenCandidateRepairQueue {
  requirePhase(queue, 'ready-to-verify', 'red repair verification');
  requireCurrentHead(queue, input.repairHead);
  assertTimestamp(input.nowMs, 'nowMs');
  return {
    ...queue,
    phase: 'awaiting-fixer',
    updatedAtMs: input.nowMs,
    fixerSpawnId: null,
    failingTests: boundedFailures(input.failingTests ?? []),
  };
}

/** The repair head passed its focused fixer work, but canonical staging contains a
 * content-equivalent repair with different patch context. The exact reverse-apply guard
 * must continue to fail closed, while the queue must also remain live: return it to the
 * queue-authorized fixer path so the specialized release-fixer can align the isolated
 * worktree. Attempts remain bounded by the existing policy; exhaustion blocks automation
 * while retaining the same frozen queue head for operator repair. */
export function markFrozenRepairStagingMismatch(
  queue: FrozenCandidateRepairQueue,
  input: { repairHead: string; nowMs: number },
): FrozenCandidateRepairQueue {
  requirePhase(queue, 'ready-to-verify', 'staging-mismatch retry');
  requireCurrentHead(queue, input.repairHead);
  assertTimestamp(input.nowMs, 'nowMs');
  return {
    ...queue,
    phase: 'awaiting-fixer',
    updatedAtMs: input.nowMs,
    fixerSpawnId: null,
    failingTests: boundedFailures([
      FROZEN_REPAIR_STAGING_MISMATCH_SIGNATURE,
      ...queue.failingTests.filter((failure) => failure !== FROZEN_REPAIR_STAGING_MISMATCH_SIGNATURE),
    ]),
  };
}

/** A green verification makes only the exact tested head promotable. The separate staging-patch
 * decision remains mandatory before the caller can advance main. */
export function markFrozenRepairVerificationGreen(
  queue: FrozenCandidateRepairQueue,
  input: { repairHead: string; nowMs: number },
): FrozenCandidateRepairQueue {
  requirePhase(queue, 'ready-to-verify', 'green repair verification');
  requireCurrentHead(queue, input.repairHead);
  assertTimestamp(input.nowMs, 'nowMs');
  return {
    ...queue,
    phase: 'ready-to-promote',
    updatedAtMs: input.nowMs,
    failingTests: [],
  };
}
