import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS,
  createFrozenCandidateRepairQueue,
  decideFrozenCandidateRepairQueue,
  markFrozenRepairFixerDispatched,
  markFrozenRepairFixerFinished,
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
      schemaVersion: 1,
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

  it('persists the initial proof group and parses legacy or malformed proof state fail-closed', () => {
    const current = createFrozenCandidateRepairQueue({
      candidate: C,
      base: BASE,
      worktreePath: ROOT,
      affectedTestProofGroup: 'initial-gate-run',
      nowMs: T0,
    });
    expect(current).toMatchObject({
      schemaVersion: 2,
      affectedTestProofGroup: 'initial-gate-run',
    });
    expect(
      parseFrozenCandidateRepairQueue({
        ...current,
        schemaVersion: 1,
        affectedTestProofGroup: undefined,
      }),
    ).toMatchObject({ schemaVersion: 1, affectedTestProofGroup: null });
    expect(
      parseFrozenCandidateRepairQueue({
        ...current,
        affectedTestProofGroup: { corrupt: true },
      }),
    ).toMatchObject({ schemaVersion: 2, affectedTestProofGroup: null });
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
      kind: 'dispatch-fixer',
      reason: 'fixer-dead',
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

  it('abandons honestly at the attempt bound and allows a fresh tip cut', () => {
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
    expect(decideFrozenCandidateRepairQueue(queue, { nowMs: T0 + 100 })).toEqual({
      kind: 'abandon-repair',
      reason: 'attempts-exhausted',
      candidate: C,
      repairHead: '3'.repeat(40),
      allowFreshCandidate: true,
      runSuite: false,
      recordVerdict: false,
    });
  });

  it('abandons at the wall-clock boundary but never discards an already-green head', () => {
    const expiresAt = T0 + DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS.maxAgeMs;
    expect(decideFrozenCandidateRepairQueue(fresh(), { nowMs: expiresAt })).toMatchObject({
      kind: 'abandon-repair',
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
    expect(parseFrozenCandidateRepairQueue({ ...raw, schemaVersion: 2 })).toBeNull();
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
  });
});
