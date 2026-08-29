import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS,
  FROZEN_REPAIR_COLLISION_PATH_DISPLAY_CAP,
  FROZEN_REPAIR_CONVERGENCE_ROUND_CAP,
  FROZEN_REPAIR_STAGING_MISMATCH_SIGNATURE,
  createFrozenCandidateQueue,
  createFrozenCandidateRepairQueue,
  decideFrozenCandidateRepairQueue,
  decideFrozenConvergenceCycleEntry,
  detectFrozenRepairSharedTreeCollision,
  diagnoseFrozenCandidateRepairQueue,
  markFrozenCandidateVerificationRed,
  markFrozenRepairExhausted,
  markFrozenRepairFixerDead,
  markFrozenRepairFixerDispatched,
  markFrozenRepairFixerFinished,
  markFrozenRepairStagingMismatch,
  markFrozenRepairVerificationGreen,
  markFrozenRepairVerificationRed,
  parseFrozenCandidateRepairQueue,
  summarizeFrozenRepairConvergence,
  buildFrozenRepairConvergenceGateHealth,
  parseFrozenRepairConvergence,
  type FrozenCandidateRepairQueue,
} from './frozen-candidate-repair-queue';

const C = '1111111111111111111111111111111111111111';
const C1 = '2222222222222222222222222222222222222222';
const C2 = '3333333333333333333333333333333333333333';
const BASE = '0000000000000000000000000000000000000000';
const ROOT = '/repo/.papercusp/worktrees/green-candidate-11111111';
const T0 = 1_800_000_000_000;

function fresh(): FrozenCandidateRepairQueue {
  return createFrozenCandidateRepairQueue({
    candidate: C,
    base: BASE,
    worktreePath: ROOT,
    failingTests: ['lib/a.test.ts'],
    nowMs: T0,
  });
}

