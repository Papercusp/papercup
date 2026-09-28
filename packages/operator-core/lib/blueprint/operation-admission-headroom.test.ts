import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { nestedAcquireCapacity, withNestedAcquireHeadroom } from './operation-admission';

/**
 * WI-10003586: keyed direct admission holds a pool connection in a transaction
 * while createWorkItem() takes a second one from the same pool. These tests model
 * that nesting with a counting pool and prove the headroom gate cannot deadlock.
 */
function countingPool(max: number) {
  let free = max;
  const waiters: Array<() => void> = [];
  return {
    async acquire(): Promise<void> {
      while (free === 0) await new Promise<void>((resolve) => waiters.push(resolve));
      free -= 1;
    },
    release(): void {
      free += 1;
      waiters.shift()?.();
    },
  };
}

/** One admission: hold a connection (the transaction), then need a second (createWorkItem). */
function nestedAdmission(pool: ReturnType<typeof countingPool>) {
  return async () => {
    await pool.acquire();
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await pool.acquire();
      pool.release();
      return 'created';
    } finally {
      pool.release();
    }
  };
}

function fakeSql(max: number | undefined): Sql {
  return { options: max === undefined ? {} : { max } } as unknown as Sql;
}

/** Control: the pre-fix shape, a gate as wide as the pool (equivalent to no gate). */
async function noHeadroom<T>(run: () => Promise<T>): Promise<T> {
  return run();
}

const settlesWithin = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise.then(() => 'settled' as const), new Promise<'hung'>((r) => setTimeout(() => r('hung'), ms))]);

describe('withNestedAcquireHeadroom (WI-10003586)', () => {
  it('leaves one connection free: capacity is poolMax - 1, never below 1', () => {
    expect(nestedAcquireCapacity(fakeSql(2))).toBe(1);
    expect(nestedAcquireCapacity(fakeSql(11))).toBe(10);
    expect(nestedAcquireCapacity(fakeSql(1))).toBe(1);
    expect(nestedAcquireCapacity(fakeSql(undefined))).toBe(9);
  });

  it('control: without headroom, concurrent nested admissions at the pool max deadlock', async () => {
    const pool = countingPool(2);
    const all = Promise.all(Array.from({ length: 4 }, () => noHeadroom(nestedAdmission(pool))));
    expect(await settlesWithin(all, 300)).toBe('hung');
  });

  it('with headroom, the same load completes on a max-2 pool', async () => {
    const pool = countingPool(2);
    const sql = fakeSql(2);
    const all = Promise.all(Array.from({ length: 8 }, () => withNestedAcquireHeadroom(sql, nestedAdmission(pool))));
    expect(await settlesWithin(all, 2_000)).toBe('settled');
    expect(await all).toEqual(Array(8).fill('created'));
  });

  it('releases its slot when the admission throws', async () => {
    const sql = fakeSql(2);
    await expect(withNestedAcquireHeadroom(sql, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await settlesWithin(withNestedAcquireHeadroom(sql, async () => 'ok'), 500)).toBe('settled');
  });
});
