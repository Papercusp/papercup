/**
 * Unit coverage for the deterministic for_each resolvers (P-043).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  resolveForEach,
  isForEachResolver,
  ForEachFanoutError,
  ForEachResolverError,
  DEFAULT_FOR_EACH_FANOUT_CAP,
} from './for-each-resolver';

describe('isForEachResolver', () => {
  it('a legacy named string is NOT a resolver', () => {
    expect(isForEachResolver('universal_type')).toBe(false);
  });
  it('an items/glob/sql object IS a resolver', () => {
    expect(isForEachResolver({ items: ['a'] })).toBe(true);
    expect(isForEachResolver({ glob: 'x' })).toBe(true);
    expect(isForEachResolver({ sql: 'select 1' })).toBe(true);
  });
});

describe('resolveForEach', () => {
  it('items: returns the literal set, trimmed + deduped + non-empty', async () => {
    expect(await resolveForEach({ items: [' a ', 'b', 'a', '', '  '] })).toEqual(['a', 'b']);
  });

  it('glob: runs the injected runner and dedupes its output', async () => {
    const runGlob = vi.fn(async (p: string) => {
      expect(p).toBe('app/api/**/route.ts');
      return ['app/api/x/route.ts', 'app/api/y/route.ts', 'app/api/x/route.ts'];
    });
    expect(await resolveForEach({ glob: 'app/api/**/route.ts' }, { runGlob })).toEqual([
      'app/api/x/route.ts',
      'app/api/y/route.ts',
    ]);
    expect(runGlob).toHaveBeenCalledOnce();
  });

  it('sql: runs the injected query runner', async () => {
    const runSql = vi.fn(async () => ['VAL-1', 'VAL-2']);
    expect(await resolveForEach({ sql: 'SELECT val_id FROM x' }, { runSql })).toEqual(['VAL-1', 'VAL-2']);
  });

  it('throws ForEachFanoutError when the set exceeds the cap (never truncates)', async () => {
    const many = Array.from({ length: 5 }, (_, i) => `item-${i}`);
    await expect(resolveForEach({ items: many }, { cap: 3 })).rejects.toBeInstanceOf(ForEachFanoutError);
    // exactly at the cap is allowed
    expect(await resolveForEach({ items: many.slice(0, 3) }, { cap: 3 })).toHaveLength(3);
  });

  it('the default cap is applied when none is given', async () => {
    const tooMany = Array.from({ length: DEFAULT_FOR_EACH_FANOUT_CAP + 1 }, (_, i) => `i-${i}`);
    await expect(resolveForEach({ items: tooMany })).rejects.toBeInstanceOf(ForEachFanoutError);
  });

  it('glob with no runner → ForEachResolverError (escalate, never silent zero)', async () => {
    await expect(resolveForEach({ glob: 'x' }, {})).rejects.toBeInstanceOf(ForEachResolverError);
  });

  it('sql with no runner → ForEachResolverError', async () => {
    await expect(resolveForEach({ sql: 'select 1' }, {})).rejects.toBeInstanceOf(ForEachResolverError);
  });

  it('wraps a resolver runtime failure in ForEachResolverError', async () => {
    const runSql = vi.fn(async () => {
      throw new Error('relation does not exist');
    });
    const err = await resolveForEach({ sql: 'select 1' }, { runSql }).catch((e) => e);
    expect(err).toBeInstanceOf(ForEachResolverError);
    expect((err as Error).message).toContain('relation does not exist');
  });
});
