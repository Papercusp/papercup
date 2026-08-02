import { describe, it, expect } from 'vitest';
import {
  isLockTimeoutFailure,
  isDeadlockFailure,
  isSerializationFailure,
  isRetryableLockFailure,
  lockRetryBackoffMs,
} from './pg-retryable-failure';
import { contentionRetryBackoffMs } from './db-boot-migrate';

describe('pg retryable-failure predicates (EI-19320461261471579)', () => {
  it('matches the EXACT error string the green gate reported on migration 721', () => {
    // Not a paraphrase — this is the text from the 2026-08-02 05:50Z/06:01Z
    // gate logs, via `${f.file}: ${f.error}`. If the upstream runner ever
    // rewords its error, THIS is the assertion that catches it, because a
    // predicate that stops matching fails open: the migration is left pending
    // and the gate silently goes back to aborting runs as inconclusive.
    expect(isDeadlockFailure('deadlock detected')).toBe(true);
    expect(isRetryableLockFailure('deadlock detected')).toBe(true);
  });

  it('recognises all three retryable contention classes', () => {
    expect(isLockTimeoutFailure('ERROR:  canceling statement due to lock timeout')).toBe(true);
    expect(isDeadlockFailure('ERROR:  deadlock detected')).toBe(true);
    expect(isSerializationFailure('ERROR:  could not serialize access due to concurrent update')).toBe(true);
    for (const s of [
      'ERROR:  canceling statement due to lock timeout',
      'ERROR:  deadlock detected',
      'ERROR:  could not serialize access due to read/write dependencies among transactions',
    ]) {
      expect(isRetryableLockFailure(s)).toBe(true);
    }
  });

  it('is case-insensitive and tolerates PG DETAIL noise around the match', () => {
    expect(isDeadlockFailure('error: DEADLOCK DETECTED')).toBe(true);
    expect(
      isDeadlockFailure(
        'ERROR:  deadlock detected\nDETAIL:  Process 181887 waits for AccessExclusiveLock on relation 16306610;\n' +
          'blocked by process 3301494.',
      ),
    ).toBe(true);
  });

  it('does NOT retry a genuine defect — the property that keeps a broken migration loud', () => {
    // A syntax error or constraint violation must fail immediately. Retrying a
    // real defect would turn a fast, clear failure into a slow, confusing one.
    for (const s of [
      'ERROR: syntax error at or near "FOO"',
      'ERROR:  null value in column "id" violates not-null constraint',
      'ERROR:  relation "harness_shared.nope" does not exist',
      'ERROR:  canceling statement due to statement timeout', // statement != lock timeout
      '',
    ]) {
      expect(isRetryableLockFailure(s)).toBe(false);
    }
  });
});

describe('backoff budgets', () => {
  it('db:migrate backoff is the long one (2s → capped 30s)', () => {
    expect(lockRetryBackoffMs(1)).toBe(2000);
    expect(lockRetryBackoffMs(2)).toBe(4000);
    expect(lockRetryBackoffMs(5)).toBe(30_000);
    expect(lockRetryBackoffMs(99)).toBe(30_000);
  });

  it('the BOOT/gate-preflight backoff is deliberately much tighter than db:migrate', () => {
    // This path runs on operator boot and inside the green-checkpoint
    // preflight, so a 30s stall would delay the dev-api the whole fleet
    // shares. A deadlock needs a short wait, not a long one: Postgres has
    // already broken the cycle by killing one side.
    expect(contentionRetryBackoffMs(1)).toBe(400);
    expect(contentionRetryBackoffMs(2)).toBe(800);
    expect(contentionRetryBackoffMs(99)).toBe(2000);
    // The invariant that matters, stated as a relation rather than a number:
    // the boot budget must stay strictly tighter than the hand-apply budget.
    for (const attempt of [1, 2, 3, 5, 99]) {
      expect(contentionRetryBackoffMs(attempt)).toBeLessThan(lockRetryBackoffMs(attempt));
    }
  });
});