describe('frozen-candidate repair queue', () => {
  it('persists the first red as an unassigned serialized queue without moving C', () => {
    const queue = fresh();
    expect(queue).toMatchObject({
      schemaVersion: 3,
      phase: 'awaiting-fixer',
      candidate: C,
      base: BASE,
      repairHead: C,
      affectedTestProofGroup: null,
      worktreePath: ROOT,
      attempts: 0,
      fixerSpawnId: null,
      failingTests: ['lib/a.test.ts'],
    });
    expect(decideFrozenCandidateRepairQueue(queue, { nowMs: T0 })).toEqual({
      kind: 'dispatch-fixer',
      reason: 'unassigned',
      nextAttempt: 1,
      repairHead: C,
      worktreePath: ROOT,
      runSuite: false,
      recordVerdict: false,
    });
  });

  it('persists C before its first suite, resumes that exact SHA, and transitions red in place', () => {
    const queue = createFrozenCandidateQueue({
      candidate: C,
      qualificationAttemptId: 'qualification-attempt-1',
      base: BASE,
      worktreePath: ROOT,
      affectedTestProofGroup: 'initial-gate-run',
      nowMs: T0,
    });

    expect(queue).toMatchObject({
      schemaVersion: 3,
      phase: 'ready-to-test',
      candidate: C,
      qualificationAttemptId: 'qualification-attempt-1',
      repairHead: C,
      attempts: 0,
      fixerSpawnId: null,
      failingTests: [],
    });
    expect(decideFrozenCandidateRepairQueue(queue, { nowMs: T0 + 1 })).toEqual({
      kind: 'test-candidate',
      candidate: C,
      gateDisposition: 'initial-candidate',
      runSuite: true,
      recordVerdict: true,
    });

    const red = markFrozenCandidateVerificationRed(queue, {
      failingTests: ['lib/a.test.ts'],
      nowMs: T0 + 2,
    });
    expect(red).toMatchObject({
      phase: 'awaiting-fixer',
      candidate: C,
      repairHead: C,
      attempts: 0,
      failingTests: ['lib/a.test.ts'],
    });
    expect(decideFrozenCandidateRepairQueue(red, { nowMs: T0 + 3 })).toMatchObject({
      kind: 'dispatch-fixer',
      repairHead: C,
      nextAttempt: 1,
    });
  });

  it('persists the initial proof group and parses legacy or malformed proof state fail-closed', () => {
    const current = createFrozenCandidateRepairQueue({
      candidate: C,
      base: BASE,
      worktreePath: ROOT,
      affectedTestProofGroup: 'initial-gate-run',
      nowMs: T0,
    });
    expect(current).toMatchObject({
      schemaVersion: 3,
      affectedTestProofGroup: 'initial-gate-run',
    });
    expect(
      parseFrozenCandidateRepairQueue({
        ...current,
        schemaVersion: 1,
        affectedTestProofGroup: undefined,
      }),
    ).toMatchObject({ schemaVersion: 3, affectedTestProofGroup: null });
    expect(
      parseFrozenCandidateRepairQueue({
        ...current,
        schemaVersion: 2,
      }),
    ).toMatchObject({ schemaVersion: 3, affectedTestProofGroup: 'initial-gate-run' });
    expect(
      parseFrozenCandidateRepairQueue({
        ...current,
        affectedTestProofGroup: { corrupt: true },
      }),
    ).toMatchObject({ schemaVersion: 3, affectedTestProofGroup: null });
    expect(
      parseFrozenCandidateRepairQueue({
        ...current,
        qualificationAttemptId: '',
      }),
    ).toBeNull();
    expect(
      parseFrozenCandidateRepairQueue({
        ...current,
        qualificationAttemptId: undefined,
      }),
    ).toMatchObject({ schemaVersion: 3, qualificationAttemptId: null });
  });

  it('leaves an absent queue on the existing normal gate path', () => {
    expect(decideFrozenCandidateRepairQueue(null, { nowMs: T0 })).toEqual({
      kind: 'run-normal-gate',
      runSuite: true,
      recordVerdict: true,
    });
  });

  it.each([
    [true, 'live'],
    [null, 'unknown'],
    [undefined, 'unknown'],
  ] as const)(
    'a pending fixer with liveness %s is inconclusive and burns neither a suite nor a verdict',
    (fixerAlive, expectedLiveness) => {
      const queue = markFrozenRepairFixerDispatched(fresh(), {
        spawnId: 'spawn-1',
        nowMs: T0 + 1,
      });
      expect(decideFrozenCandidateRepairQueue(queue, { nowMs: T0 + 2, fixerAlive })).toEqual({
        kind: 'wait-for-fixer',
        fixerSpawnId: 'spawn-1',
        liveness: expectedLiveness,
        gateDisposition: 'inconclusive',
        runSuite: false,
        recordVerdict: false,
      });
    },
  );

  it('waits for an active dispatch reservation and retries after its lease expires', () => {
    const reserved: FrozenCandidateRepairQueue = {
      ...fresh(),
      dispatchReservation: {
        token: 'reservation-1',
        claimedAtMs: T0 + 1,
        expiresAtMs: T0 + 100,
      },
    };

    expect(decideFrozenCandidateRepairQueue(reserved, { nowMs: T0 + 2 })).toEqual({
      kind: 'wait-for-dispatch-reservation',
      reservationToken: 'reservation-1',
      reservationExpiresAtMs: T0 + 100,
      gateDisposition: 'inconclusive',
      runSuite: false,
      recordVerdict: false,
    });
    expect(decideFrozenCandidateRepairQueue(reserved, { nowMs: T0 + 100 })).toMatchObject({
      kind: 'dispatch-fixer',
      reason: 'unassigned',
      nextAttempt: 1,
    });
  });

  it('recovers a definitively dead fixer before an active dispatch reservation can hide it', () => {
    const reserved = markFrozenRepairFixerDispatched(fresh(), {
      spawnId: 'dead-fixer',
      nowMs: T0 + 1,
    });
    const withStaleLease: FrozenCandidateRepairQueue = {
      ...reserved,
      dispatchReservation: {
        token: 'stale-launcher',
        claimedAtMs: T0 + 2,
        expiresAtMs: T0 + 10_000,
      },
    };

    expect(
      decideFrozenCandidateRepairQueue(withStaleLease, {
        nowMs: T0 + 3,
        fixerAlive: false,
      }),
    ).toMatchObject({
      kind: 'recover-dead-fixer',
      fixerSpawnId: 'dead-fixer',
      repairHead: C,
    });

    const recovered = markFrozenRepairFixerDead(withStaleLease, {
      spawnId: 'dead-fixer',
      nowMs: T0 + 4,
    });
    expect(recovered).toMatchObject({ fixerSpawnId: null, attempts: 1, repairHead: C });
    expect(recovered.dispatchReservation).toBeUndefined();
    expect(decideFrozenCandidateRepairQueue(recovered, { nowMs: T0 + 5 })).toMatchObject({
      kind: 'dispatch-fixer',
      reason: 'unassigned',
      nextAttempt: 2,
    });
  });

  it('normalizes queue liveness, age, retirement guard, and the exact CAS action', () => {
    const dead = markFrozenRepairFixerDispatched(fresh(), {
      spawnId: 'dead-fixer',
      nowMs: T0 + 1,
    });
    const diagnostic = diagnoseFrozenCandidateRepairQueue(dead, {
      nowMs: T0 + 2,
      fixerAlive: false,
    });
    expect(diagnostic).toMatchObject({
      phase: 'awaiting-fixer',
      candidate: C,
      repairHead: C,
      fixerSpawnId: 'dead-fixer',
      fixerAlive: false,
      decision: 'recover-dead-fixer',
      retireAllowed: true,
      retireRefusal: null,
    });
    expect(diagnostic?.nextAction).toContain(`expectedUpdatedAtMs: ${dead.updatedAtMs}`);

    expect(
      diagnoseFrozenCandidateRepairQueue(dead, {
        nowMs: T0 + 2,
        fixerAlive: true,
      }),
    ).toMatchObject({ retireAllowed: false, retireRefusal: 'live-fixer', nextAction: null });
  });

  it('verifies exactly the forward head reported by the current fixer', () => {
    const dispatched = markFrozenRepairFixerDispatched(fresh(), {
      spawnId: 'spawn-1',
      nowMs: T0 + 1,
    });
    const finished = markFrozenRepairFixerFinished(dispatched, {
      spawnId: 'spawn-1',
      repairHead: C1,
      nowMs: T0 + 2,
    });
    expect(finished).toMatchObject({
      phase: 'ready-to-verify',
      candidate: C,
      repairHead: C1,
      attempts: 1,
    });
    expect(decideFrozenCandidateRepairQueue(finished, { nowMs: T0 + 3 })).toEqual({
      kind: 'verify-repair',
      candidate: C1,
      originalCandidate: C,
      gateDisposition: 'repair-verification',
      runSuite: true,
      recordVerdict: true,
    });
  });

  it('rejects a late completion from a replaced fixer', () => {
    let queue = markFrozenRepairFixerDispatched(fresh(), {
      spawnId: 'dead-spawn',
      nowMs: T0 + 1,
    });
    expect(decideFrozenCandidateRepairQueue(queue, { nowMs: T0 + 2, fixerAlive: false })).toMatchObject({
      kind: 'recover-dead-fixer',
      fixerSpawnId: 'dead-spawn',
    });
    queue = markFrozenRepairFixerDead(queue, {
      spawnId: 'dead-spawn',
      nowMs: T0 + 2,
    });
    expect(decideFrozenCandidateRepairQueue(queue, { nowMs: T0 + 2 })).toMatchObject({
      kind: 'dispatch-fixer',
      reason: 'unassigned',
      nextAttempt: 2,
    });
    queue = markFrozenRepairFixerDispatched(queue, {
      spawnId: 'replacement-spawn',
      nowMs: T0 + 3,
    });
    expect(() =>
      markFrozenRepairFixerFinished(queue, {
        spawnId: 'dead-spawn',
        repairHead: C1,
        nowMs: T0 + 4,
      }),
    ).toThrow(/stale fixer completion/);
  });

  it('retries a red verification forward from C1 rather than C or a moving tip', () => {
    let queue = markFrozenRepairFixerDispatched(fresh(), {
      spawnId: 'spawn-1',
      nowMs: T0 + 1,
    });
    queue = markFrozenRepairFixerFinished(queue, {
      spawnId: 'spawn-1',
      repairHead: C1,
      nowMs: T0 + 2,
    });
    queue = markFrozenRepairVerificationRed(queue, {
      repairHead: C1,
      failingTests: ['lib/still-red.test.ts'],
      nowMs: T0 + 3,
    });
    expect(queue).toMatchObject({
      phase: 'awaiting-fixer',
      candidate: C,
      repairHead: C1,
      attempts: 1,
      fixerSpawnId: null,
      failingTests: ['lib/still-red.test.ts'],
    });
    expect(decideFrozenCandidateRepairQueue(queue, { nowMs: T0 + 4 })).toMatchObject({
      kind: 'dispatch-fixer',
      nextAttempt: 2,
      repairHead: C1,
    });

    queue = markFrozenRepairFixerDispatched(queue, {
      spawnId: 'spawn-2',
      nowMs: T0 + 5,
    });
    queue = markFrozenRepairFixerFinished(queue, {
      spawnId: 'spawn-2',
      repairHead: C2,
      nowMs: T0 + 6,
    });
    expect(queue.candidate).toBe(C);
    expect(queue.repairHead).toBe(C2);
  });

  it('makes green C1 promotable only after the identical patch is observed on staging', () => {
    let queue = markFrozenRepairFixerDispatched(fresh(), {
      spawnId: 'spawn-1',
      nowMs: T0 + 1,
    });
    queue = markFrozenRepairFixerFinished(queue, {
      spawnId: 'spawn-1',
      repairHead: C1,
      nowMs: T0 + 2,
    });
    queue = markFrozenRepairVerificationGreen(queue, {
      repairHead: C1,
      nowMs: T0 + 3,
    });

    expect(decideFrozenCandidateRepairQueue(queue, { nowMs: T0 + 4 })).toEqual({
      kind: 'inspect-staging-patch',
      candidate: C1,
      originalCandidate: C,
      runSuite: false,
      recordVerdict: false,
    });
    expect(
      decideFrozenCandidateRepairQueue(queue, {
        nowMs: T0 + 4,
        stagingContainsRepair: false,
      }),
    ).toEqual({
      kind: 'hold-staging-mismatch',
      candidate: C1,
      originalCandidate: C,
      gateDisposition: 'inconclusive',
      runSuite: false,
      recordVerdict: false,
    });
    expect(
      decideFrozenCandidateRepairQueue(queue, {
        nowMs: T0 + 4,
        stagingContainsRepair: true,
      }),
    ).toEqual({
      kind: 'promote-repair',
      candidate: C1,
      originalCandidate: C,
      runSuite: false,
      recordVerdict: false,
    });
  });

  it('requeues a staging mismatch through the bounded queue-authorized fixer path', () => {
    let queue = markFrozenRepairFixerDispatched(fresh(), {
      spawnId: 'spawn-1',
      nowMs: T0 + 1,
    });
    queue = markFrozenRepairFixerFinished(queue, {
      spawnId: 'spawn-1',
      repairHead: C1,
      nowMs: T0 + 2,
    });

    queue = markFrozenRepairStagingMismatch(queue, {
      repairHead: C1,
      nowMs: T0 + 3,
    });

    expect(queue).toMatchObject({
      phase: 'awaiting-fixer',
      candidate: C,
      repairHead: C1,
      attempts: 1,
      fixerSpawnId: null,
      failingTests: [FROZEN_REPAIR_STAGING_MISMATCH_SIGNATURE, 'lib/a.test.ts'],
    });
    expect(decideFrozenCandidateRepairQueue(queue, { nowMs: T0 + 4 })).toMatchObject({
      kind: 'dispatch-fixer',
      nextAttempt: 2,
      repairHead: C1,
    });
  });

  it('holds the same queue head at the attempt bound and persists the blocked state', () => {
    let queue = fresh();
    for (let attempt = 1; attempt <= DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS.maxAttempts; attempt++) {
      queue = markFrozenRepairFixerDispatched(queue, {
        spawnId: `spawn-${attempt}`,
        nowMs: T0 + attempt * 10,
      });
      queue = markFrozenRepairFixerFinished(queue, {
        spawnId: `spawn-${attempt}`,
        repairHead: `${attempt}`.repeat(40),
        nowMs: T0 + attempt * 10 + 1,
      });
      queue = markFrozenRepairVerificationRed(queue, {
        repairHead: `${attempt}`.repeat(40),
        nowMs: T0 + attempt * 10 + 2,
      });
    }
    const decision = decideFrozenCandidateRepairQueue(queue, { nowMs: T0 + 100 });
    expect(decision).toEqual({
      kind: 'hold-exhausted',
      reason: 'attempts-exhausted',
      candidate: C,
      repairHead: '3'.repeat(40),
      // P-048: the default escape budget is 0, so exhaustion still holds the pin forever.
      escapesUsed: 0,
      maxCandidateEscapes: 0,
      gateDisposition: 'blocked',
      runSuite: false,
      recordVerdict: false,
    });
    if (decision.kind !== 'hold-exhausted') throw new Error('expected attempt exhaustion');
    queue = markFrozenRepairExhausted(queue, {
      reason: decision.reason,
      nowMs: T0 + 101,
    });
    expect(queue).toMatchObject({
      phase: 'blocked',
      blockedReason: 'attempts-exhausted',
      candidate: C,
      repairHead: '3'.repeat(40),
      fixerSpawnId: null,
    });
    expect(parseFrozenCandidateRepairQueue(queue)).toEqual(queue);
    expect(decideFrozenCandidateRepairQueue(queue, { nowMs: T0 + 102 })).toEqual(decision);
  });

  it('holds at the wall-clock boundary but never blocks an already-green head', () => {
    const expiresAt = T0 + DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS.maxAgeMs;
    expect(decideFrozenCandidateRepairQueue(fresh(), { nowMs: expiresAt })).toMatchObject({
      kind: 'hold-exhausted',
      reason: 'wall-clock-exhausted',
    });

    let green = markFrozenRepairFixerDispatched(fresh(), {
      spawnId: 'spawn-1',
      nowMs: T0 + 1,
    });
    green = markFrozenRepairFixerFinished(green, {
      spawnId: 'spawn-1',
      repairHead: C1,
      nowMs: T0 + 2,
    });
    green = markFrozenRepairVerificationGreen(green, {
      repairHead: C1,
      nowMs: expiresAt - 1,
    });
    expect(
      decideFrozenCandidateRepairQueue(green, {
        nowMs: expiresAt + 1,
        stagingContainsRepair: true,
      }),
    ).toMatchObject({ kind: 'promote-repair', candidate: C1 });
  });

  it('rejects stale verification results instead of promoting an untested head', () => {
    let queue = markFrozenRepairFixerDispatched(fresh(), {
      spawnId: 'spawn-1',
      nowMs: T0 + 1,
    });
    queue = markFrozenRepairFixerFinished(queue, {
      spawnId: 'spawn-1',
      repairHead: C1,
      nowMs: T0 + 2,
    });
    expect(() => markFrozenRepairVerificationGreen(queue, { repairHead: C2, nowMs: T0 + 3 })).toThrow(
      /stale repair result/,
    );
    expect(() => markFrozenRepairVerificationRed(queue, { repairHead: C2, nowMs: T0 + 3 })).toThrow(
      /stale repair result/,
    );
  });

  it('parses only a coherent versioned JSONB record and returns a detached value', () => {
    const raw = fresh();
    const parsed = parseFrozenCandidateRepairQueue(raw);
    expect(parsed).toEqual(raw);
    expect(parsed).not.toBe(raw);
    expect(parsed?.failingTests).not.toBe(raw.failingTests);
    expect(parseFrozenCandidateRepairQueue({ ...raw, schemaVersion: 4 })).toBeNull();
    expect(parseFrozenCandidateRepairQueue({ ...raw, attempts: -1 })).toBeNull();
    expect(parseFrozenCandidateRepairQueue({ ...raw, updatedAtMs: T0 - 1 })).toBeNull();
    expect(
      parseFrozenCandidateRepairQueue({
        ...raw,
        phase: 'ready-to-verify',
        attempts: 0,
        fixerSpawnId: null,
      }),
    ).toBeNull();
    expect(
      parseFrozenCandidateRepairQueue({
        ...raw,
        phase: 'blocked',
        blockedReason: undefined,
      }),
    ).toBeNull();

    const readyToTest = createFrozenCandidateQueue({
      candidate: C,
      base: BASE,
      worktreePath: ROOT,
      nowMs: T0,
    });
    expect(parseFrozenCandidateRepairQueue(readyToTest)).toEqual(readyToTest);
  });
});

