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
/* `maxAgeMs` was 4h until 2026-08-27 [owner:aviynw8 2026-08-27, approved in-session].
 * WHY IT MOVED (WI-85288): the 4h budget was calibrated against fixers that never ran.
 * From 2026-08-24 16:57Z to 2026-08-27, EVERY dispatched release-fixer was SIGTERM'd at
 * exactly 300000ms by the release-fixer first-turn guard — measured lifetimes 301/301/300/301s
 * across four consecutive attempts, versus 31 healthy 'exited' runs averaging 1118s before
 * that cutoff. So a repair could burn all 3 attempts in ~15 minutes of wall clock and still
 * never produce a commit, and 4h never had to accommodate a fixer that actually worked.
 * With that guard fixed, a real fixer needs ~17min and the queue must outlive: dispatch +
 * fixer run + the NEXT hourly gate tick that verifies its commit. 4h could not: the
 * d513ccbc repair opened 09:24:23Z, its budget expired 13:24:23Z, and a live, healthy fixer
 * dispatched at 13:23:19Z was already inside a queue reading `hold-exhausted` — its commit
 * would have been discarded unverified at the 14:22:37Z evaluation.
 * 8h covers dispatch + a full fixer run + up to two hourly verification ticks.
 * NOT CHANGED: maxAttempts and maxCandidateEscapes: 0 (still the owner-gated Phase-2 lever
 * described above — raising it changes which commit the gate promotes, for every install). */
export const DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS = Object.freeze({
  maxAttempts: 3,
  maxAgeMs: 8 * 60 * 60 * 1_000,
  maxCandidateEscapes: 0,
});

/**
 * A queue dispatch is an external side effect, so the metadata row needs a short-lived
 * ownership lease around the read -> launch -> finalize window.  The lease is deliberately
 * much shorter than the four-hour repair budget: a crashed launcher can be recovered on the
 * next checkpoint tick without permanently wedging the frozen queue.
 */
export const FROZEN_REPAIR_DISPATCH_RESERVATION_TTL_MS = 5 * 60 * 1_000;

/**
 * A freshly-created queue can legitimately spend a short interval at zero attempts while the
 * checkpoint moves from the red verdict to dispatch. Past this bound, zero attempts means no
 * fixer ever started — categorically different from a fixer that ran and failed.
 */
export const FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS = 15 * 60 * 1_000;

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
  /**
   * P-013 / D-007 observability. `failingTests` is REPLACED on every red, so by the time a
   * reader asks "is this cycle converging?" the only evidence that it was ever larger is
   * gone. Each red appends one round here so the shrink across a convergence cycle survives.
   *
   * Optional and additive: legacy queues (and any queue that has not yet taken a red under
   * this build) parse with it absent, which reads as "no rounds recorded" — never as a
   * cycle that failed to converge.
   */
  convergenceRounds?: readonly FrozenRepairConvergenceRound[];
}

/**
 * One observed red for a single frozen-candidate convergence cycle. Deliberately a COUNT and
 * not the failing set: the full set already lives in `failingTests` for the current round,
 * and persisting N copies of a 50-entry list is how a metadata blob becomes unbounded.
 */
export interface FrozenRepairConvergenceRound {
  /** 1-based position within this queue's cycle. Stable across cap-trimming (see below). */
  round: number;
  /** The head that was verified red for this round. */
  head: string;
  /** Size of the failing set observed at this round. */
  failingCount: number;
  atMs: number;
}

/**
 * Rounds are capped so a long cycle cannot grow the persisted queue without bound. The FIRST
 * round is retained on purpose even when trimming: it is the baseline every shrink figure is
 * measured against, so dropping it (the obvious ring-buffer behaviour) would silently destroy
 * the one number this field exists to produce.
 */
export const FROZEN_REPAIR_CONVERGENCE_ROUND_CAP = 24;

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
  | FrozenRepairDispatchInfeasibleDecision
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

export interface FrozenRepairDispatchInfeasibleDecision {
  kind: 'recut-at-tip';
  reason: 'dispatch-infeasible';
  abandonedCandidate: string;
  repairHead: string;
  attempts: number;
  ageMs: number;
  zeroAttemptStalled: boolean;
  zeroAttemptStallMs: number;
  gateDisposition: 'recut';
  runSuite: false;
  recordVerdict: false;
}

