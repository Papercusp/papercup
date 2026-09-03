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

import {
  applyRepairLegMeasurements,
  parseRepairLegStates,
  summarizeRepairLegs,
  type FrozenRepairLegState,
  type RepairLegMeasurement,
  type RepairLegShrinkSummary,
} from './repair-leg-lifecycle';

export const FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION = 3 as const;
export const FROZEN_REPAIR_STAGING_MISMATCH_SIGNATURE = 'repair-staging-mismatch';

/** These bounds stop unattended fixer churn. Exhaustion retains the candidate at the queue
 * head; it never authorizes a newer moving-tip candidate — UNLESS `maxCandidateEscapes` is
 * raised above 0 (P-048, green-main-fast-2026-08-25), which permits a BOUNDED number of
 * exhausted pins to be abandoned in favour of a fresh tip cut.
 *
 * `maxCandidateEscapes: 1` — the owner-gated lever WAS pulled: P-008 of
 * gate-verdict-liveness-and-repair-reliability-2026-08-31 (activation-audited, owner-directed)
 * ratifies "maxCandidateEscapes 0 → 1/day". The limit stays a plain in-window count; the
 * rolling-DAY window is measured by the caller from the durable escape ledger
 * (`gate_health.candidateEscapes`, frozen-candidate-escape-ledger.ts), and the engine FAILS
 * CLOSED to the historical hold-exhausted behaviour whenever that ledger cannot be read or
 * written — so 0-behaviour remains the floor, never exceeded silently. An escape re-cuts at
 * tip; a genuinely persistent red reds the fresh candidate too, exhausts again, and the spent
 * budget then holds permanently — the bound is what stops a real red being laundered into
 * perpetual re-cutting (see decideExhaustedPin). */
/* `maxAgeMs` was 4h until 2026-08-27 [owner 2026-08-27, approved in-session].
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
 * NOT CHANGED: maxAttempts. maxCandidateEscapes moved 0 → 1 on 2026-09-01 under the P-008
 * owner decision documented above. */
