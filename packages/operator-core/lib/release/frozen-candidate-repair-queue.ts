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
 * head; it never authorizes a newer moving-tip candidate — UNLESS `maxCandidateEscapes` is
 * raised above 0 (P-048, green-main-fast-2026-08-25), which permits a BOUNDED number of
 * exhausted pins to be abandoned in favour of a fresh tip cut.
 *
 * `maxCandidateEscapes: 0` is the historical refuse-to-re-cut behaviour and is deliberately
 * the default: raising it changes which commit the gate judges and promotes, for every
 * co-hosted install, with no deploy hop. It is therefore wired only as part of the
 * owner-gated Phase-2 activation batch, exactly like P-005..P-009. */
export const DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS = Object.freeze({
  maxAttempts: 3,
  maxAgeMs: 4 * 60 * 60 * 1_000,
  maxCandidateEscapes: 0,
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
  /**
   * Durable logical qualification that created this queue. A later, distinct
   * qualification may retire only a safe, unstarted queue bearing the exact
   * predecessor id; legacy queues omit it and therefore remain fail-closed.
   */
  qualificationAttemptId?: string | null;
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
  /** P-048: how many exhausted pins may be abandoned for a fresh tip cut. 0 disables the
   * escape hatch entirely and preserves the historical permanent hold. */
  maxCandidateEscapes: number;
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
      kind: 'recover-dead-fixer';
      fixerSpawnId: string;
      repairHead: string;
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
      /**
       * P-048: this pin is exhausted AND an escape is still budgeted — abandon it and let the
       * caller cut a fresh candidate at tip. Deliberately `runSuite:false` / `recordVerdict:false`:
       * abandoning a pin is not a verdict ON that pin, and recording one would let an escape be
       * misread as a judged red.
       */
      kind: 'recut-at-tip';
      reason: FrozenCandidateBlockedReason;
      abandonedCandidate: string;
      repairHead: string;
      /** 1-based: which escape this is. */
      escapeOrdinal: number;
      /** Escapes still budgeted AFTER this one; 0 means the next exhaustion holds forever. */
      remainingEscapes: number;
      gateDisposition: 'recut';
      runSuite: false;
      recordVerdict: false;
    }
  | {
      kind: 'hold-exhausted';
      reason: FrozenCandidateBlockedReason;
      candidate: string;
      repairHead: string;
      /**
       * P-048 observability: these two distinguish the only two ways to reach a permanent
       * hold — escapes DISABLED (`maxCandidateEscapes === 0`, the default) versus escapes
       * SPENT (`escapesUsed >= maxCandidateEscapes`). Without them a persistent red and a
       * switched-off escape hatch are indistinguishable at the surface.
       */
      escapesUsed: number;
      maxCandidateEscapes: number;
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
  /**
   * P-048: how many frozen candidates this gate has ALREADY abandoned, read by the caller
   * from durable gate health.
   *
   * It is an observation and not a queue field on purpose. An escape DISCARDS the queue, so a
   * counter living on the queue row would reset to 0 on every escape and the bound would never
   * bind — producing exactly the unbounded re-cut churn the bound exists to prevent. Absent or
   * negative is read as 0.
   */
  priorEscapes?: number;
}

export interface FrozenRepairQueueDiagnostic {
  phase: FrozenCandidateRepairPhase;
  candidate: string;
  repairHead: string;
  attempts: number;
  openedAtMs: number;
  updatedAtMs: number;
  ageMs: number;
  maxAgeMs: number;
  ageExpired: boolean;
  /** P-048 gate-health surface: escapes already spent, the ceiling, and whether an exhausted
   * pin would still be allowed to re-cut. `escapeAvailable:false` with `maxCandidateEscapes:0`
   * reads as "hatch disabled"; with a nonzero ceiling it reads as "budget spent". */
  escapesUsed: number;
  maxCandidateEscapes: number;
  escapeAvailable: boolean;
  fixerSpawnId: string | null;
  fixerAlive: boolean | null;
  dispatchReservation: {
    token: string;
    claimedAtMs: number;
    expiresAtMs: number;
    active: boolean;
  } | null;
  decision: FrozenRepairQueueDecision['kind'];
  retireAllowed: boolean;
  retireRefusal: 'live-fixer' | 'liveness-unknown' | 'active-dispatch-reservation' | 'unsafe-phase' | null;
  nextAction: string | null;
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
  if (!Number.isInteger(limits.maxCandidateEscapes) || limits.maxCandidateEscapes < 0) {
    throw new Error('maxCandidateEscapes must be a non-negative integer');
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
  qualificationAttemptId?: string | null;
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
    qualificationAttemptId: nonBlank(input.qualificationAttemptId)
      ? input.qualificationAttemptId
      : null,
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
  if (row.qualificationAttemptId != null && !nonBlank(row.qualificationAttemptId)) return null;
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
    qualificationAttemptId: nonBlank(row.qualificationAttemptId)
      ? row.qualificationAttemptId
      : null,
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
/**
 * P-048 — the ONE policy point for "this pin is exhausted; now what?".
 *
 * Every exhaustion path used to return `hold-exhausted`, which retains the pin as queue head
 * indefinitely. That is a deadlock rather than a flake: replacing the head requires a green,
 * and an exhausted pin is by construction one that could not produce a green. The class is
 * evidenced — main's last green commit is titled "Repair frozen candidate f9030aa73955", i.e.
 * a human has already broken this deadlock by hand at least once.
 *
 * `maxCandidateEscapes` is what keeps the hatch from trading a deadlock for unbounded churn.
 * An escape re-cuts at tip; if the red is a GENUINE persistent regression still present at tip,
 * the fresh candidate reds too, exhausts too, and the budget is spent — after which the gate
 * holds permanently and the red surfaces. So the bound is precisely the property that stops a
 * real red being laundered into perpetual re-cutting.
 *
 * Centralized rather than inlined at each of the three exhaustion sites so the escape budget
 * cannot be enforced at two of them and silently skipped at the third.
 */
function decideExhaustedPin(
  queue: FrozenCandidateRepairQueue,
  observation: FrozenRepairQueueObservation,
  limits: FrozenRepairQueueLimits,
  reason: FrozenCandidateBlockedReason,
): FrozenRepairQueueDecision {
  const escapesUsed = Math.max(0, Math.trunc(observation.priorEscapes ?? 0));
  const { maxCandidateEscapes } = limits;
  if (maxCandidateEscapes > 0 && escapesUsed < maxCandidateEscapes) {
    return {
      kind: 'recut-at-tip',
      reason,
      abandonedCandidate: queue.candidate,
      repairHead: queue.repairHead,
      escapeOrdinal: escapesUsed + 1,
      remainingEscapes: maxCandidateEscapes - escapesUsed - 1,
      gateDisposition: 'recut',
      runSuite: false,
      recordVerdict: false,
    };
  }
  return {
    kind: 'hold-exhausted',
    reason,
    candidate: queue.candidate,
    repairHead: queue.repairHead,
    escapesUsed,
    maxCandidateEscapes,
    gateDisposition: 'blocked',
    runSuite: false,
    recordVerdict: false,
  };
}

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
    // The load-bearing escape site: a queue PERSISTED as blocked is the steady state of the
    // deadlock, so an escape budget that skipped this branch would only ever help a queue that
    // happened to exhaust during the current tick.
    return decideExhaustedPin(queue, observation, limits, queue.blockedReason!);
  }

  // A dispatch lease serializes launchers; it is not liveness authority for a fixer that
  // already exists. Recover the definitively-dead fixer first so a stale lease cannot hide
  // its finished worktree or wedge the queue until expiry. The caller persists the recovered
  // state, then re-runs this policy so the normal age/attempt limits still decide whether a
  // replacement may launch.
  if (
    queue.phase === 'awaiting-fixer' &&
    queue.fixerSpawnId &&
    observation.fixerAlive === false
  ) {
    return {
      kind: 'recover-dead-fixer',
      fixerSpawnId: queue.fixerSpawnId,
      repairHead: queue.repairHead,
      runSuite: false,
      recordVerdict: false,
    };
  }

  const ageMs = Math.max(0, observation.nowMs - queue.openedAtMs);
  // Going green inside the budget satisfies D-001 even if promotion bookkeeping crosses the
  // boundary a moment later. The normal promotion freshness checks still apply downstream.
  if (queue.phase !== 'ready-to-promote' && ageMs >= limits.maxAgeMs) {
    return decideExhaustedPin(queue, observation, limits, 'wall-clock-exhausted');
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
        return decideExhaustedPin(queue, observation, limits, 'attempts-exhausted');
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

/** One normalized, bounded read model shared by every release diagnostic surface. */
export function diagnoseFrozenCandidateRepairQueue(
  queue: FrozenCandidateRepairQueue | null,
  observation: FrozenRepairQueueObservation,
  limits: FrozenRepairQueueLimits = DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS,
): FrozenRepairQueueDiagnostic | null {
  if (!queue) return null;
  const decision = decideFrozenCandidateRepairQueue(queue, observation, limits);
  const ageMs = Math.max(0, observation.nowMs - queue.openedAtMs);
  const escapesUsed = Math.max(0, Math.trunc(observation.priorEscapes ?? 0));
  const reservation = queue.dispatchReservation
    ? {
        ...queue.dispatchReservation,
        active: queue.dispatchReservation.expiresAtMs > observation.nowMs,
      }
    : null;
  const fixerAlive = queue.fixerSpawnId ? (observation.fixerAlive ?? null) : null;
  const safePhase = queue.phase === 'awaiting-fixer' || queue.phase === 'blocked';
  const retireRefusal = !safePhase
    ? 'unsafe-phase'
    : reservation?.active
      ? 'active-dispatch-reservation'
      : queue.fixerSpawnId && fixerAlive === true
        ? 'live-fixer'
        : queue.fixerSpawnId && fixerAlive === null
          ? 'liveness-unknown'
          : null;
  const retireAllowed = retireRefusal === null;
  const nextAction = retireAllowed
    ? `release:repair-queue { op: 'retire', expectedCandidate: '${queue.candidate}', expectedRepairHead: '${queue.repairHead}', expectedUpdatedAtMs: ${queue.updatedAtMs}, reason: '<why this exact non-live queue is terminal>', confirm: true }`
    : null;
  return {
    phase: queue.phase,
    candidate: queue.candidate,
    repairHead: queue.repairHead,
    attempts: queue.attempts,
    openedAtMs: queue.openedAtMs,
    updatedAtMs: queue.updatedAtMs,
    ageMs,
    maxAgeMs: limits.maxAgeMs,
    ageExpired: ageMs >= limits.maxAgeMs,
    escapesUsed,
    maxCandidateEscapes: limits.maxCandidateEscapes,
    escapeAvailable:
      limits.maxCandidateEscapes > 0 && escapesUsed < limits.maxCandidateEscapes,
    fixerSpawnId: queue.fixerSpawnId,
    fixerAlive,
    dispatchReservation: reservation,
    decision: decision.kind,
    retireAllowed,
    retireRefusal,
    nextAction,
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

/** Persist recovery of a definitively-dead fixer before age/reservation policy runs again. */
export function markFrozenRepairFixerDead(
  queue: FrozenCandidateRepairQueue,
  input: { spawnId: string; nowMs: number },
): FrozenCandidateRepairQueue {
  requirePhase(queue, 'awaiting-fixer', 'mark fixer dead');
  assertTimestamp(input.nowMs, 'nowMs');
  if (queue.fixerSpawnId !== input.spawnId) {
    throw new Error(`stale fixer death for ${input.spawnId}; queue expects ${queue.fixerSpawnId ?? 'none'}`);
  }
  const { dispatchReservation: _reservation, ...withoutReservation } = queue;
  return {
    ...withoutReservation,
    fixerSpawnId: null,
    updatedAtMs: input.nowMs,
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