/**
 * P-048 (green-main-fast-2026-08-25) — the bounded escape hatch out of a frozen candidate.
 *
 * These tests are written against a specific hazard: all three exhaustion sites return the
 * SAME safe value by default, so a suite that only asserted "it holds" would pass just as
 * happily with the escape budget wired at one site and silently skipped at the other two.
 * Every default-branch assertion therefore pins the DISTINCT `reason` that identifies which
 * site produced it, and each has a positive control proving that same site can re-cut.
 */
describe('frozen-candidate escape hatch (P-048)', () => {
  const WITH_BUDGET = { ...DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS, maxCandidateEscapes: 2 };
  const EXPIRES_AT = T0 + DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS.maxAgeMs;

  /** Drive a queue to the attempt bound (three dispatch -> finish -> red cycles). */
  function attemptsExhausted(): FrozenCandidateRepairQueue {
    let queue = fresh();
    for (let attempt = 1; attempt <= DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS.maxAttempts; attempt++) {
      queue = markFrozenRepairFixerDispatched(queue, {
        spawnId: `spawn-${attempt}`,
        nowMs: T0 + attempt * 10,
      });
      queue = markFrozenRepairFixerFinished(queue, {
        spawnId: `spawn-${attempt}`,
        repairHead: `${attempt}`.repeat(40),
        nowMs: T0 + attempt * 10 + 1,
      });
      queue = markFrozenRepairVerificationRed(queue, {
        repairHead: `${attempt}`.repeat(40),
        nowMs: T0 + attempt * 10 + 2,
      });
    }
    return queue;
  }

  /** A queue already PERSISTED as blocked — the steady state of the deadlock. */
  function persistedBlocked(): FrozenCandidateRepairQueue {
    return markFrozenRepairExhausted(fresh(), {
      reason: 'wall-clock-exhausted',
      nowMs: T0 + 5,
    });
  }

  it('DEFAULT limits keep the historical permanent hold at all three exhaustion sites', () => {
    // Site 1 — persisted blocked. Reason must be the PERSISTED one, not a recomputed default.
    expect(
      decideFrozenCandidateRepairQueue(persistedBlocked(), { nowMs: T0 + 6 }),
    ).toMatchObject({
      kind: 'hold-exhausted',
      reason: 'wall-clock-exhausted',
      escapesUsed: 0,
      maxCandidateEscapes: 0,
    });

    // Site 2 — wall clock.
    expect(decideFrozenCandidateRepairQueue(fresh(), { nowMs: EXPIRES_AT })).toMatchObject({
      kind: 'hold-exhausted',
      reason: 'wall-clock-exhausted',
      maxCandidateEscapes: 0,
    });

    // Site 3 — attempt bound. A DISTINCT reason, which is what proves this is a different site.
    expect(
      decideFrozenCandidateRepairQueue(attemptsExhausted(), { nowMs: T0 + 100 }),
    ).toMatchObject({
      kind: 'hold-exhausted',
      reason: 'attempts-exhausted',
      maxCandidateEscapes: 0,
    });
  });

  it('POSITIVE CONTROL: with a budget, every one of those three sites re-cuts instead', () => {
    // Same three inputs as the test above; only `limits` differs. If any site failed to consult
    // the budget, that site would still return hold-exhausted here and this test would fail.
    expect(
      decideFrozenCandidateRepairQueue(persistedBlocked(), { nowMs: T0 + 6 }, WITH_BUDGET),
    ).toMatchObject({ kind: 'recut-at-tip', reason: 'wall-clock-exhausted' });

    expect(
      decideFrozenCandidateRepairQueue(fresh(), { nowMs: EXPIRES_AT }, WITH_BUDGET),
    ).toMatchObject({ kind: 'recut-at-tip', reason: 'wall-clock-exhausted' });

    expect(
      decideFrozenCandidateRepairQueue(attemptsExhausted(), { nowMs: T0 + 100 }, WITH_BUDGET),
    ).toMatchObject({ kind: 'recut-at-tip', reason: 'attempts-exhausted' });
  });

  it('abandons the pin without recording a verdict on it', () => {
    const decision = decideFrozenCandidateRepairQueue(
      attemptsExhausted(),
      { nowMs: T0 + 100 },
      WITH_BUDGET,
    );
    expect(decision).toEqual({
      kind: 'recut-at-tip',
      reason: 'attempts-exhausted',
      abandonedCandidate: C,
      repairHead: '3'.repeat(40),
      escapeOrdinal: 1,
      remainingEscapes: 1,
      gateDisposition: 'recut',
      // Load-bearing: an escape is NOT a judgement of the abandoned pin. Recording a verdict
      // here would let "we gave up on this candidate" be read as "this candidate is red".
      runSuite: false,
      recordVerdict: false,
    });
  });

  it('BOUND: the budget is spent by prior escapes, and then holds forever', () => {
    const queue = attemptsExhausted();
    // Escapes already used elsewhere in this gate's history, counted from durable gate health.
    expect(
      decideFrozenCandidateRepairQueue(queue, { nowMs: T0 + 100, priorEscapes: 1 }, WITH_BUDGET),
    ).toMatchObject({ kind: 'recut-at-tip', escapeOrdinal: 2, remainingEscapes: 0 });

    // At the ceiling the hatch closes — this is what stops a genuine persistent red from
    // being laundered into perpetual re-cutting.
    expect(
      decideFrozenCandidateRepairQueue(queue, { nowMs: T0 + 100, priorEscapes: 2 }, WITH_BUDGET),
    ).toMatchObject({
      kind: 'hold-exhausted',
      reason: 'attempts-exhausted',
      escapesUsed: 2,
      maxCandidateEscapes: 2,
    });

    // ...and stays closed above the ceiling.
    expect(
      decideFrozenCandidateRepairQueue(queue, { nowMs: T0 + 100, priorEscapes: 9 }, WITH_BUDGET),
    ).toMatchObject({ kind: 'hold-exhausted', escapesUsed: 9 });
  });

  it('distinguishes a DISABLED hatch from a SPENT one at the hold surface', () => {
    const queue = attemptsExhausted();
    const disabled = decideFrozenCandidateRepairQueue(queue, { nowMs: T0 + 100 });
    const spent = decideFrozenCandidateRepairQueue(
      queue,
      { nowMs: T0 + 100, priorEscapes: 2 },
      WITH_BUDGET,
    );
    // Both hold, but the pair (escapesUsed, maxCandidateEscapes) says WHY — without it the two
    // causes are indistinguishable and an accidentally-disabled hatch reads as a real red.
    expect(disabled).toMatchObject({ escapesUsed: 0, maxCandidateEscapes: 0 });
    expect(spent).toMatchObject({ escapesUsed: 2, maxCandidateEscapes: 2 });
  });

  it('reads absent, negative, and fractional priorEscapes as zero', () => {
    const queue = attemptsExhausted();
    for (const priorEscapes of [undefined, -1, -99, 0.7]) {
      expect(
        decideFrozenCandidateRepairQueue(
          queue,
          { nowMs: T0 + 100, ...(priorEscapes === undefined ? {} : { priorEscapes }) },
          WITH_BUDGET,
        ),
      ).toMatchObject({ kind: 'recut-at-tip', escapeOrdinal: 1, remainingEscapes: 1 });
    }
  });

  it('rejects a ceiling that is negative or non-integer', () => {
    for (const maxCandidateEscapes of [-1, 1.5, Number.NaN]) {
      expect(() =>
        decideFrozenCandidateRepairQueue(fresh(), { nowMs: T0 + 1 }, {
          ...DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS,
          maxCandidateEscapes,
        }),
      ).toThrow(/maxCandidateEscapes/);
    }
  });

  it('surfaces escape state on the diagnostic read model', () => {
    const queue = attemptsExhausted();
    expect(
      diagnoseFrozenCandidateRepairQueue(queue, { nowMs: T0 + 100 }),
    ).toMatchObject({
      decision: 'hold-exhausted',
      escapesUsed: 0,
      maxCandidateEscapes: 0,
      escapeAvailable: false,
    });
    expect(
      diagnoseFrozenCandidateRepairQueue(queue, { nowMs: T0 + 100 }, WITH_BUDGET),
    ).toMatchObject({
      decision: 'recut-at-tip',
      escapesUsed: 0,
      maxCandidateEscapes: 2,
      escapeAvailable: true,
    });
    expect(
      diagnoseFrozenCandidateRepairQueue(
        queue,
        { nowMs: T0 + 100, priorEscapes: 2 },
        WITH_BUDGET,
      ),
    ).toMatchObject({ decision: 'hold-exhausted', escapeAvailable: false });
  });

  it('leaves the non-exhausted paths untouched', () => {
    // A budget must not make a HEALTHY queue re-cut: only exhaustion reaches the hatch.
    expect(
      decideFrozenCandidateRepairQueue(fresh(), { nowMs: T0 + 1 }, WITH_BUDGET),
    ).toMatchObject({ kind: 'dispatch-fixer' });
    expect(decideFrozenCandidateRepairQueue(null, { nowMs: T0 + 1 }, WITH_BUDGET)).toEqual({
      kind: 'run-normal-gate',
      runSuite: true,
      recordVerdict: true,
    });
  });
});

