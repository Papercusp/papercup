/**
 * WI-10003675 guard: plan promotion must not swallow serialization contention on the
 * blocker-edge write. Under 8 concurrent promotions (P-013 workload B) the edge writer
 * exhausted its SERIALIZABLE retries, the per-item catch counted it as a backstop failure,
 * and a join item was minted with ZERO blocker edges.
 *
 * Covered here without a database:
 *  - the contention classifier (what counts as transient),
 *  - the outer re-attempt tier (retries contention, never a cycle/I-O error),
 *  - the loud error the promotion now throws,
 *  - the dependency-graph retry budget the canonical writer now defaults to.
 * The concurrent end-to-end reproduction lives in the integration suite.
 */
import { describe, expect, it, vi } from 'vitest';
import { SerializableRetryExhaustedError, type Sql } from '@papercusp/db-org';
import {
  PromotionDependencyEdgeError,
  isTransientDependencyWriteError,
  syncBlockEdgesWithContentionRetry,
} from './plan-workitem-promotion-run';
import {
  DEPENDENCY_ADMISSION_RETRY_DEFAULTS,
  withWorkItemDependencyAdmissionTransaction,
} from './dbos/work-item-deps-store';

const exhausted = () => new SerializableRetryExhaustedError(6, '40001', new Error('could not serialize'));
const noSleep = async () => {};

describe('isTransientDependencyWriteError', () => {
  it('classifies serialization contention as transient', () => {
    expect(isTransientDependencyWriteError(exhausted())).toBe(true);
    expect(isTransientDependencyWriteError(Object.assign(new Error('x'), { code: '40001' }))).toBe(true);
    expect(isTransientDependencyWriteError(Object.assign(new Error('x'), { code: '40P01' }))).toBe(true);
  });

  it('does NOT classify a cycle refusal or plain I/O error as transient', () => {
    expect(isTransientDependencyWriteError(new Error('dependency cycle'))).toBe(false);
    expect(isTransientDependencyWriteError(Object.assign(new Error('x'), { code: '23505' }))).toBe(false);
    expect(isTransientDependencyWriteError(null)).toBe(false);
    expect(isTransientDependencyWriteError('40001')).toBe(false);
  });
});

describe('syncBlockEdgesWithContentionRetry', () => {
  it('re-attempts the writer through contention and succeeds', async () => {
    const sync = vi
      .fn()
      .mockRejectedValueOnce(exhausted())
      .mockRejectedValueOnce(exhausted())
      .mockResolvedValueOnce(undefined);
    const sleep = vi.fn(noSleep);
    await syncBlockEdgesWithContentionRetry(sync, 'h', 'WI-3', ['WI-1', 'WI-2'], { sleep });
    expect(sync).toHaveBeenCalledTimes(3);
    expect(sync).toHaveBeenLastCalledWith('h', 'WI-3', ['WI-1', 'WI-2']);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('rethrows the contention error once the bounded budget is spent', async () => {
    const sync = vi.fn().mockRejectedValue(exhausted());
    await expect(
      syncBlockEdgesWithContentionRetry(sync, 'h', 'WI-3', ['WI-1'], { sleep: noSleep, extraAttempts: 3 }),
    ).rejects.toBeInstanceOf(SerializableRetryExhaustedError);
    expect(sync).toHaveBeenCalledTimes(4);
  });

  it('never retries a non-contention error (the cycle / I-O backstop stays single-shot)', async () => {
    const sync = vi.fn().mockRejectedValue(new Error('would close a dependency cycle'));
    await expect(
      syncBlockEdgesWithContentionRetry(sync, 'h', 'WI-3', ['WI-1'], { sleep: noSleep }),
    ).rejects.toThrow(/cycle/);
    expect(sync).toHaveBeenCalledTimes(1);
  });
});

describe('PromotionDependencyEdgeError', () => {
  it('names every ungated item so the failure is actionable, not a log line', () => {
    const err = new PromotionDependencyEdgeError('papercusp', 'p', ['WI-9 (plan item P-003)']);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PromotionDependencyEdgeError');
    expect(err.failedItems).toEqual(['WI-9 (plan item P-003)']);
    expect(err.message).toMatch(/WI-9 \(plan item P-003\)/);
    expect(err.message).toMatch(/not dependency-gated/);
  });
});

describe('dependency admission retry budget', () => {
  /** A fake Sql whose begin() always aborts with 40001, counting attempts. */
  function alwaysConflicting() {
    let begins = 0;
    const sql = {
      begin: async () => {
        begins++;
        throw Object.assign(new Error('could not serialize access'), { code: '40001' });
      },
    } as unknown as Sql;
    return { sql, begins: () => begins };
  }

  it('defaults to a larger budget than the generic 6 tries, with a capped per-sleep ceiling', () => {
    expect(DEPENDENCY_ADMISSION_RETRY_DEFAULTS.maxRetries).toBeGreaterThan(5);
    expect(DEPENDENCY_ADMISSION_RETRY_DEFAULTS.maxDelayMs).toBeGreaterThan(0);
  });

  it('applies the default budget when the caller passes none', async () => {
    const { sql, begins } = alwaysConflicting();
    const sleeps: number[] = [];
    await expect(
      withWorkItemDependencyAdmissionTransaction(sql, async () => 1, {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    ).rejects.toBeInstanceOf(SerializableRetryExhaustedError);
    expect(begins()).toBe((DEPENDENCY_ADMISSION_RETRY_DEFAULTS.maxRetries ?? 0) + 1);
    for (const ms of sleeps) expect(ms).toBeLessThanOrEqual(DEPENDENCY_ADMISSION_RETRY_DEFAULTS.maxDelayMs ?? 0);
  });

  it('still honours an explicit caller override', async () => {
    const { sql, begins } = alwaysConflicting();
    await expect(
      withWorkItemDependencyAdmissionTransaction(sql, async () => 1, { maxRetries: 1, sleep: noSleep }),
    ).rejects.toBeInstanceOf(SerializableRetryExhaustedError);
    expect(begins()).toBe(2);
  });
});