export interface FrozenRepairQueueObservation {
  nowMs: number;
  /** `null` means the liveness read failed; fail closed against duplicate dispatch. */
  fixerAlive?: boolean | null;
  /** `false` is a fresh, measured proof that no fixer can be dispatched right now. */
  dispatchFeasible?: boolean | null;
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
  /**
   * P-009: repo-relative paths currently EDITED in the canonical shared checkout, as the
   * caller measured them (e.g. `git status --porcelain` over the staging tree).
   *
   * Optional and nullable on purpose, and the two mean DIFFERENT things: `undefined`/`null`
   * is "not measured" and must never render as "no collision". A missing measurement that
   * reads as a clean zero is precisely how a report-only guard becomes a false all-clear.
   */
  sharedTreeEditedPaths?: readonly string[] | null;
}

/**
 * P-009 (REPORT-ONLY): a frozen-candidate repair is in flight AND its failing paths are being
 * edited in the shared checkout.
 *
 * Why this is a hazard rather than a style complaint: the gate promotes an isolated repair only
 * after the exact patch is observed on staging (release-actions.ts:3831). So a shared-tree edit
 * to one of the frozen candidate's failing paths that diverges from the repair worktree does not
 * fail loudly — it silently withholds promotion, which reads as "the repair did not work".
 */
export interface FrozenRepairSharedTreeCollision {
  /** false ⇒ the caller supplied no measurement. NOT the same as zero colliding paths. */
  measured: boolean;
  /** Whether a repair is actually in flight; a collision is only meaningful when it is. */
  repairInFlight: boolean;
  /** Sorted intersection of the queue's failing paths with the edited shared-tree paths. */
  collidingPaths: string[];
  /** Full intersection size, independent of the `collidingPaths` display cap. */
  collisionCount: number;
  /** True when `collidingPaths` was capped and therefore under-lists `collisionCount`. */
  truncated: boolean;
  /** The loud line, or null when there is nothing to say. */
  detail: string | null;
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
  /** True only after an unassigned zero-attempt queue outlives the normal dispatch window. */
  zeroAttemptStalled: boolean;
  zeroAttemptStallMs: number;
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
  /**
   * P-009, REPORT-ONLY. This field is reported and nothing else: it must never feed `decision`,
   * `retireAllowed`, `retireRefusal` or `nextAction`. The plan asks for detection first so the
   * signal can be trusted before anything is allowed to block on it.
   */
  sharedTreeCollision: FrozenRepairSharedTreeCollision;
}

/**
 * Measured dispatch infeasibility is not a candidate verdict and must not hold an immutable pin.
 * The caller retires the queue and falls through to the current staging tip. This policy is
 * deliberately independent of `maxCandidateEscapes`: that budget bounds failed REPAIR attempts,
 * while this branch proves no repair attempt can begin at all.
 */