describe('P-009 — shared-tree collision detector (REPORT-ONLY)', () => {
  /**
   * PERMANENT DELIBERATELY-WRONG CONTROL (CLAUDE.md: no cp/mutate/restore — the subject is a
   * module we import, so the wrong implementation lives here forever as a control).
   *
   * This is the naive detector this guard must NOT be. It commits the two errors that make a
   * report-only guard worse than none: it reports `measured: true` when nothing was measured
   * (a false all-clear), and it ignores the repair phase (a false alarm before any repair
   * exists). Every assertion below must REJECT this shape.
   */
  function naiveCollision(
    queue: FrozenCandidateRepairQueue | null,
    edited: readonly string[] | null | undefined,
  ) {
    const failing = queue?.failingTests ?? [];
    const paths = (edited ?? []).filter((p) => failing.includes(p));
    return { measured: true, collidingPaths: paths, collisionCount: paths.length };
  }

  const inFlight = (): FrozenCandidateRepairQueue => ({
    ...fresh(),
    failingTests: ['lib/a.test.ts', 'lib/b.test.ts'],
  });

  it('CALIBRATION: on a plain collision the real detector and the control agree', () => {
    // Without this, every "differs from the control" assertion below would also pass if the
    // detector were simply broken in some unrelated way.
    const q = inFlight();
    const got = detectFrozenRepairSharedTreeCollision(q, ['lib/a.test.ts']);
    expect(got.collidingPaths).toEqual(naiveCollision(q, ['lib/a.test.ts']).collidingPaths);
    expect(got.measured).toBe(true);
    expect(got.repairInFlight).toBe(true);
    expect(got.collisionCount).toBe(1);
  });

  it('says so LOUDLY: names the worktree and that a shared-checkout edit is NOT admission', () => {
    const got = detectFrozenRepairSharedTreeCollision(inFlight(), ['lib/b.test.ts']);
    expect(got.detail).toContain('FROZEN-REPAIR COLLISION');
    expect(got.detail).toContain(ROOT);
    expect(got.detail).toContain('NOT admission');
    expect(got.detail).toContain('lib/b.test.ts');
  });

  it('NOT MEASURED is not an all-clear — the control calls it measured, this must not', () => {
    // The whole point of the field. A failed/absent measurement that renders as zero
    // collisions is a false all-clear precisely when the measurement broke.
    const q = inFlight();
    for (const missing of [null, undefined]) {
      const got = detectFrozenRepairSharedTreeCollision(q, missing);
      expect(got.measured).toBe(false);
      expect(got.measured).not.toBe(naiveCollision(q, missing).measured);
      expect(got.collisionCount).toBe(0);
      // ...and it must still SAY that it did not measure, rather than going silent.
      expect(got.detail).toContain('NOT MEASURED');
    }
  });

  it('ready-to-test is NOT in flight, so an overlapping edit is not a collision', () => {
    // No repair exists yet — the candidate has not had its first suite, so an edit races nothing.
    // The control fires here; the real detector must not.
    const q: FrozenCandidateRepairQueue = { ...inFlight(), phase: 'ready-to-test' };
    const got = detectFrozenRepairSharedTreeCollision(q, ['lib/a.test.ts']);
    expect(got.repairInFlight).toBe(false);
    expect(got.collisionCount).toBe(0);
    expect(got.detail).toBeNull();
    expect(naiveCollision(q, ['lib/a.test.ts']).collisionCount).toBe(1); // the control's false alarm
  });

  it('blocked IS in flight — the head stays immutable and nobody is watching', () => {
    const q: FrozenCandidateRepairQueue = { ...inFlight(), phase: 'blocked' };
    const got = detectFrozenRepairSharedTreeCollision(q, ['lib/a.test.ts']);
    expect(got.repairInFlight).toBe(true);
    expect(got.collisionCount).toBe(1);
  });

  it('normalizes ./ and backslash paths the control compares literally', () => {
    const q = inFlight();
    const edited = ['./lib/a.test.ts', 'lib\\b.test.ts'];
    const got = detectFrozenRepairSharedTreeCollision(q, edited);
    expect(got.collidingPaths).toEqual(['lib/a.test.ts', 'lib/b.test.ts']);
    expect(naiveCollision(q, edited).collisionCount).toBe(0); // the control misses both
  });

  it('caps the listed paths but reports the TRUE count and marks the truncation', () => {
    const many = Array.from({ length: FROZEN_REPAIR_COLLISION_PATH_DISPLAY_CAP + 5 }, (_, i) => `lib/t${i}.test.ts`);
    const q: FrozenCandidateRepairQueue = { ...fresh(), failingTests: many };
    const got = detectFrozenRepairSharedTreeCollision(q, many);
    expect(got.collidingPaths).toHaveLength(FROZEN_REPAIR_COLLISION_PATH_DISPLAY_CAP);
    expect(got.collisionCount).toBe(many.length); // the count must NOT be capped
    expect(got.truncated).toBe(true);
    expect(got.detail).toContain('5 more');
  });

  it('is REPORT-ONLY: a collision changes no control field of the diagnostic', () => {
    // The plan asks for detection FIRST. If this ever fails, the guard has started
    // blocking on a signal that was only supposed to be reported.
    const q = inFlight();
    const clean = diagnoseFrozenCandidateRepairQueue(q, { nowMs: T0 + 1, sharedTreeEditedPaths: [] });
    const colliding = diagnoseFrozenCandidateRepairQueue(q, {
      nowMs: T0 + 1,
      sharedTreeEditedPaths: ['lib/a.test.ts', 'lib/b.test.ts'],
    });
    expect(colliding!.sharedTreeCollision.collisionCount).toBe(2); // the collision really is seen
    for (const field of ['decision', 'retireAllowed', 'retireRefusal', 'nextAction'] as const) {
      expect(colliding![field]).toEqual(clean![field]);
    }
  });
});

