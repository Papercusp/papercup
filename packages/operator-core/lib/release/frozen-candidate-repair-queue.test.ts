import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS,
  FROZEN_REPAIR_STAGING_MISMATCH_SIGNATURE,
  createFrozenCandidateQueue,
  createFrozenCandidateRepairQueue,
  decideFrozenCandidateRepairQueue,
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
