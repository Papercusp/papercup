import { describe, expect, it } from 'vitest';
import {
  CHECKPOINT_ELIGIBILITY_PREDICATES,
  buildCheckpointEligibilitySnapshot,
  parseCheckpointEligibilitySnapshot,
  type CheckpointEligibilityPredicate,
} from './checkpoint-eligibility-snapshot';

const clearPredicates = (): CheckpointEligibilityPredicate[] =>
  CHECKPOINT_ELIGIBILITY_PREDICATES.map((code) => ({
    code,
    status: 'clear',
    detail: `${code} clear`,
    clearEvents: [],
    evidenceRefs: [`test:${code}`],
  }));

describe('checkpoint eligibility snapshot', () => {
  it('returns exactly one launch action when every required predicate is clear', () => {
    const snapshot = buildCheckpointEligibilitySnapshot({
      attemptId: 'attempt-1',
      candidate: 'abc123',
      observedAtMs: 100,
      predicates: clearPredicates(),
    });

    expect(snapshot.predicates.map((predicate) => predicate.code)).toEqual(
      CHECKPOINT_ELIGIBILITY_PREDICATES,
    );
    expect(snapshot.blockers).toEqual([]);
    expect(snapshot.safeNextAction).toEqual({
      code: 'launch-physical-run',
      reason: 'every qualification predicate is clear at one action instant',
      waitEvents: [],
    });
    expect(parseCheckpointEligibilitySnapshot(snapshot)).toEqual(snapshot);
  });

  it('treats named detached preflights as resolved but permits only the preflight runner', () => {
    const predicates = clearPredicates().map((predicate) =>
      ['candidate-migrations', 'dependency-generation', 'target-relation-reservation'].includes(predicate.code)
        ? { ...predicate, status: 'deferred' as const, detail: `${predicate.code} enforced before suite` }
        : predicate,
    );
    const snapshot = buildCheckpointEligibilitySnapshot({
      attemptId: 'attempt-2',
      predicates,
    });

    expect(snapshot.blockers).toEqual([]);
    expect(snapshot.safeNextAction.code).toBe('launch-preflight-runner');
  });

  it('deduplicates a blocker wait tree and prefers the active-run action', () => {
    const predicates = clearPredicates().map((predicate) =>
      predicate.code === 'active-run'
        ? {
            ...predicate,
            status: 'waiting' as const,
            detail: 'runner-1 owns the live lease',
            clearEvents: ['release:green:papercusp', 'release:green:papercusp'],
          }
        : predicate.code === 'quiet-cut-containment'
          ? {
              ...predicate,
              status: 'waiting' as const,
              clearEvents: ['release:green:papercusp', 'green-checkpoint:red:papercusp'],
            }
          : predicate,
    );
    const snapshot = buildCheckpointEligibilitySnapshot({ attemptId: 'attempt-3', predicates });

    expect(snapshot.safeNextAction).toEqual({
      code: 'await-current-run',
      reason: 'runner-1 owns the live lease',
      waitEvents: ['release:green:papercusp', 'green-checkpoint:red:papercusp'],
    });
  });

  it('fails closed when a required predicate is missing or duplicated', () => {
    const missing = buildCheckpointEligibilitySnapshot({
      attemptId: 'attempt-4',
      predicates: clearPredicates().filter((predicate) => predicate.code !== 'backup-admission'),
    });
    expect(missing.blockers).toContainEqual(expect.objectContaining({
      code: 'backup-admission',
      status: 'unreadable',
    }));
    expect(missing.safeNextAction.code).toBe('read-release-control');

    const duplicated = buildCheckpointEligibilitySnapshot({
      attemptId: 'attempt-5',
      predicates: [...clearPredicates(), clearPredicates()[0]!],
    });
    expect(duplicated.blockers).toContainEqual(expect.objectContaining({
      code: 'serializer-authority',
      status: 'unreadable',
    }));
  });
});