describe('P-013 / D-007 — convergence rounds + the owner-visible off switch', () => {
  /** A queue parked at the phase a red repair verification is legal from. */
  function readyToVerify(
    overrides: Partial<FrozenCandidateRepairQueue> = {},
  ): FrozenCandidateRepairQueue {
    return {
      ...fresh(),
      phase: 'ready-to-verify',
      attempts: 1,
      fixerSpawnId: 'spawn-1',
      ...overrides,
    };
  }

  /**
   * PERMANENT deliberately-wrong control. This is the obvious ring-buffer trim, and it is
   * wrong in exactly one way: it drops the FIRST round, which is the baseline every shrink
   * figure is measured against. It stays in this file so the real cap has something to be
   * different from — if a refactor makes `capConvergenceRounds` behave like this, the test
   * below that compares them starts failing instead of silently passing.
   */
  function naiveCap<T>(rounds: readonly T[], cap: number): T[] {
    return rounds.slice(-cap);
  }

  it('CALIBRATION: the first red seeds round 1, so a shrink always has a baseline', () => {
    // createFrozenCandidateRepairQueue routes through markFrozenCandidateVerificationRed,
    // so creation IS the first red. If this stops being true, `failingFirst` silently
    // becomes the SECOND red and every shrink figure understates by one round.
    const queue = fresh();
    expect(queue.convergenceRounds).toEqual([
      { round: 1, head: C, failingCount: 1, atMs: T0 },
    ]);
  });

  it('each subsequent red appends a round with its failing-set size', () => {
    const first = readyToVerify();
    const second = markFrozenRepairVerificationRed(first, {
      repairHead: C,
      failingTests: ['lib/a.test.ts', 'lib/b.test.ts'],
      nowMs: T0 + 1_000,
    });
    expect(second.convergenceRounds).toEqual([
      { round: 1, head: C, failingCount: 1, atMs: T0 },
      { round: 2, head: C, failingCount: 2, atMs: T0 + 1_000 },
    ]);
  });

  it('LOAD-BEARING: trimming to the cap retains the FIRST round, unlike a naive ring buffer', () => {
    const many = Array.from({ length: FROZEN_REPAIR_CONVERGENCE_ROUND_CAP + 6 }, (_, i) => ({
      round: i + 1,
      head: C,
      // A genuinely converging cycle: 40 failures shrinking by one each round.
      failingCount: 40 - i,
      atMs: T0 + i * 1_000,
    }));
    const parsed = parseFrozenCandidateRepairQueue({
      ...readyToVerify(),
      convergenceRounds: many,
    });
    expect(parsed).not.toBeNull();
    const kept = parsed!.convergenceRounds!;
    expect(kept).toHaveLength(FROZEN_REPAIR_CONVERGENCE_ROUND_CAP);
    // The whole point: round 1 survives the trim.
    expect(kept[0]).toEqual(many[0]);
    expect(kept[kept.length - 1]).toEqual(many[many.length - 1]);
    // ...and the naive trim, which is what a reasonable person writes first, does NOT.
    const naive = naiveCap(many, FROZEN_REPAIR_CONVERGENCE_ROUND_CAP);
    expect(naive[0]).not.toEqual(many[0]);
    expect(kept).not.toEqual(naive);
  });

  it('round numbers keep counting after a trim — history is never renumbered', () => {
    const many = Array.from({ length: FROZEN_REPAIR_CONVERGENCE_ROUND_CAP + 3 }, (_, i) => ({
      round: i + 1,
      head: C,
      failingCount: 30 - i,
      atMs: T0 + i * 1_000,
    }));
    const queue = readyToVerify({ convergenceRounds: many });
    const next = markFrozenRepairVerificationRed(queue, {
      repairHead: C,
      failingTests: [],
      nowMs: T0 + 99_000,
    });
    const rounds = next.convergenceRounds!;
    // Highest existing round was cap+3; the new one must be cap+4, not a reused index.
    expect(rounds[rounds.length - 1]!.round).toBe(FROZEN_REPAIR_CONVERGENCE_ROUND_CAP + 4);
    expect(new Set(rounds.map((r) => r.round)).size).toBe(rounds.length);
  });

  it('a legacy queue with no rounds parses, and reads as "none recorded" not "not converging"', () => {
    const legacy = { ...fresh() } as Record<string, unknown>;
    delete legacy.convergenceRounds;
    const parsed = parseFrozenCandidateRepairQueue(legacy);
    expect(parsed).not.toBeNull();
    expect(parsed!.convergenceRounds).toBeUndefined();
    const summary = summarizeFrozenRepairConvergence(parsed!, T0 + 5_000);
    expect(summary.admissionRounds).toBe(0);
    expect(summary.failingFirst).toBeNull();
    expect(summary.shrinkTotal).toBeNull();
    // NOT false — "no rounds recorded" is not evidence of a treadmill.
    expect(summary.converging).toBeNull();
  });

  it('malformed rounds are dropped WITHOUT failing the parse — the queue is safety state', () => {
    const parsed = parseFrozenCandidateRepairQueue({
      ...readyToVerify(),
      convergenceRounds: [
        { round: 1, head: C, failingCount: 5, atMs: T0 },
        { round: 0, head: C, failingCount: 5, atMs: T0 },
        { round: 2, head: '', failingCount: 5, atMs: T0 },
        { round: 3, head: C, failingCount: -1, atMs: T0 },
        { round: 4, head: C, failingCount: 2, atMs: 'nope' },
        'not-an-object',
      ],
    });
    // The queue itself survives — refusing it would discard the frozen head.
    expect(parsed).not.toBeNull();
    expect(parsed!.repairHead).toBe(C);
    expect(parsed!.convergenceRounds).toEqual([
      { round: 1, head: C, failingCount: 5, atMs: T0 },
    ]);
  });

  it('summarizes a converging cycle: monotonic shrink to a smaller set', () => {
    const queue = readyToVerify({
      failingTests: ['lib/a.test.ts'],
      convergenceRounds: [
        { round: 1, head: C, failingCount: 12, atMs: T0 },
        { round: 2, head: C, failingCount: 5, atMs: T0 + 1_000 },
        { round: 3, head: C, failingCount: 1, atMs: T0 + 2_000 },
      ],
    });
    const summary = summarizeFrozenRepairConvergence(queue, T0 + 10_000);
    expect(summary).toMatchObject({
      openedAtMs: T0,
      ageMs: 10_000,
      admissionRounds: 3,
      failingFirst: 12,
      failingNow: 1,
      shrinkTotal: 11,
      converging: true,
    });
    expect(summary.shrinkPerRound).toEqual([
      { round: 1, failingCount: 12, delta: null },
      { round: 2, failingCount: 5, delta: -7 },
      { round: 3, failingCount: 1, delta: -4 },
    ]);
  });

  it('a cycle whose failing set GREW is not reported as converging', () => {
    const queue = readyToVerify({
      failingTests: Array.from({ length: 9 }, (_, i) => `lib/${i}.test.ts`),
      convergenceRounds: [
        { round: 1, head: C, failingCount: 4, atMs: T0 },
        { round: 2, head: C, failingCount: 9, atMs: T0 + 1_000 },
      ],
    });
    const summary = summarizeFrozenRepairConvergence(queue, T0 + 2_000);
    expect(summary.shrinkTotal).toBe(-5);
    expect(summary.converging).toBe(false);
  });

  it('a single recorded round is UNKNOWN, never a verdict', () => {
    const summary = summarizeFrozenRepairConvergence(fresh(), T0 + 1_000);
    expect(summary.admissionRounds).toBe(1);
    // One data point cannot establish a trend in either direction.
    expect(summary.converging).toBeNull();
  });

  it('off switch: ON (the deployed default) opens a cycle on a first real red', () => {
    expect(
      decideFrozenConvergenceCycleEntry({ flagEnabled: true, hasOpenQueue: false }),
    ).toEqual({ kind: 'open-cycle', reason: 'first-real-red' });
  });

  it('off switch: OFF suppresses a NEW cycle', () => {
    expect(
      decideFrozenConvergenceCycleEntry({ flagEnabled: false, hasOpenQueue: false }),
    ).toEqual({ kind: 'suppressed', reason: 'off-switch-disabled' });
  });

  it('LOAD-BEARING: an ALREADY-OPEN cycle is never suppressed, even with the switch OFF', () => {
    // Turning the default off must stop new cycles opening; abandoning a candidate that is
    // mid-convergence would strand its repair worktree and un-freeze a head the gate has
    // already committed to. Both switch positions must agree here.
    expect(
      decideFrozenConvergenceCycleEntry({ flagEnabled: false, hasOpenQueue: true }),
    ).toEqual({ kind: 'advance-existing-cycle', reason: 'queue-already-open' });
    expect(
      decideFrozenConvergenceCycleEntry({ flagEnabled: true, hasOpenQueue: true }),
    ).toEqual(decideFrozenConvergenceCycleEntry({ flagEnabled: false, hasOpenQueue: true }));
  });
});