export function decideFrozenRepairDispatchInfeasible(
  queue: FrozenCandidateRepairQueue,
  observation: { nowMs: number; zeroAttemptStallMs?: number },
): FrozenRepairDispatchInfeasibleDecision {
  assertTimestamp(observation.nowMs, 'nowMs');
  const zeroAttemptStallMs = observation.zeroAttemptStallMs ?? FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS;
  if (!Number.isFinite(zeroAttemptStallMs) || zeroAttemptStallMs <= 0) {
    throw new Error('zeroAttemptStallMs must be a positive finite duration');
  }
  if (queue.phase !== 'awaiting-fixer' || queue.fixerSpawnId !== null || queue.dispatchReservation !== undefined) {
    throw new Error('dispatch infeasibility requires an unassigned awaiting-fixer queue without a reservation');
  }
  const ageMs = Math.max(0, observation.nowMs - queue.openedAtMs);
  return {
    kind: 'recut-at-tip',
    reason: 'dispatch-infeasible',
    abandonedCandidate: queue.candidate,
    repairHead: queue.repairHead,
    attempts: queue.attempts,
    ageMs,
    zeroAttemptStalled: queue.attempts === 0 && ageMs >= zeroAttemptStallMs,
    zeroAttemptStallMs,
    gateDisposition: 'recut',
    runSuite: false,
    recordVerdict: false,
  };
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

function parseConvergenceRounds(value: unknown): FrozenRepairConvergenceRound[] {
  if (!Array.isArray(value)) return [];
  const rounds: FrozenRepairConvergenceRound[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (!Number.isInteger(row.round) || (row.round as number) < 1) continue;
    if (!nonBlank(row.head)) continue;
    if (!Number.isInteger(row.failingCount) || (row.failingCount as number) < 0) continue;
    if (!validTimestamp(row.atMs)) continue;
    rounds.push({
      round: row.round as number,
      head: row.head,
      failingCount: row.failingCount as number,
      atMs: row.atMs as number,
    });
  }
  return capConvergenceRounds(rounds);
}

/**
 * Trim to the cap while ALWAYS retaining the first round. A plain `.slice(-cap)` would drop
 * the baseline the shrink is measured against, so a long cycle would report `shrinkTotal:
 * null` exactly when the convergence question matters most.
 */
function capConvergenceRounds(rounds: readonly FrozenRepairConvergenceRound[]): FrozenRepairConvergenceRound[] {
  if (rounds.length <= FROZEN_REPAIR_CONVERGENCE_ROUND_CAP) return [...rounds];
  const first = rounds[0] as FrozenRepairConvergenceRound;
  return [first, ...rounds.slice(-(FROZEN_REPAIR_CONVERGENCE_ROUND_CAP - 1))];
}

/**
 * Append the round this red represents. `round` numbers keep counting from the highest one
 * already recorded, so cap-trimming never renumbers history or makes two rounds share an
 * index.
 */
function appendConvergenceRound(
  queue: FrozenCandidateRepairQueue,
  input: { head: string; failingTests: readonly string[]; nowMs: number },
): FrozenRepairConvergenceRound[] {
  const existing = queue.convergenceRounds ?? [];
  const highest = existing.reduce((max, entry) => (entry.round > max ? entry.round : max), 0);
  return capConvergenceRounds([
    ...existing,
    {
      round: highest + 1,
      head: input.head,
      failingCount: boundedFailures(input.failingTests).length,
      atMs: input.nowMs,
    },
  ]);
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
    qualificationAttemptId: nonBlank(input.qualificationAttemptId) ? input.qualificationAttemptId : null,
    base: input.base,
    repairHead: input.candidate,
    affectedTestProofGroup: nonBlank(input.affectedTestProofGroup) ? input.affectedTestProofGroup : null,
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
  return markFrozenCandidateVerificationRed(createFrozenCandidateQueue(input), {
    failingTests: input.failingTests,
    nowMs: input.nowMs,
  });
}

/** Parse a JSONB metadata value without letting a malformed queue steer the release gate. */
export function parseFrozenCandidateRepairQueue(value: unknown): FrozenCandidateRepairQueue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.schemaVersion !== 1 &&
    row.schemaVersion !== 2 &&
    row.schemaVersion !== FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION
  )
    return null;
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
  if ((row.phase === 'ready-to-verify' || row.phase === 'ready-to-promote') && !nonBlank(row.fixerSpawnId)) return null;
  /**
   * Rounds are OBSERVABILITY, not safety, so a malformed value is dropped rather than
   * failing the whole parse. The queue itself is the gate's safety state — refusing to
   * parse a live queue because a display-only history entry is corrupt would discard the
   * frozen head and let the treadmill D-007 exists to stop resume. Losing the history is
   * the strictly smaller failure, and it is visible (rounds read as absent).
   */
  const convergenceRounds = parseConvergenceRounds(row.convergenceRounds);
  const blockedReason =
    row.blockedReason === 'attempts-exhausted' || row.blockedReason === 'wall-clock-exhausted'
      ? row.blockedReason
      : undefined;
  if (row.phase === 'blocked' && !blockedReason) return null;
  return {
    schemaVersion: FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION,
    phase: row.phase,
    candidate: row.candidate,
    qualificationAttemptId: nonBlank(row.qualificationAttemptId) ? row.qualificationAttemptId : null,
    base: row.base as string | null,
    repairHead: row.repairHead,
    // v1/missing/malformed proof state keeps the queue valid but forces full execution.
    affectedTestProofGroup: nonBlank(row.affectedTestProofGroup) ? row.affectedTestProofGroup : null,
    worktreePath: row.worktreePath,
    attempts: row.attempts as number,
    openedAtMs: row.openedAtMs,
    updatedAtMs: row.updatedAtMs,
    fixerSpawnId: row.fixerSpawnId as string | null,
    ...(blockedReason ? { blockedReason } : {}),
    ...(dispatchReservation ? { dispatchReservation } : {}),
    ...(convergenceRounds.length > 0 ? { convergenceRounds } : {}),
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
  if (queue.phase === 'awaiting-fixer' && queue.fixerSpawnId && observation.fixerAlive === false) {
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
    // A measured provider wall with no fixer ever dispatched is a structural dead end, not an
    // inconclusive repair. Retire this queue and let the caller re-triage the current tip. A
    // queue with prior attempts remains on the ordinary bounded-repair path; those attempts are
    // evidence that dispatch was feasible at least once and must not be silently discarded.
    if (
      observation.dispatchFeasible === false &&
      queue.attempts === 0 &&
      queue.fixerSpawnId === null &&
      !queue.dispatchReservation
    ) {
      return decideFrozenRepairDispatchInfeasible(queue, observation);
    }
    if (queue.dispatchReservation && queue.dispatchReservation.expiresAtMs > observation.nowMs) {
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
/** How many colliding paths the report lists inline before it says it capped them. */
export const FROZEN_REPAIR_COLLISION_PATH_DISPLAY_CAP = 20;

/** Compare paths without tripping over `./` prefixes or Windows separators. */
function normalizeRepoPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * P-009 (REPORT-ONLY): does a repair in flight overlap edits in the shared checkout?
 *
 * "In flight" is every phase EXCEPT `ready-to-test`. `ready-to-test` is deliberately excluded
 * because no repair exists yet — the candidate has not even had its first suite, so an edit
 * there races nothing. `blocked` is deliberately INCLUDED: automation has stopped but the queue
 * head remains immutable until it is green, so an edit to a failing path is if anything more
 * dangerous there, because no fixer is watching for it.
 *
 * Exported so the collision rule is unit-testable without constructing a whole diagnostic.
 */
export function detectFrozenRepairSharedTreeCollision(
  queue: FrozenCandidateRepairQueue | null,
  editedPaths: readonly string[] | null | undefined,
): FrozenRepairSharedTreeCollision {
  const repairInFlight = queue !== null && queue.phase !== 'ready-to-test';
  // Distinguish "not measured" from "measured, found nothing" — a guard that cannot tell
  // those apart reports a false all-clear exactly when the measurement broke.
  if (editedPaths === null || editedPaths === undefined) {
    return {
      measured: false,
      repairInFlight,
      collidingPaths: [],
      collisionCount: 0,
      truncated: false,
      detail: repairInFlight
        ? `frozen-repair collision: NOT MEASURED — a repair is in flight for ${queue!.candidate.slice(0, 12)} ` +
          `but no shared-checkout edit set was supplied, so this is not an all-clear.`
        : null,
    };
  }

  if (!repairInFlight) {
    return {
      measured: true,
      repairInFlight: false,
      collidingPaths: [],
      collisionCount: 0,
      truncated: false,
      detail: null,
    };
  }

  const edited = new Set(editedPaths.map(normalizeRepoPath).filter((p) => p.length > 0));
  const colliding = [
    ...new Set(queue!.failingTests.map(normalizeRepoPath).filter((p) => p.length > 0 && edited.has(p))),
  ].sort();

  if (colliding.length === 0) {
    return {
      measured: true,
      repairInFlight: true,
      collidingPaths: [],
      collisionCount: 0,
      truncated: false,
      detail: null,
    };
  }

  const shown = colliding.slice(0, FROZEN_REPAIR_COLLISION_PATH_DISPLAY_CAP);
  const truncated = colliding.length > shown.length;
  return {
    measured: true,
    repairInFlight: true,
    collidingPaths: shown,
    collisionCount: colliding.length,
    truncated,
    detail:
      `⚠ FROZEN-REPAIR COLLISION: ${colliding.length} of the frozen candidate's failing path(s) ` +
      `are edited in the SHARED checkout while repair ${queue!.candidate.slice(0, 12)} is in flight ` +
      `at head ${queue!.repairHead.slice(0, 12)} (phase ${queue!.phase}). ` +
      `The gate promotes this repair ONLY after the exact patch is observed on staging, so a shared-tree ` +
      `edit that diverges from ${queue!.worktreePath} does not fail loudly — it silently withholds ` +
      `promotion and reads as "the repair did not work". Author the fix in that worktree; editing the ` +
      `shared checkout is NOT admission. Colliding: ${shown.join(', ')}` +
      (truncated
        ? ` …and ${colliding.length - shown.length} more (list capped at ${FROZEN_REPAIR_COLLISION_PATH_DISPLAY_CAP})`
        : ''),
  };
}

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
  const zeroAttemptStalled =
    queue.phase === 'awaiting-fixer' &&
    queue.attempts === 0 &&
    queue.fixerSpawnId === null &&
    !(reservation?.active ?? false) &&
    ageMs >= FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS;
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
    zeroAttemptStalled,
    zeroAttemptStallMs: FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS,
    escapesUsed,
    maxCandidateEscapes: limits.maxCandidateEscapes,
    escapeAvailable: limits.maxCandidateEscapes > 0 && escapesUsed < limits.maxCandidateEscapes,
    fixerSpawnId: queue.fixerSpawnId,
    fixerAlive,
    dispatchReservation: reservation,
    decision: decision.kind,
    retireAllowed,
    retireRefusal,
    nextAction,
    // P-009 REPORT-ONLY: computed from the queue + observation and attached to the report.
    // Deliberately NOT consulted by `decision`, `retireAllowed`, `retireRefusal` or
    // `nextAction` above — all four are already final by this point.
    sharedTreeCollision: detectFrozenRepairSharedTreeCollision(queue, observation.sharedTreeEditedPaths),
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
    convergenceRounds: appendConvergenceRound(queue, {
      head: queue.repairHead,
      failingTests: input.failingTests ?? [],
      nowMs: input.nowMs,
    }),
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
    convergenceRounds: appendConvergenceRound(queue, {
      head: input.repairHead,
      failingTests: input.failingTests ?? [],
      nowMs: input.nowMs,
    }),
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

/**
 * P-013 / D-007: what a reader needs to answer "is this convergence cycle actually
 * converging, or is it a treadmill wearing a queue's clothes?" — projected into
 * `gate_health` so it is legible without reconstructing the queue's history by hand.
 *
 * PURE and derived: every field is computed from the queue that is already persisted, so
 * this cannot disagree with the queue, and adding it stores no new authority.
 */
export interface FrozenRepairConvergenceSummary {
  /** When this cycle opened — the D-007 "cycle opened-at". */
  openedAtMs: number;
  ageMs: number;
  /** Fixer dispatches actually made (mirrors `queue.attempts`). */
  attempts: number;
  /** Recorded red rounds. 0 means none observed under this build, NOT a stalled cycle. */
  admissionRounds: number;
  /** Failing-set size at the first recorded round; null when no round is recorded. */
  failingFirst: number | null;
  /** Failing-set size right now, straight off the live queue. */
  failingNow: number;
  /** failingFirst - failingNow. Positive = shrinking. Null when there is no baseline. */
  shrinkTotal: number | null;
  /** Per-round size and the delta from the previous round (negative = shrank). */
  shrinkPerRound: readonly { round: number; failingCount: number; delta: number | null }[];
  /**
   * True only when every recorded round is <= the one before it AND the set actually got
   * smaller overall. Null when fewer than two rounds are recorded — deliberately NOT false,
   * because "not yet knowable" and "not converging" are different answers and a reader that
   * conflates them will call a healthy new cycle a treadmill.
   */
  converging: boolean | null;
}

export function summarizeFrozenRepairConvergence(
  queue: FrozenCandidateRepairQueue,
  nowMs: number,
): FrozenRepairConvergenceSummary {
  const rounds = queue.convergenceRounds ?? [];
  const failingNow = queue.failingTests.length;
  const failingFirst = rounds.length > 0 ? (rounds[0] as FrozenRepairConvergenceRound).failingCount : null;
  const shrinkPerRound = rounds.map((entry, index) => ({
    round: entry.round,
    failingCount: entry.failingCount,
    delta: index === 0 ? null : entry.failingCount - (rounds[index - 1] as FrozenRepairConvergenceRound).failingCount,
  }));
  const monotonic = shrinkPerRound.every((entry) => entry.delta === null || entry.delta <= 0);
  const shrinkTotal = failingFirst === null ? null : failingFirst - failingNow;
  return {
    openedAtMs: queue.openedAtMs,
    ageMs: Math.max(0, nowMs - queue.openedAtMs),
    attempts: queue.attempts,
    admissionRounds: rounds.length,
    failingFirst,
    failingNow,
    shrinkTotal,
    shrinkPerRound,
    converging: rounds.length < 2 ? null : monotonic && (shrinkTotal ?? 0) > 0,
  };
}

/**
 * The D-007 default and its owner-visible off switch, as one pure decision.
 *
 * `freeze-and-converge` — a first REAL red freezes that candidate and converges it — is
 * ALREADY the deployed default (verified in green-checkpoint.ts: a red with no live queue
 * calls `createFrozenCandidateRepairQueue` with no streak threshold in front of it). So this
 * does not flip a default ON; it gives the owner a way to turn it OFF, which is the half
 * D-007 asked for and the half that did not exist.
 *
 * OFF restores the pre-D-001 behaviour: a red does not open a cycle, and the gate re-cuts at
 * tip. That is the treadmill D-007 diagnosed, which is exactly why the switch is explicit,
 * owner-visible, and defaults ON rather than being a quiet constant.
 */
export type FrozenConvergenceCycleEntry =
  | { kind: 'open-cycle'; reason: 'first-real-red' }
  | { kind: 'advance-existing-cycle'; reason: 'queue-already-open' }
  | { kind: 'suppressed'; reason: 'off-switch-disabled' };

export function decideFrozenConvergenceCycleEntry(input: {
  /** FLAGS.RELEASE_FREEZE_AND_CONVERGE_DEFAULT, read by the caller's io seam. */
  flagEnabled: boolean;
  hasOpenQueue: boolean;
}): FrozenConvergenceCycleEntry {
  // An ALREADY-OPEN cycle is never suppressed by the switch. Turning the default off must
  // stop NEW cycles opening; abandoning a frozen candidate that is mid-convergence would
  // strand its repair worktree and un-freeze a head the gate already committed to.
  if (input.hasOpenQueue) return { kind: 'advance-existing-cycle', reason: 'queue-already-open' };
  if (!input.flagEnabled) return { kind: 'suppressed', reason: 'off-switch-disabled' };
  return { kind: 'open-cycle', reason: 'first-real-red' };
}

/**
 * The shape persisted at `gate_health.convergence` — {@link FrozenRepairConvergenceSummary}
 * plus the identity and write-time stamp a READER needs, which the summary alone cannot
 * supply.
 *
 * Both additions exist to kill a specific misreading:
 *
 * - `candidate` / `repairHead` / `phase`: `gate_health` is a long-lived blob whose fields are
 *   written by several code paths at different times. Convergence figures with no cycle
 *   identity on them read as describing whatever candidate the reader is currently looking
 *   at, which is exactly wrong the moment a cycle is retired and a new one opens.
 * - `observedAtMs`: a shrink figure is a measurement, and a measurement with no timestamp
 *   cannot be told apart from a current one. Readers that care about freshness compare it
 *   themselves; nothing here expires it, because a stale reading that is LABELLED stale is
 *   useful and one that silently disappears is not.
 */
export interface StoredFrozenRepairConvergence extends FrozenRepairConvergenceSummary {
  candidate: string;
  repairHead: string;
  phase: FrozenCandidateRepairPhase;
  observedAtMs: number;
}

/**
 * PURE: the exact object the queue writer projects into `gate_health.convergence`.
 *
 * Derived wholly from the queue that is being persisted in the same statement, so the
 * projection cannot disagree with the queue it describes and stores no new authority — it is
 * a rendering of `repair_queue`, not a second copy of it. See the derived-truth ladder in the
 * repo guide: this is rung 1 (DERIVE), which is why there is no separate writer for it.
 */
export function buildFrozenRepairConvergenceGateHealth(
  queue: FrozenCandidateRepairQueue,
  nowMs: number,
): StoredFrozenRepairConvergence {
  return {
    ...summarizeFrozenRepairConvergence(queue, nowMs),
    candidate: queue.candidate,
    repairHead: queue.repairHead,
    phase: queue.phase,
    observedAtMs: nowMs,
  };
}

/**
 * PURE: interpret the raw `gate_health.convergence` value a snapshot read got back from PG.
 *
 * Returns `null` for anything not trustworthy — absent, JSON null (how the writer CLEARS it
 * when a cycle retires), or a shape this reader does not recognize. A partially-recognized
 * blob is rejected outright rather than rendered with holes: a convergence panel showing
 * `failingFirst: undefined` invites the reader to treat "unreadable" as "no baseline", which
 * is the false all-clear this whole item exists to prevent.
 */
export function parseFrozenRepairConvergence(raw: unknown): StoredFrozenRepairConvergence | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const num = (key: string): number | null => (typeof row[key] === 'number' ? (row[key] as number) : null);
  const str = (key: string): string | null => (typeof row[key] === 'string' ? (row[key] as string) : null);
  const openedAtMs = num('openedAtMs');
  const ageMs = num('ageMs');
  const attempts = num('attempts');
  const admissionRounds = num('admissionRounds');
  const failingNow = num('failingNow');
  const observedAtMs = num('observedAtMs');
  const candidate = str('candidate');
  const repairHead = str('repairHead');
  const phase = str('phase');
  if (
    openedAtMs === null ||
    ageMs === null ||
    attempts === null ||
    admissionRounds === null ||
    failingNow === null ||
    observedAtMs === null ||
    candidate === null ||
    repairHead === null ||
    phase === null
  ) {
    return null;
  }
  if (!Array.isArray(row.shrinkPerRound)) return null;
  const shrinkPerRound: { round: number; failingCount: number; delta: number | null }[] = [];
  for (const entry of row.shrinkPerRound) {
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.round !== 'number' || typeof e.failingCount !== 'number') return null;
    if (e.delta !== null && typeof e.delta !== 'number') return null;
    shrinkPerRound.push({ round: e.round, failingCount: e.failingCount, delta: (e.delta as number | null) ?? null });
  }
  // `converging` and `failingFirst` are DELIBERATELY tri-state (null = not yet knowable / no
  // baseline). `null` is a legitimate stored value for both, so neither can be required above
  // — but a wrong TYPE still rejects the whole blob rather than being coerced to null, which
  // would turn a corrupt reading into a confident "not yet knowable".
  const failingFirstRaw = row.failingFirst ?? null;
  if (failingFirstRaw !== null && typeof failingFirstRaw !== 'number') return null;
  const shrinkTotalRaw = row.shrinkTotal ?? null;
  if (shrinkTotalRaw !== null && typeof shrinkTotalRaw !== 'number') return null;
  const convergingRaw = row.converging ?? null;
  if (convergingRaw !== null && typeof convergingRaw !== 'boolean') return null;
  return {
    openedAtMs,
    ageMs,
    attempts,
    admissionRounds,
    failingFirst: failingFirstRaw as number | null,
    failingNow,
    shrinkTotal: shrinkTotalRaw as number | null,
    shrinkPerRound,
    converging: convergingRaw as boolean | null,
    candidate,
    repairHead,
    phase: phase as FrozenCandidateRepairPhase,
    observedAtMs,
  };
}
