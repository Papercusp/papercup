/**
 * join-progress — the product's join state for a peer joining a hive.
 * Plan p2p-v1-core-release-2026-11-13, item P-004 (requirement R-9).
 *
 * USABLE FROM THE HEAD SNAPSHOT. A fresh merge cursor is seeded at each log's latest
 * complete `__snapshot__` set (read-merge.ts `seedCursorFromSnapshots`), so the current
 * rows that set summarizes are readable as soon as it is applied, before the ops after
 * it. A joining peer is therefore `usable` once its head snapshot is applied, and it
 * BACKFILLS the remaining ops in the background. The join is `complete` when the applied
 * frontier reaches the target frontier (what the writers are known to hold).
 *
 * PASS OR FAIL IS JUDGED BY PROGRESS, NEVER BY A FIXED TIME WINDOW. Elapsed time since the
 * join started never fails a join, however far it runs past the configured join timeouts
 * (`JOIN_TIMEOUTS_MS`): those bound individual waits (the admission wait, one substrate
 * boot, the join wizard's hold), not the join. The only failure is the stalled-frontier
 * policy: the applied frontier did not advance across observations spanning more than
 * `stallAfterMs` while it was still below the target. A frontier that advances again
 * leaves the failed state; a completed join stays complete.
 *
 * Pure: no clock, no I/O. The caller supplies `nowMs` with every observation, so tests
 * drive it with a controllable clock.
 */

export type JoinState = 'joining' | 'usable' | 'complete' | 'failed';

/**
 * Every configured timeout a join passes through, in one place. Each value is a bound on
 * ONE wait, and none of them may fail a join whose frontier is advancing.
 */
export const JOIN_TIMEOUTS_MS = Object.freeze({
  /** join-shared-harness step 5 (await_admission_merge); a timeout maps to phase_0_pending. */
  admissionWaitMs: 30_000,
  /** boot-all.ts per-harness substrate boot race. */
  substrateBootMs: 30_000,
  /** harness/bootstrap-wait.ts: how long the join wizard holds before "continue anyway". */
  bootstrapWaitMs: 120_000,
});

/** The longest configured join timeout. */
export function longestJoinTimeoutMs(): number {
  return Math.max(...Object.values(JOIN_TIMEOUTS_MS));
}

/** Stalled-frontier policy default: ten minutes without any applied-frontier advance. */
export const DEFAULT_JOIN_STALL_AFTER_MS = 10 * 60_000;

export interface JoinProgressSample {
  nowMs: number;
  /** The head snapshot (or, for a log with none, the first fold) has been applied. */
  headApplied: boolean;
  /** Ops actually applied by this peer, summed over the remote logs it is joining. */
  appliedFrontier: number;
  /** Ops the remote writers are known to hold, summed over the same logs. */
  targetFrontier: number;
  /** False while admission, snapshot seeding or deferred materialization is unresolved. */
  readyForCompletion?: boolean;
}

export interface JoinProgressSnapshot {
  state: JoinState;
  headApplied: boolean;
  appliedFrontier: number;
  targetFrontier: number;
  /** Highest applied frontier ever observed; progress is an increase of this value. */
  highestApplied: number;
  startedAtMs: number;
  lastAdvanceAtMs: number;
  completedAtMs: number | null;
  /** Start of the current stall episode, or null when the join is not failed. */
  failedAtMs: number | null;
  observations: number;
}

export interface JoinProgressTracker {
  observe(sample: JoinProgressSample): JoinProgressSnapshot;
  snapshot(): JoinProgressSnapshot | null;
}

function assertCount(name: string, v: number): void {
  if (!Number.isFinite(v) || v < 0) {
    throw new TypeError(`join-progress: ${name} must be a finite non-negative number, got ${String(v)}`);
  }
}

export function createJoinProgressTracker(opts: { stallAfterMs?: number } = {}): JoinProgressTracker {
  const stallAfterMs = opts.stallAfterMs ?? DEFAULT_JOIN_STALL_AFTER_MS;
  if (!Number.isFinite(stallAfterMs) || stallAfterMs <= 0) {
    throw new TypeError(`join-progress: stallAfterMs must be a positive number, got ${String(stallAfterMs)}`);
  }
  let current: JoinProgressSnapshot | null = null;
  let lastObservedAtMs = -Infinity;

  function observe(sample: JoinProgressSample): JoinProgressSnapshot {
    assertCount('appliedFrontier', sample.appliedFrontier);
    assertCount('targetFrontier', sample.targetFrontier);
    if (!Number.isFinite(sample.nowMs)) {
      throw new TypeError(`join-progress: nowMs must be finite, got ${String(sample.nowMs)}`);
    }
    // A clock that steps backwards is held at the last observation, so it never
    // manufactures a stall or shortens one.
    const nowMs = Math.max(lastObservedAtMs, sample.nowMs);
    lastObservedAtMs = nowMs;
    const prev = current;
    const advanced =
      prev === null ||
      sample.appliedFrontier > prev.highestApplied ||
      (sample.headApplied && !prev.headApplied);
    const headApplied = sample.headApplied || (prev?.headApplied ?? false);
    const highestApplied = Math.max(prev?.highestApplied ?? 0, sample.appliedFrontier);
    const lastAdvanceAtMs = advanced ? nowMs : prev!.lastAdvanceAtMs;

    let state: JoinState;
    let completedAtMs = prev?.completedAtMs ?? null;
    let failedAtMs: number | null = null;
    if (prev?.state === 'complete' ||
        (headApplied && sample.appliedFrontier >= sample.targetFrontier && sample.readyForCompletion !== false)) {
      state = 'complete';
      completedAtMs ??= nowMs;
    } else if (!advanced && nowMs - lastAdvanceAtMs > stallAfterMs) {
      state = 'failed';
      failedAtMs = prev?.failedAtMs ?? lastAdvanceAtMs + stallAfterMs;
    } else {
      state = headApplied ? 'usable' : 'joining';
    }

    current = {
      state,
      headApplied,
      appliedFrontier: sample.appliedFrontier,
      targetFrontier: sample.targetFrontier,
      highestApplied,
      startedAtMs: prev?.startedAtMs ?? nowMs,
      lastAdvanceAtMs,
      completedAtMs,
      failedAtMs,
      observations: (prev?.observations ?? 0) + 1,
    };
    return current;
  }

  return {
    observe,
    snapshot: () => current,
  };
}
