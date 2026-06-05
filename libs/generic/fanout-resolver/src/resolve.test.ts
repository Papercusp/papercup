/**
 * Algorithm-conformance tests for the fan-out resolver (the generic core,
 * extracted from operator-core's for-each-resolver — generalize-libs row #12).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  resolveFanout,
  dedupeTrim,
  isFanoutSpec,
  isDeferredFanout,
  FanoutCapError,
  FanoutResolverError,
  DEFAULT_FANOUT_CAP,
} from './index';

describe('isFanoutSpec', () => {
  it('a bare named-set string is NOT a spec', () => {
    expect(isFanoutSpec('universal_type')).toBe(false);
  });
  it('an items/glob/sql/deferred object IS a spec', () => {
    expect(isFanoutSpec({ items: ['a'] })).toBe(true);
    expect(isFanoutSpec({ glob: 'x' })).toBe(true);
    expect(isFanoutSpec({ sql: 'select 1' })).toBe(true);
    expect(isFanoutSpec({ deferred: 'P-1' })).toBe(true);
  });
  it('null is not a spec', () => {
    expect(isFanoutSpec(null)).toBe(false);
  });
});

describe('isDeferredFanout', () => {
  it('true only for a deferred spec', () => {
    expect(isDeferredFanout({ deferred: 'P-1' })).toBe(true);
    expect(isDeferredFanout({ items: ['a'] })).toBe(false);
    expect(isDeferredFanout({ glob: 'x' })).toBe(false);
    expect(isDeferredFanout({ sql: 'select 1' })).toBe(false);
  });
});

describe('dedupeTrim', () => {
  it('trims, drops empties, dedupes, preserves insertion order', () => {
    expect(dedupeTrim([' a ', 'b', 'a', '', '  ', 'c'])).toEqual(['a', 'b', 'c']);
  });
});

describe('resolveFanout', () => {
  it('items: returns the literal set, trimmed + deduped + non-empty', async () => {
    expect(await resolveFanout({ items: [' a ', 'b', 'a', '', '  '] })).toEqual(['a', 'b']);
  });

  it('glob: runs the injected runner and dedupes its output', async () => {
    const runGlob = vi.fn(async (p: string) => {
      expect(p).toBe('app/api/**/route.ts');
      return ['app/api/x/route.ts', 'app/api/y/route.ts', 'app/api/x/route.ts'];
    });
    expect(await resolveFanout({ glob: 'app/api/**/route.ts' }, { runGlob })).toEqual([
      'app/api/x/route.ts',
      'app/api/y/route.ts',
    ]);
    expect(runGlob).toHaveBeenCalledOnce();
  });

  it('sql: runs the injected query runner', async () => {
    const runSql = vi.fn(async () => ['VAL-1', 'VAL-2']);
    expect(await resolveFanout({ sql: 'SELECT val_id FROM x' }, { runSql })).toEqual(['VAL-1', 'VAL-2']);
  });

  it('throws FanoutCapError when the set exceeds the cap (never truncates)', async () => {
    const many = Array.from({ length: 5 }, (_, i) => `item-${i}`);
    await expect(resolveFanout({ items: many }, { cap: 3 })).rejects.toBeInstanceOf(FanoutCapError);
    // exactly at the cap is allowed
    expect(await resolveFanout({ items: many.slice(0, 3) }, { cap: 3 })).toHaveLength(3);
  });

  it('the default cap is applied when none is given', async () => {
    const tooMany = Array.from({ length: DEFAULT_FANOUT_CAP + 1 }, (_, i) => `i-${i}`);
    await expect(resolveFanout({ items: tooMany })).rejects.toBeInstanceOf(FanoutCapError);
  });

  it('glob with no runner → FanoutResolverError (escalate, never silent zero)', async () => {
    await expect(resolveFanout({ glob: 'x' }, {})).rejects.toBeInstanceOf(FanoutResolverError);
  });

  it('sql with no runner → FanoutResolverError', async () => {
    await expect(resolveFanout({ sql: 'select 1' }, {})).rejects.toBeInstanceOf(FanoutResolverError);
  });

  it('a deferred spec → FanoutResolverError (resolved later, never now)', async () => {
    const err = await resolveFanout({ deferred: 'F-SCAN' }, {}).catch((e) => e);
    expect(err).toBeInstanceOf(FanoutResolverError);
    expect((err as Error).message).toContain('F-SCAN');
  });

  it('wraps a resolver runtime failure in FanoutResolverError', async () => {
    const runSql = vi.fn(async () => {
      throw new Error('relation does not exist');
    });
    const err = await resolveFanout({ sql: 'select 1' }, { runSql }).catch((e) => e);
    expect(err).toBeInstanceOf(FanoutResolverError);
    expect((err as Error).message).toContain('relation does not exist');
  });
});
