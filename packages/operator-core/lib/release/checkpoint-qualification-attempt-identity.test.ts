/**
 * EI-22931381517977345 / WI-10000288: the logical qualification attempt id must follow the
 * frozen repair queue's VERIFICATION TARGET. Before this guard, a `release:checkpoint-run`
 * with no declared paths hashed to a per-root constant (the preflight yields candidate:null /
 * tip:null), so a single terminal code-inconclusive attempt refused every later verify of the
 * lineage via the same-id 'terminal' branch — even after an admission advanced `repairHead`.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  beginQualificationTransaction,
  frozenRepairQueueVerificationTarget,
  resolveQualificationAttemptId,
  type BeginQualificationInput,
  type CheckpointQualificationTransaction,
} from './checkpoint-qualification-transaction';

const CANDIDATE = '9aa9e7887a26e09d040950c86602673cc07c39c9';
const REPAIR_HEAD_A = 'ded5e5307c7df0e2169d4f47aa7fe5e5afc24db8';
const REPAIR_HEAD_B = 'd5c9f96b0dfb89d9d9178e18928b1822ce8555b7';
const CONSTANT_ID = 'e4cb9f6f57293bcf1412611e';

const idFor = (target: string): string =>
  createHash('sha256').update(JSON.stringify({ candidate: target, tip: target, paths: [] })).digest('hex').slice(0, 24);

const queue = (repairHead: string, phase = 'ready-to-verify') => ({
  schemaVersion: 4,
  phase,
  candidate: CANDIDATE,
  repairHead,
});

const input = (overrides: Partial<BeginQualificationInput> = {}): BeginQualificationInput => ({
  attemptId: CONSTANT_ID,
  declaredPaths: [],
  candidate: null,
  attemptIdForVerificationTarget: idFor,
  ...overrides,
});

function terminalAttempt(attemptId: string, candidate: string): CheckpointQualificationTransaction {
  const nowMs = 1_789_084_022_873;
  return {
    schemaVersion: 1,
    attemptId,
    createdAtMs: nowMs,
    updatedAtMs: nowMs + 1,
    requiredAncestorSha: null,
    candidatePolicy: { kind: 'quiet-cut', declaredPaths: [] },
    candidate,
    repairHead: null,
    runId: null,
    phase: 'terminal',
    phaseEnteredAtMs: nowMs + 1,
    phaseDurationsMs: {},
    outcome: { kind: 'code-inconclusive', reason: 'error' },
    blockers: [],
    waitGeneration: 1,
    currentPhysicalRunner: null,
    consumedPhysicalRuns: [],
    evidenceRefs: [],
    previousAttemptId: null,
    eligibilitySnapshot: null,
  } as CheckpointQualificationTransaction;
}

describe('frozenRepairQueueVerificationTarget', () => {
  it('prefers the advanced repairHead and falls back to the frozen candidate', () => {
    expect(frozenRepairQueueVerificationTarget(queue(REPAIR_HEAD_A))).toBe(REPAIR_HEAD_A);
    expect(frozenRepairQueueVerificationTarget({ candidate: CANDIDATE, repairHead: '  ' })).toBe(CANDIDATE);
  });

  it('is null for a missing, malformed, or empty queue row', () => {
    expect(frozenRepairQueueVerificationTarget(null)).toBeNull();
    expect(frozenRepairQueueVerificationTarget([REPAIR_HEAD_A])).toBeNull();
    expect(frozenRepairQueueVerificationTarget({ phase: 'ready-to-verify' })).toBeNull();
  });
});

describe('resolveQualificationAttemptId', () => {
  it('keeps the caller id when no queue exists or no derivation was supplied', () => {
    expect(resolveQualificationAttemptId(input(), null)).toBe(CONSTANT_ID);
    expect(resolveQualificationAttemptId(input({ attemptIdForVerificationTarget: undefined }), queue(REPAIR_HEAD_A))).toBe(
      CONSTANT_ID,
    );
  });

  it('derives a DISTINCT id per verification target, stable for the same target', () => {
    const a = resolveQualificationAttemptId(input(), queue(REPAIR_HEAD_A));
    const b = resolveQualificationAttemptId(input(), queue(REPAIR_HEAD_B));
    expect(a).not.toBe(CONSTANT_ID);
    expect(b).not.toBe(CONSTANT_ID);
    expect(a).not.toBe(b);
    expect(resolveQualificationAttemptId(input(), queue(REPAIR_HEAD_A))).toBe(a);
  });

  it('falls back to the caller id when the derivation returns nothing usable', () => {
    expect(resolveQualificationAttemptId(input({ attemptIdForVerificationTarget: () => '  ' }), queue(REPAIR_HEAD_A))).toBe(
      CONSTANT_ID,
    );
  });
});

describe('beginQualificationTransaction with a queue-derived attempt id', () => {
  it('an advanced repairHead after a terminal predecessor installs a NEW attempt (the recurrence guard)', () => {
    const predecessor = terminalAttempt(resolveQualificationAttemptId(input(), queue(REPAIR_HEAD_A)), REPAIR_HEAD_A);
    const successorId = resolveQualificationAttemptId(input(), queue(REPAIR_HEAD_B));
    const transition = beginQualificationTransaction(predecessor, { ...input(), attemptId: successorId, nowMs: 2 });
    expect(transition.status).toBe('updated');
    expect(transition.transaction.attemptId).toBe(successorId);
    expect(transition.transaction.previousAttemptId).toBe(predecessor.attemptId);
  });

  it('the SAME verification target still refuses as terminal (a real verdict is never auto-retried)', () => {
    const id = resolveQualificationAttemptId(input(), queue(REPAIR_HEAD_A));
    const transition = beginQualificationTransaction(terminalAttempt(id, REPAIR_HEAD_A), { ...input(), attemptId: id, nowMs: 2 });
    expect(transition.status).toBe('terminal');
  });

  it('the pre-fix constant id would have collided with the terminal predecessor (documents the bug)', () => {
    const transition = beginQualificationTransaction(terminalAttempt(CONSTANT_ID, REPAIR_HEAD_A), {
      ...input({ attemptIdForVerificationTarget: undefined }),
      nowMs: 2,
    });
    expect(transition.status).toBe('terminal');
  });
});