export const DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS = Object.freeze({
  maxAttempts: 3,
  maxAgeMs: 8 * 60 * 60 * 1_000,
  maxCandidateEscapes: 1,
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

/**
 * WI-2141736: how long a frozen candidate may be HELD, past the zero-attempt stall, while a
 * measured provider wall outlasts that stall window — i.e. while the only available repair
 * path is agent/human convergence rather than an auto-fixer dispatch.
 *
 * 4h matches the queue's own `maxAgeMs` budget, so a held candidate cannot outlive the
 * bound the queue already carries. Without this hold the 15-minute stall retires every
 * queue against a multi-day wall, which is how freeze-and-converge went silently off for a
 * full day (20 retirements, 0 resumes, 2026-09-02).
 */
export const FROZEN_REPAIR_CONVERGENCE_HOLD_MS = 4 * 60 * 60 * 1_000;

const MAX_PERSISTED_FAILURES = 50;
const MAX_PERSISTED_FAILURE_CHARS = 500;

export type FrozenCandidateRepairPhase =
  | 'ready-to-test'
  | 'awaiting-fixer'
  | 'ready-to-verify'
  | 'ready-to-promote'
  | 'blocked';
export type FrozenCandidateBlockedReason = 'attempts-exhausted' | 'wall-clock-exhausted';

/**
 * Durable evidence that a frozen candidate pin was released because its age crossed the
 * candidate-fossil threshold. This is intentionally separate from the repair queue: the queue
 * is cleared as part of the release, while this record preserves which immutable candidate was
 * abandoned and why for the checkpoint result/event readers.
 */
export interface FrozenCandidateFossilAbandonment {
  abandonedCandidate: string;
  ageMs: number;
  thresholdMs: number;
  reason: 'candidate-fossil';
}

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
  /**
   * P-005 (gate-verdict-liveness): how many attempt REFUNDS this queue has granted for
   * fixers that died of INFRASTRUCTURE (spawn failure, provider-capacity rejection,
   * permission fault, first-turn guillotine — proven by zero recorded tool invocations)
   * without advancing the repair worktree. Measured 2026-08-31: 130/130 dispatches died
   * this way, each silently burning one of 3 attempts — repair budgets exhausted by
   * launches that never did repair. A refunded death is a FREE retry; the refund count is
   * bounded (maxFreeRetries) so a misclassification can never spin forever, and the
   * wall-clock budget still terminates the queue regardless. Optional and additive:
   * legacy rows parse with it absent (reads as 0); an older deployed build's whole-row
   * write drops it, which only resets the refund bookkeeping — never wedges (the P-008
   * CAS lesson).
   */
  freeRetries?: number;
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
  /**
   * P-002 — the NON-TEST gate legs (lint / perf / desktop / delta) as first-class members of
   * this cycle, with the same lifecycle a test file has: named, admitted by their own
   * measured result, and tracked as they resolve.
   *
   * A leg CANNOT live in `failingTests` and work: everything that correlates that list to
   * repair work correlates BY PATH, and a leg id is not a path. See `./repair-leg-lifecycle`
   * for the correlation-key ruling (D-005).
   *
   * Optional and additive, exactly like `convergenceRounds`: a legacy queue parses with it
   * absent, which reads as "no leg measurement recorded" — never as "no legs are failing".
   */
  legs?: readonly FrozenRepairLegState[];
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
  /**
   * P-005: cap on attempt refunds for unproductive infrastructure fixer deaths (see
   * FrozenCandidateRepairQueue.freeRetries). OPTIONAL so existing limit constructors are
   * not stranded; absence applies DEFAULT_FROZEN_REPAIR_MAX_FREE_RETRIES.
   */
  maxFreeRetries?: number;
}

/**
 * P-005: default refund budget. Six free retries ≈ one hour of ~10-min dispatch cycles —
 * enough to ride out a transient provider wall or a host restart window, small enough
 * that a persistently-failing spawn plane exhausts within the queue's 8h wall clock and
 * pages through the normal exhaustion path instead of churning silently.
 */
export const DEFAULT_FROZEN_REPAIR_MAX_FREE_RETRIES = 6;

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
  | FrozenRepairDispatchPendingDecision
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

/**
 * WI-2141736 Layer 2: a single measured capacity wall on a zero-attempt queue is not proof the
 * fixer's real provider is durably unreachable — this workspace pools many accounts behind a
 * rate governor specifically because a momentary wall is common and routinely clears within
 * minutes (see repo playbook: "a true quota wall is rare... verify before giving up"). Treating
 * the very first such reading as a structural dead end (the pre-Layer-2 behavior) discards the
 * frozen candidate and re-cuts at tip for a reason that has nothing to do with the code under
 * test — reinstating exactly the re-cut-at-tip treadmill D-007's freeze-and-converge exists to
 * stop. This decision holds the candidate — inconclusive, no verdict recorded — until the wall
 * has genuinely persisted past `zeroAttemptStallMs`; only then does `recut-at-tip` fire.
 */
interface FrozenRepairDispatchPendingBase {
  kind: 'wait-for-dispatch-capacity';
  repairHead: string;
  attempts: number;
  ageMs: number;
  zeroAttemptStallMs: number;
  gateDisposition: 'inconclusive';
  runSuite: false;
  recordVerdict: false;
}

/**
 * DISCRIMINATED on `zeroAttemptStalled`, deliberately: the two holds carry different
 * evidence, and making that a type-level fact is what stops a consumer rendering a
 * long-wall field on the momentary hold (where it is genuinely absent) or hand-defaulting
 * it to a number the decision never measured. `capacityRetryAtMs` and `convergenceHoldMs`
 * exist EXACTLY when the hold is the long-wall one — that is not a convention to remember,
 * it is what the union says.
 */
export type FrozenRepairDispatchPendingDecision =
  | (FrozenRepairDispatchPendingBase & {
      /**
       * The momentary-churn hold: the stall window has NOT elapsed, so it is simply too
       * early to judge. Nothing about a provider wall's duration has been established.
       */
      zeroAttemptStalled: false;
      capacityRetryAtMs?: undefined;
      convergenceHoldMs?: undefined;
    })
  | (FrozenRepairDispatchPendingBase & {
      /**
       * The LONG-WALL hold: the stall window HAS elapsed, but the measured wall outlasts
       * it, so retiring would buy nothing and cost the freeze. Held for agent convergence
       * instead — which is why both bounds below are guaranteed here and only here.
       */
      zeroAttemptStalled: true;
      /** When the measured provider wall is expected to lift (null = the probe knew none). */
      capacityRetryAtMs: number | null;
      /** The age past which the hold gives up and retires anyway. */
      convergenceHoldMs: number;
    });

/**
 * WI-2141347: the dispatch-infeasible retire, but for a queue whose movable `repairHead` has
 * already CONVERGED past its frozen `candidate` (see `shouldConvergeRepairHead` — only ever an
 * ancestor of staging, so already vetted, never unpushed fixer content). Retiring that queue and
 * re-cutting at whatever staging tip happens to be NOW discards the converged lineage untested
 * and re-admits the full last-green radius for no reason: the repairHead is itself a perfectly
 * good candidate to test. The caller treats this exactly like a fresh `test-candidate` (abandon
 * the old queue's bookkeeping, test this sha as if newly cut) — never like a repair-in-progress.
 */
export type FrozenRepairDispatchInfeasibleOutcome =
  | FrozenRepairDispatchInfeasibleDecision
  | FrozenRepairDispatchPendingDecision
  | Extract<FrozenRepairQueueDecision, { kind: 'test-candidate' }>;

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
  /**
   * Explicit identity for the immutable pin. `candidate` is retained as the
   * compatibility spelling used by older consumers, but status surfaces should
   * prefer this field whenever they need to distinguish it from `repairHead`.
   */
  frozenCandidate?: string;
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
  /**
   * Provenance for a no-suite repair status. `suiteRan:false` is the critical
   * discriminator: the mutable repair head is work in progress, not a judged
   * candidate. A status surface may still expose `candidate` for compatibility,
   * but must not imply that `repairHead` advanced the frozen pin.
   */
  /**
   * P-002/P-003 — the cycle's per-leg lifecycle, carried through so a diagnostic reader can
   * name WHICH non-test leg is failing and whether its own re-run has passed. Optional and
   * additive: absent means no leg measurement was recorded, never "no legs are failing".
   */
  legs?: readonly FrozenRepairLegState[];
  verdictProvenance?: {
    frozenCandidate: string;
    repairHead: string;
    phase: FrozenCandidateRepairPhase;
    currentStatus: 'no-suite' | 'isolated-suite-result';
    frozenCandidateVerdict: 'not-judged' | 'full-gate-red';
    repairHeadVerdict:
      | 'not-judged'
      | 'same-as-frozen-full-gate-red'
      | 'isolated-repair-green';
  };
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

export function buildFrozenRepairStatusIdentity(queue: FrozenCandidateRepairQueue): {
  frozenCandidate: string;
  repairHead: string;
  phase: FrozenCandidateRepairPhase;
  verdictProvenance: NonNullable<FrozenRepairQueueDiagnostic['verdictProvenance']>;
} {
  return {
    frozenCandidate: queue.candidate,
    repairHead: queue.repairHead,
    phase: queue.phase,
    verdictProvenance: {
      frozenCandidate: queue.candidate,
      repairHead: queue.repairHead,
      phase: queue.phase,
      currentStatus: queue.phase === 'ready-to-promote' ? 'isolated-suite-result' : 'no-suite',
      frozenCandidateVerdict: queue.phase === 'ready-to-test' ? 'not-judged' : 'full-gate-red',
      repairHeadVerdict:
        queue.phase === 'ready-to-promote'
          ? 'isolated-repair-green'
          : queue.phase !== 'ready-to-test' && queue.repairHead === queue.candidate
            ? 'same-as-frozen-full-gate-red'
            : 'not-judged',
    },
  };
}

/**
 * Measured dispatch infeasibility is not a candidate verdict and must not hold an immutable pin.
 * The caller retires the queue and falls through to the current staging tip. This policy is
 * deliberately independent of `maxCandidateEscapes`: that budget bounds failed REPAIR attempts,
 * while this branch proves no repair attempt can begin at all.
 */
export function decideFrozenRepairDispatchInfeasible(
  queue: FrozenCandidateRepairQueue,
  observation: {
    nowMs: number;
    zeroAttemptStallMs?: number;
    /**
     * When the measured provider wall is expected to lift, from the capacity preflight's
     * own `retryAtMs`. Absent/null = unknown, which keeps the pre-existing behaviour.
     */
    capacityRetryAtMs?: number | null;
    /**
     * How long a long-wall hold may keep the freeze while waiting for agent/human
     * convergence, before giving up and retiring anyway. Defaults to
     * FROZEN_REPAIR_CONVERGENCE_HOLD_MS.
     */
    convergenceHoldMs?: number;
  },
): FrozenRepairDispatchInfeasibleOutcome {
  assertTimestamp(observation.nowMs, 'nowMs');
  const zeroAttemptStallMs = observation.zeroAttemptStallMs ?? FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS;
  if (!Number.isFinite(zeroAttemptStallMs) || zeroAttemptStallMs <= 0) {
    throw new Error('zeroAttemptStallMs must be a positive finite duration');
  }
  if (queue.phase !== 'awaiting-fixer' || queue.fixerSpawnId !== null || queue.dispatchReservation !== undefined) {
    throw new Error('dispatch infeasibility requires an unassigned awaiting-fixer queue without a reservation');
  }
  // WI-2141347: a converged repairHead (only ever an ancestor of staging — see
  // `shouldConvergeRepairHead` — so already vetted, never unpushed fixer content) is a
  // structurally sound candidate to test even though no fixer can be dispatched right now.
  // Retiring it here would discard that convergence untested and re-cut at whatever staging
  // tip happens to be current, re-admitting the whole last-green radius for nothing. Test it
  // instead, exactly like a fresh candidate — this queue's own bookkeeping is still abandoned
  // by the caller (same as the recut-at-tip path), so no repair-queue continuity is implied.
  if (queue.repairHead !== queue.candidate) {
    return {
      kind: 'test-candidate',
      candidate: queue.repairHead,
      gateDisposition: 'initial-candidate',
      runSuite: true,
      recordVerdict: true,
    };
  }
  const ageMs = Math.max(0, observation.nowMs - queue.openedAtMs);
  const zeroAttemptStalled = queue.attempts === 0 && ageMs >= zeroAttemptStallMs;
  if (!zeroAttemptStalled) {
    // A momentary capacity wall on a queue that just opened (or has been open only briefly)
    // is not yet distinguishable from ordinary pool churn. Hold the candidate and report
    // inconclusive so the next tick re-measures rather than discarding it outright.
    return {
      kind: 'wait-for-dispatch-capacity',
      repairHead: queue.repairHead,
      attempts: queue.attempts,
      ageMs,
      zeroAttemptStalled: false,
      zeroAttemptStallMs,
      gateDisposition: 'inconclusive',
      runSuite: false,
      recordVerdict: false,
    };
  }
  // WI-2141736: the stall window has elapsed — but retiring is only the right answer when
  // waiting could plausibly help. Measured 2026-09-02: the fixer's provider was walled for
  // SIX DAYS, so every queue stalled out after 15 minutes, retired, and re-cut at tip — 20
  // retirements, 0 resumes in one day, and freeze-and-converge was silently off fleet-wide.
  // Retiring bought nothing (the next queue hit the same wall 15 minutes later) and cost the
  // whole convergence property.
  //
  // "The AUTO-FIXER cannot be dispatched" is NOT "this queue is unreachable-green": agents
  // and humans converge onto frozen candidates routinely, and the `test-candidate` branch
  // above exists precisely to test a repairHead one of them advanced. So when the wall
  // OUTLASTS the stall window, hold the freeze and let convergence do the repair — bounded by
  // convergenceHoldMs so a candidate nobody converges still cannot pin the gate forever.
  const convergenceHoldMs = observation.convergenceHoldMs ?? FROZEN_REPAIR_CONVERGENCE_HOLD_MS;
  if (!Number.isFinite(convergenceHoldMs) || convergenceHoldMs <= 0) {
    throw new Error('convergenceHoldMs must be a positive finite duration');
  }
  const retryAtMs = observation.capacityRetryAtMs ?? null;
  const wallOutlastsStallWindow =
    retryAtMs !== null && Number.isFinite(retryAtMs) && retryAtMs - observation.nowMs > zeroAttemptStallMs;
  if (wallOutlastsStallWindow && ageMs < convergenceHoldMs) {
    return {
      kind: 'wait-for-dispatch-capacity',
      repairHead: queue.repairHead,
      attempts: queue.attempts,
      ageMs,
      zeroAttemptStalled: true,
      zeroAttemptStallMs,
      capacityRetryAtMs: retryAtMs,
      convergenceHoldMs,
      gateDisposition: 'inconclusive',
      runSuite: false,
      recordVerdict: false,
    };
  }
  return {
    kind: 'recut-at-tip',
    reason: 'dispatch-infeasible',
    abandonedCandidate: queue.candidate,
    repairHead: queue.repairHead,
    attempts: queue.attempts,
    ageMs,
    zeroAttemptStalled: true,
    zeroAttemptStallMs,
    gateDisposition: 'recut',
    runSuite: false,
    recordVerdict: false,
  };
}

/**
 * EI-21036544613774607: whether the queue's MOVABLE `repairHead` (never the immutable
 * `candidate` — see the field doc above) should be fast-forwarded to the current staging
 * tip before a repair worktree is built from it.
 *
 * A frozen candidate's `repairHead` starts equal to `candidate` and stays there until a
 * fixer produces its own commit (see `markFrozenRepairFixerFinished`). While it is STILL
 * an ancestor of staging — i.e. no fixer commit has yet diverged from staging's own
 * history — converging it is free: every commit reachable from the new value is, by
 * construction, already vetted and committed on staging (git-sync only ever commits
 * there), so no new/unverified code is introduced. Once a fixer commit exists,
 * `repairHead` carries unique, unpushed content and is no longer an ancestor of staging;
 * this then correctly refuses to converge and leaves that in-flight repair alone.
 *
 * `repairHeadIsAncestorOfStaging: null` means the ancestor check itself was inconclusive
 * or errored (a git failure, a temporarily-unreachable ref). Fails closed: no convergence
 * is today's behaviour, and it is the safe default whenever the check cannot be trusted.
 */
export function shouldConvergeRepairHead(input: {
  repairHead: string;
  stagingTip: string;
  repairHeadIsAncestorOfStaging: boolean | null;
}): { converge: boolean; newRepairHead: string | null } {
  if (
    input.repairHeadIsAncestorOfStaging === true &&
    input.stagingTip !== input.repairHead
  ) {
    return { converge: true, newRepairHead: input.stagingTip };
  }
  return { converge: false, newRepairHead: null };
}

/**
 * WI-1634331: whether an ALREADY-BUILT repair worktree may be fast-forwarded onto the
 * queue's current `repairHead`.
 *
 * `shouldConvergeRepairHead` (above) advances the MOVABLE `repairHead`. Nothing moves the
 * WORKTREE with it: `prepareFrozenRepairWorktree` builds that worktree exactly once and
 * returns early forever after (its `.git`-exists guard — the very early return the
 * converge contract doc already cites as this bug's evidence). So the converge fix repairs
 * only the FIRST-build case; from the second dispatch onward `repairHead` walks forward
 * while the worktree stays pinned where it was built.
 *
 * That gap is self-worsening rather than merely sticky. A fixer working in the stale
 * worktree commits a descendant of the OLD head, so `finalizeFrozenRepairWorktree`'s
 * `isAncestor(repairHead, head)` check fails, it throws, and the throw is swallowed into
 * the same `null` the call site reads as "the fixer ran and correctly changed nothing" —
 * burning an attempt on a state that can NEVER reach ready-to-verify. Every subsequent
 * hourly converge widens the gap, so each remaining attempt burns faster than the last.
 *
 * This is deliberately the NARROWEST safe rule, because a repair worktree is the one place
 * a dead fixer's unpushed work can still exist and there is no second copy of it:
 *  - `dirty` — uncommitted work is present. NEVER move it. That work is unrecoverable once
 *    clobbered, and `finalizeFrozenRepairWorktree` is precisely the path that commits it.
 *  - `worktreeHeadIsAncestorOfRepairHead === true` — every commit reachable from the
 *    worktree is ALREADY contained in `repairHead`, so a checkout can lose nothing by
 *    construction. This is the wedge, and the only case that moves.
 *  - `false` — the worktree holds commits `repairHead` does not (a real fixer commit, or a
 *    genuine divergence). Leave it and let finalize adjudicate; that is its job.
 *  - `null` — the ancestry check itself failed (a git error, an unreachable ref). Fails
 *    closed exactly as `shouldConvergeRepairHead` does: no move.
 *
 * Returning the `reason` for a REFUSAL as well as for the move keeps the log at the call
 * site able to say WHICH of those four states it observed. "The worktree was not re-synced"
 * is otherwise indistinguishable across a lossless no-op, protected fixer work, and a
 * broken git — the same conflation, one level up, that made the original defect silent.
 */
export function shouldResyncRepairWorktree(input: {
  worktreeHead: string;
  repairHead: string;
  dirty: boolean;
  worktreeHeadIsAncestorOfRepairHead: boolean | null;
}): {
  resync: boolean;
  reason:
    | "already-current"
    | "dirty"
    | "not-behind"
    | "ancestry-unknown"
    | "behind";
} {
  if (input.worktreeHead === input.repairHead) {
    return { resync: false, reason: "already-current" };
  }
  if (input.dirty) return { resync: false, reason: "dirty" };
  if (input.worktreeHeadIsAncestorOfRepairHead === null) {
    return { resync: false, reason: "ancestry-unknown" };
  }
  if (!input.worktreeHeadIsAncestorOfRepairHead) {
    return { resync: false, reason: "not-behind" };
  }
  return { resync: true, reason: "behind" };
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
  if (
    limits.maxFreeRetries !== undefined &&
    (!Number.isInteger(limits.maxFreeRetries) || limits.maxFreeRetries < 0)
  ) {
    throw new Error('maxFreeRetries must be a non-negative integer when provided');
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
  // P-002 legs are observability on the same terms as rounds above: malformed entries are
  // dropped individually, never failing the parse of a live queue.
  const legs = parseRepairLegStates(row.legs);
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
    // P-005 refund bookkeeping is observability-adjacent: malformed values read as absent
    // (0 refunds granted) rather than failing the parse — same rationale as rounds above.
    ...(Number.isInteger(row.freeRetries) && (row.freeRetries as number) > 0
      ? { freeRetries: row.freeRetries as number }
      : {}),
    openedAtMs: row.openedAtMs,
    updatedAtMs: row.updatedAtMs,
    fixerSpawnId: row.fixerSpawnId as string | null,
    ...(blockedReason ? { blockedReason } : {}),
    ...(dispatchReservation ? { dispatchReservation } : {}),
    ...(convergenceRounds.length > 0 ? { convergenceRounds } : {}),
    ...(legs.length > 0 ? { legs } : {}),
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

/**
 * Compare paths without tripping over `./` prefixes or Windows separators.
 *
 * EXPORTED because the P-004 edit-time hook must classify an edited path the SAME way the
 * gate does. The hook is plain `.mjs` installed outside the repo and cannot import this
 * module, so it carries its own copy — pinned against this one by
 * `frozen-repair-edit-hook-parity.test.ts`, which fails the build if the two ever disagree.
 * A hook that normalized differently would stay silent on exactly the edits that red the gate.
 */
export function normalizeRepoPath(value: string): string {
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
  // WI-1586801: `retireAllowed` answers "is retiring PERMITTED?" — a safety predicate, never a
  // recommendation. Rendering the paste-ready retire recipe whenever retirement is merely
  // permitted advertises the DESTRUCTIVE verb for a queue the mechanism is about to recover on
  // its own: `recover-dead-fixer` sets retireAllowed:true with retireRefusal:null, and agents
  // that copied this string destroyed recoverable queues. Only a decision that is genuinely
  // terminal for this candidate earns the retire recipe; every other decision keeps the SAFE
  // verb advertised. `retireAllowed`/`retireRefusal` are deliberately left untouched — the
  // permission and the recommendation are different questions and other callers read the former.
  const retirementIsTheDecision = decision.kind === 'hold-exhausted' || decision.kind === 'recut-at-tip';
  const identity = buildFrozenRepairStatusIdentity(queue);
  const nextAction = !retireAllowed
    ? null
    : retirementIsTheDecision
      ? `release:repair-queue { op: 'retire', expectedCandidate: '${queue.candidate}', expectedRepairHead: '${queue.repairHead}', expectedUpdatedAtMs: ${queue.updatedAtMs}, reason: '<why this exact non-live queue is terminal>', confirm: true }`
      : `decision '${decision.kind}': this queue is still recoverable — do NOT retire it. Land your fix on the judged lineage with release:repair-queue { op: 'converge', paths: ['<your changed path>'] }.`;
  return {
    ...identity,
    candidate: queue.candidate,
    // P-002/P-003: carried onto the diagnostic so a reader holding it can answer "which
    // non-test leg, and did its fix land" without re-parsing the raw queue blob.
    ...(queue.legs && queue.legs.length > 0 ? { legs: queue.legs } : {}),
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

/**
 * Persist recovery of a definitively-dead fixer before age/reservation policy runs again.
 *
 * P-005 refund semantics: when the death is classified as an UNPRODUCTIVE INFRASTRUCTURE
 * death (`unproductiveInfrastructureDeath` supplied — the fixer never made a tool call:
 * spawn failure, provider-capacity rejection, permission fault, first-turn guillotine),
 * the attempt burned at dispatch is REFUNDED so the retry is free — an attempt should
 * measure a fixer that actually attempted repair, not a launch that died at the door.
 * The refund is bounded by `limits.maxFreeRetries` (a classification bug must not spin
 * forever) and the wall-clock budget still terminates the queue regardless. A fixer that
 * DID work (made tool calls) and then died keeps its burned attempt — losing its edits is
 * P-006's axis, not this one.
 */
export function markFrozenRepairFixerDead(
  queue: FrozenCandidateRepairQueue,
  input: { spawnId: string; nowMs: number; unproductiveInfrastructureDeath?: { reason: string } },
  limits: FrozenRepairQueueLimits = DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS,
): FrozenCandidateRepairQueue {
  requirePhase(queue, 'awaiting-fixer', 'mark fixer dead');
  assertTimestamp(input.nowMs, 'nowMs');
  if (queue.fixerSpawnId !== input.spawnId) {
    throw new Error(`stale fixer death for ${input.spawnId}; queue expects ${queue.fixerSpawnId ?? 'none'}`);
  }
  const { dispatchReservation: _reservation, ...withoutReservation } = queue;
  const maxFreeRetries = limits.maxFreeRetries ?? DEFAULT_FROZEN_REPAIR_MAX_FREE_RETRIES;
  const refund =
    input.unproductiveInfrastructureDeath != null &&
    queue.attempts > 0 &&
    (queue.freeRetries ?? 0) < maxFreeRetries;
  return {
    ...withoutReservation,
    ...(refund ? { attempts: queue.attempts - 1, freeRetries: (queue.freeRetries ?? 0) + 1 } : {}),
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

/**
 * P-002 — fold one tick's NON-TEST leg measurements into the queue.
 *
 * A SEPARATE seam from the red/green markers on purpose. Those take a flat `failingTests`
 * list, which cannot say which entry is a leg or whether a leg passed; a leg's lifecycle is
 * moved only by that leg's own measured result (D-005). Keeping it separate also means no
 * existing caller signature changes, so nothing is stranded by adding legs.
 *
 * The round is read from the convergence history so leg rounds and convergence rounds are
 * the SAME rounds — two shrink series over one cycle, never two clocks.
 *
 * ⚠ Legs absent from `measurements` are left exactly as they are. This function never
 * removes a leg and never infers a pass from silence.
 */
export function recordFrozenRepairLegMeasurement(
  queue: FrozenCandidateRepairQueue,
  input: { measurements: readonly RepairLegMeasurement[]; head: string; nowMs: number },
): FrozenCandidateRepairQueue {
  assertTimestamp(input.nowMs, 'nowMs');
  if (!nonBlank(input.head)) throw new Error('head is required to record a leg measurement');
  const rounds = queue.convergenceRounds ?? [];
  const round = rounds.reduce((max, entry) => (entry.round > max ? entry.round : max), 0) || 1;
  const legs = applyRepairLegMeasurements(queue.legs, {
    measurements: input.measurements,
    head: input.head,
    round,
    nowMs: input.nowMs,
  });
  if (legs.length === 0) return queue;
  return { ...queue, legs, updatedAtMs: input.nowMs };
}

/**
 * P-002 — the leg shrink reading for a queue. Re-exported through this module so a caller
 * holding a queue never has to know which file the lifecycle lives in.
 */
export function summarizeFrozenRepairLegs(queue: FrozenCandidateRepairQueue | null): RepairLegShrinkSummary {
  return summarizeRepairLegs(queue?.legs);
}

export {
  applyRepairLegMeasurements,
  parseRepairLegStates,
  partitionRepairSignatures,
  summarizeRepairLegs,
  FROZEN_REPAIR_LEG_CAP,
  type FrozenRepairLegState,
  type RepairLegMeasurement,
  type RepairLegShrinkSummary,
  type RepairLegStatus,
  type RepairSignaturePartition,
} from './repair-leg-lifecycle';

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

/**
 * The branchable reading of a convergence record — main-green-status-visible-2026-09-03 P-004.
 *
 * ⚠ THE WHOLE POINT IS THAT "NOT CONVERGING" AND "NOT YET KNOWABLE" ARE DIFFERENT ANSWERS.
 * `converging` is tri-state precisely because a cycle with fewer than two recorded rounds
 * has no trend to report; rendering that as "not converging" calls a healthy new freeze a
 * treadmill, which is how a working mechanism gets switched off.
 *
 * `no-attempts` is the code this session's incident earned. A queue can sit at
 * `attempts: 0` for hours — every tick withheld by a provider wall or a dispatch
 * reservation — while `consecutiveReds` climbs and the failing list stays frozen at its
 * last real measurement. From outside, that is indistinguishable from a genuine regression,
 * and the natural (wrong) response is to go hunting for the commit that broke it. It is a
 * DISPATCH fact, not a code fact, so it gets its own code rather than being folded into
 * `not-yet-knowable`.
 */
export type FrozenRepairConvergenceCode =
  /**
   * No readable convergence record. NEVER "healthy" and never "stuck".
   *
   * ⚠ Deliberately NOT the word `not-measured`: that belongs to the read-health vocabulary
   * (`CellUnknownCode`), and the cell registry REFUSES a domain enum that reuses it, so an
   * apparatus failure can never masquerade as a finding about the subject. Read-health for
   * this cell is carried separately, by the `unmeasured` hoist.
   */
  | 'no-cycle-recorded'
  /** A cycle is open but no fixer has ever run — nothing has been MEASURED to converge. */
  | 'no-attempts'
  /** Fewer than two recorded rounds: there is no trend yet. Not a verdict of failure. */
  | 'not-yet-knowable'
  /** Every round is <= the one before AND the set actually shrank. */
  | 'converging'
  /** Rounds recorded, but the failing set is not shrinking. This is the treadmill. */
  | 'not-converging';

/**
 * PURE: what should a reader conclude about this repair cycle?
 *
 * Order matters and is deliberate: an unmeasured record outranks everything, then the
 * dispatch fact (`no-attempts`) outranks the trend, because a trend computed over zero
 * fixer runs describes nothing that happened.
 */
export function assessFrozenRepairConvergence(
  record: StoredFrozenRepairConvergence | null,
): FrozenRepairConvergenceCode {
  if (!record) return 'no-cycle-recorded';
  if (record.attempts === 0) return 'no-attempts';
  if (record.converging === null) return 'not-yet-knowable';
  return record.converging ? 'converging' : 'not-converging';
}

/**
 * P-006 / D-004 — WHAT `failingNow` COUNTS, AND WHAT IT MUST NEVER BE SUBTRACTED FROM.
 *
 * `convergence.failingNow` and `gate_health.repairTickLegs.failingSignatures` read as the
 * same number and are not. They disagree on all three axes at once: SUBJECT (a set ADMITTED
 * to the queue row vs what ONE tick measured), VINTAGE (this record's own stamp vs the tick's
 * `atMs`), and HEAD (this record's `repairHead` vs the tick's own `head`). The measured
 * instance was 1 vs 2 — nowhere near the 50-entry persistence bound (`MAX_PERSISTED_FAILURES`),
 * so it was never truncation, and there is no undercount in `failingNow` to fix.
 *
 * D-004 rules out the two repairs that look reasonable and are not:
 *  - RENAMING the persisted field — a label adjustment that hides the scope difference
 *    instead of stating it, which P-006 forbids by name.
 *  - STORING the scope — a new required field on `StoredFrozenRepairConvergence` would fail
 *    `parseFrozenRepairConvergence` on every pre-existing row and silently drop the cell to
 *    unmeasured. That is the same false-absence class this plan exists to end.
 *
 * So it is DERIVED here, at projection time, from fields the stored record already carries.
 */
export interface FrozenRepairConvergenceScope {
  /** WHAT `failingNow` counts. A literal, so a reader can branch on it rather than parse prose. */
  population: 'queue-admitted-failing-set' | 'nothing-counted';
  /** The sha the admitted set describes — this record's `repairHead`, full length. */
  subject: string | null;
  /**
   * The NEWEST instant `failingNow` can describe (this record's `observedAtMs`). The admission
   * itself happened at or before it: the queue's own `updatedAtMs` is not carried in the stored
   * record, so this is an upper BOUND on the admission, never the admission instant. Stating a
   * bound as a bound is the point — a precise-looking timestamp derived from the wrong field
   * would invite exactly the cross-population comparison this object exists to block.
   */
  admittedAtOrBeforeMs: number | null;
  /** The OLDEST instant it can describe — when this cycle opened. */
  admittedAtOrAfterMs: number | null;
  /** Readings this count must never be differenced against, each with its reason. */
  notComparableTo: readonly { reading: string; why: string }[];
  /** The scope sentence. Rendered, not derived by the reader. */
  summary: string;
}

/**
 * The sibling readings a `failingNow` reader is most likely to subtract it from. Constant
 * because the incomparability is STRUCTURAL — it holds for every record, including an
 * unmeasured one, so it is published on the unmeasured branch too.
 */
const CONVERGENCE_NOT_COMPARABLE_TO: readonly { reading: string; why: string }[] = [
  {
    reading: 'gate_health.repairTickLegs.failingSignatures',
    why:
      'A DIFFERENT observation: what the most recent repair tick measured, carrying its own `atMs` ' +
      'and its own `head`. It differs from failingNow in subject, vintage AND head at once, so a ' +
      'gap between the two is not a shrink, a leak, or an undercount — it is two populations being ' +
      'subtracted.',
  },
  {
    reading: 'gate.greenCheckpoint.candidateFailures.stillBrokenCount',
    why:
      'Counts FILES still broken in the affected radius the gate judged for the candidate, decided ' +
      'by blob containment. failingNow counts the admitted failing SIGNATURES on the queue row, and ' +
      'those include non-test legs (e.g. "lint:tsc") that are not files at all.',
  },
];

/**
 * PURE: derive the scope object that must accompany `failingNow` wherever it is published.
 *
 * ⚠ Every field comes from the stored record; nothing here is measured, fetched, or stored.
 */
export function projectFrozenRepairConvergenceScope(
  record: StoredFrozenRepairConvergence | null,
): FrozenRepairConvergenceScope {
  if (!record) {
    return {
      population: 'nothing-counted',
      subject: null,
      admittedAtOrBeforeMs: null,
      admittedAtOrAfterMs: null,
      notComparableTo: CONVERGENCE_NOT_COMPARABLE_TO,
      summary:
        'No readable convergence record, so failingNow counts NOTHING — it is null, not zero, and ' +
        'not a measured "nothing is failing". Do not compare it with any other failing count.',
    };
  }
  return {
    population: 'queue-admitted-failing-set',
    subject: record.repairHead,
    admittedAtOrBeforeMs: record.observedAtMs,
    admittedAtOrAfterMs: record.openedAtMs,
    notComparableTo: CONVERGENCE_NOT_COMPARABLE_TO,
    summary:
      `failingNow counts the ${record.failingNow} signature(s) ADMITTED to this repair queue row for ` +
      `repairHead ${record.repairHead.slice(0, 12)}, at or before ` +
      `${new Date(record.observedAtMs).toISOString()}. It is an admitted set, not a fresh ` +
      'measurement, and it is NOT comparable with gate_health.repairTickLegs.failingSignatures — ' +
      'different subject, different vintage, different head. A difference between them is not a shrink.',
  };
}

/** The celled projection: the record, its reading, and the vintage behind both. */
export interface FrozenRepairConvergenceCellProjection {
  code: FrozenRepairConvergenceCode;
  /**
   * Axis-2 HOIST: true when there is no readable convergence record. Result-level and
   * boolean because the alternative reading of an all-null record — "nothing is failing,
   * so nothing had to converge" — is the precise false all-clear this cell exists to stop.
   */
  unmeasured: boolean;
  openedAtMs: number | null;
  ageMs: number | null;
  attempts: number | null;
  admissionRounds: number | null;
  failingFirst: number | null;
  failingNow: number | null;
  shrinkTotal: number | null;
  shrinkPerRound: readonly { round: number; failingCount: number; delta: number | null }[];
  converging: boolean | null;
  candidate: string | null;
  repairHead: string | null;
  phase: FrozenCandidateRepairPhase | null;
  observedAtMs: number | null;
  /**
   * P-006 / D-004: what `failingNow` counts and when that population was admitted, published
   * BESIDE it so a reader cannot difference it against a sibling failing count. Always
   * present — the incomparability is structural, so the unmeasured branch carries it too.
   */
  scope: FrozenRepairConvergenceScope;
}

/**
 * PURE: project the stored convergence record into the shape
 * `gate.greenCheckpoint.convergence` publishes.
 *
 * Emitted UNCONDITIONALLY, for the same two reasons as the freeze disposition's projection:
 * the cell contract requires the declared assessment path to be present in every live
 * payload, and "not measured" is an answer a reader must be able to branch on rather than
 * infer from an absence. Every field is null rather than zero — a `shrinkTotal: 0` invented
 * for an unmeasured cycle is a claim that it is not shrinking.
 */
export function projectFrozenRepairConvergenceCell(
  record: StoredFrozenRepairConvergence | null,
): FrozenRepairConvergenceCellProjection {
  const code = assessFrozenRepairConvergence(record);
  if (!record) {
    return {
      code,
      unmeasured: true,
      openedAtMs: null,
      ageMs: null,
      attempts: null,
      admissionRounds: null,
      failingFirst: null,
      failingNow: null,
      shrinkTotal: null,
      shrinkPerRound: [],
      converging: null,
      candidate: null,
      repairHead: null,
      phase: null,
      observedAtMs: null,
      scope: projectFrozenRepairConvergenceScope(null),
    };
  }
  return { code, unmeasured: false, ...record, scope: projectFrozenRepairConvergenceScope(record) };
}
