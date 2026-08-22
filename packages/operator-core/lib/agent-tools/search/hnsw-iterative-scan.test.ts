import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PgHandle } from '@papercusp/search';
import { resetIterativeScanProbe, withIterativeScan } from './hnsw-iterative-scan';

type FakeSql = PgHandle & {
  begin: ReturnType<typeof vi.fn>;
};

function makeSql(probeError?: Error & { code?: string }): {
  sql: FakeSql;
  probeCount: () => number;
  bodyTransactions: () => number;
} {
  let probeCount = 0;
  let bodyTransactions = 0;
  const root = vi.fn(async () => []) as unknown as FakeSql;
  root.begin = vi.fn(async (callback: (tx: PgHandle) => Promise<unknown>) => {
    let readOnly = false;
    const tx = vi.fn(async (strings: TemplateStringsArray) => {
      const statement = strings.join('');
      if (/SET TRANSACTION READ ONLY/i.test(statement)) {
        readOnly = true;
        bodyTransactions += 1;
      }
      if (/SET LOCAL hnsw\.iterative_scan/i.test(statement) && !readOnly) {
        probeCount += 1;
        if (probeError && probeCount === 1) throw probeError;
      }
      return [];
    }) as unknown as PgHandle;
    return callback(tx);
  });
  return { sql: root, probeCount: () => probeCount, bodyTransactions: () => bodyTransactions };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('withIterativeScan capability probing', () => {
  it('retries after a transient probe failure instead of poisoning the handle', async () => {
    const { sql, probeCount, bodyTransactions } = makeSql(
      Object.assign(new Error('connection reset by peer'), { code: '08006' }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bodies: PgHandle[] = [];

    await withIterativeScan(sql, async (handle) => {
      bodies.push(handle);
      return 'first';
    });
    await withIterativeScan(sql, async (handle) => {
      bodies.push(handle);
      return 'second';
    });

    expect(probeCount()).toBe(2);
    expect(bodyTransactions()).toBe(1);
    expect(bodies[0]).toBe(sql);
    expect(bodies[1]).not.toBe(sql);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('transiently'));
  });

  it('caches an undefined-object capability result and logs it once', async () => {
    const { sql, probeCount, bodyTransactions } = makeSql(
      Object.assign(new Error('unrecognized configuration parameter "hnsw.iterative_scan"'), {
        code: '42704',
      }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bodies: PgHandle[] = [];

    await withIterativeScan(sql, async (handle) => {
      bodies.push(handle);
      return 'first';
    });
    await withIterativeScan(sql, async (handle) => {
      bodies.push(handle);
      return 'second';
    });

    expect(probeCount()).toBe(1);
    expect(bodyTransactions()).toBe(0);
    expect(bodies[0]).toBe(sql);
    expect(bodies[1]).toBe(sql);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not support'));

    resetIterativeScanProbe(sql);
  });
});