describe('P-013 / D-007 — the gate_health.convergence PROJECTION', () => {
  /**
   * PERMANENT deliberately-wrong control (CLAUDE.md: prove falsifiability without mutating the
   * shared tree). This is the projection an implementer writes when they treat "put the summary
   * in gate_health" as a copy job: it carries the numbers and drops the cycle IDENTITY and the
   * observation stamp. Every assertion below must REJECT it. It also proves the assertions are
   * not merely restating `summarizeFrozenRepairConvergence`, which they would pass unchanged.
   */
  function naiveProjection(queue: FrozenCandidateRepairQueue, nowMs: number): Record<string, unknown> {
    return { ...summarizeFrozenRepairConvergence(queue, nowMs) };
  }

  function twoRoundQueue(): FrozenCandidateRepairQueue {
    return parseFrozenCandidateRepairQueue({
      ...fresh(),
      failingTests: ['lib/a.test.ts'],
      convergenceRounds: [
        { round: 1, head: C, failingCount: 5, atMs: T0 },
        { round: 2, head: C1, failingCount: 1, atMs: T0 + 1_000 },
      ],
    })!;
  }

  it('CALIBRATION: the real projection carries every summary field unchanged', () => {
    // If this fails, the controls below prove nothing — they would be rejecting the honest
    // projection for the wrong reason.
    const queue = twoRoundQueue();
    const summary = summarizeFrozenRepairConvergence(queue, T0 + 2_000);
    const projected = buildFrozenRepairConvergenceGateHealth(queue, T0 + 2_000);
    expect(projected).toMatchObject(summary as unknown as Record<string, unknown>);
    expect(projected.converging).toBe(true);
    expect(projected.shrinkTotal).toBe(4);
  });

  it('LOAD-BEARING: the projection names WHICH cycle it describes — the naive one cannot', () => {
    const queue = twoRoundQueue();
    const projected = buildFrozenRepairConvergenceGateHealth(queue, T0 + 2_000);
    expect(projected.candidate).toBe(queue.candidate);
    expect(projected.repairHead).toBe(queue.repairHead);
    expect(projected.phase).toBe(queue.phase);
    // The control: shrink figures with no cycle identity read as describing whatever candidate
    // the reader is currently looking at.
    const control = naiveProjection(queue, T0 + 2_000);
    expect(control.candidate).toBeUndefined();
    expect(control.repairHead).toBeUndefined();
    expect(control.phase).toBeUndefined();
  });

  it('LOAD-BEARING: the projection is stamped, so a stale reading is distinguishable', () => {
    const projected = buildFrozenRepairConvergenceGateHealth(twoRoundQueue(), T0 + 9_000);
    expect(projected.observedAtMs).toBe(T0 + 9_000);
    expect(naiveProjection(twoRoundQueue(), T0 + 9_000).observedAtMs).toBeUndefined();
  });

  it('round-trips through JSON — what PG stores is what a reader gets back', () => {
    const projected = buildFrozenRepairConvergenceGateHealth(twoRoundQueue(), T0 + 2_000);
    expect(parseFrozenRepairConvergence(JSON.parse(JSON.stringify(projected)))).toEqual(projected);
  });

  it('the parser REJECTS the naive projection rather than rendering it with holes', () => {
    // A blob missing the identity fields is not a degraded reading to be shown with blanks; it
    // is a reading whose subject is unknown.
    const control = naiveProjection(twoRoundQueue(), T0 + 2_000);
    expect(parseFrozenRepairConvergence(JSON.parse(JSON.stringify(control)))).toBeNull();
  });

  it('absent / cleared / malformed all read as null — never as a clean zero', () => {
    expect(parseFrozenRepairConvergence(undefined)).toBeNull();
    // JSON null is how the retire paths CLEAR the projection.
    expect(parseFrozenRepairConvergence(null)).toBeNull();
    expect(parseFrozenRepairConvergence('convergence')).toBeNull();
    expect(parseFrozenRepairConvergence([])).toBeNull();
    const good = JSON.parse(
      JSON.stringify(buildFrozenRepairConvergenceGateHealth(twoRoundQueue(), T0 + 2_000)),
    ) as Record<string, unknown>;
    expect(parseFrozenRepairConvergence({ ...good, shrinkPerRound: 'lots' })).toBeNull();
    expect(parseFrozenRepairConvergence({ ...good, shrinkPerRound: [{ round: 1 }] })).toBeNull();
  });

  it('LOAD-BEARING: a wrong-typed tri-state is REJECTED, not coerced to "not yet knowable"', () => {
    const good = JSON.parse(
      JSON.stringify(buildFrozenRepairConvergenceGateHealth(twoRoundQueue(), T0 + 2_000)),
    ) as Record<string, unknown>;
    // `converging: null` is a legitimate stored value ("fewer than two rounds"), so a corrupt
    // value coerced to null would be indistinguishable from an honest unknown.
    expect(parseFrozenRepairConvergence({ ...good, converging: 'yes' })).toBeNull();
    expect(parseFrozenRepairConvergence({ ...good, failingFirst: 'five' })).toBeNull();
    expect(parseFrozenRepairConvergence({ ...good, shrinkTotal: '4' })).toBeNull();
  });

  it('a genuinely-unknown cycle parses, with its nulls intact', () => {
    // One round: converging is NULL by design. The parser must accept that, or the projection
    // would only ever be readable for cycles that already have a verdict.
    const projected = buildFrozenRepairConvergenceGateHealth(fresh(), T0 + 1_000);
    expect(projected.converging).toBeNull();
    const parsed = parseFrozenRepairConvergence(JSON.parse(JSON.stringify(projected)));
    expect(parsed).not.toBeNull();
    expect(parsed!.converging).toBeNull();
    expect(parsed!.admissionRounds).toBe(1);
  });
});
