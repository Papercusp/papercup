/**
 * Adapter coverage for the papercusp `for_each` resolver seam (P-043).
 *
 * The fan-out ALGORITHM (resolve/dedupe/cap/escalate) is covered in the generic
 * `@papercusp/fanout-resolver` lib's own suite. These tests cover the thin
 * papercusp ADAPTER: the wave-shape guards and the `ForEachResolver` →
 * `FanoutSpec` mapping (notably the `from_feature` ⇒ `deferred` translation).
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveForEach, isForEachResolver, isCompletionTimeForEach } from './for-each-resolver';
import { FanoutResolverError } from '@papercusp/fanout-resolver';
import type { ForEachResolver } from './promote-policy';

describe('isForEachResolver', () => {
  it('a legacy named string is NOT a resolver', () => {
    expect(isForEachResolver('universal_type')).toBe(false);
  });
  it('an items/glob/sql/from_feature object IS a resolver', () => {
    expect(isForEachResolver({ items: ['a'] })).toBe(true);
    expect(isForEachResolver({ glob: 'x' })).toBe(true);
    expect(isForEachResolver({ sql: 'select 1' })).toBe(true);
    expect(isForEachResolver({ from_feature: 'F-1' })).toBe(true);
  });
});

describe('isCompletionTimeForEach', () => {
  it('true only for a from_feature (completion-time) resolver', () => {
    expect(isCompletionTimeForEach({ from_feature: 'F-1' })).toBe(true);
    expect(isCompletionTimeForEach({ items: ['a'] })).toBe(false);
    expect(isCompletionTimeForEach({ glob: 'x' })).toBe(false);
    expect(isCompletionTimeForEach('universal_type')).toBe(false);
  });
});

describe('resolveForEach (adapter → generic lib)', () => {
  it('items: passes through the generic resolver (trimmed + deduped)', async () => {
    expect(await resolveForEach({ items: [' a ', 'b', 'a'] })).toEqual(['a', 'b']);
  });

  it('glob: forwards the injected runner', async () => {
    const runGlob = vi.fn(async () => ['app/api/x/route.ts', 'app/api/x/route.ts', 'app/api/y/route.ts']);
    expect(await resolveForEach({ glob: 'app/api/**/route.ts' }, { runGlob })).toEqual([
      'app/api/x/route.ts',
      'app/api/y/route.ts',
    ]);
    expect(runGlob).toHaveBeenCalledOnce();
  });

  it('maps a from_feature (completion-time) resolver onto the deferred spec → escalates', async () => {
    const spec: ForEachResolver = { from_feature: 'F-SCAN' };
    const err = await resolveForEach(spec).catch((e) => e);
    expect(err).toBeInstanceOf(FanoutResolverError);
    // the producing feature ref survives the from_feature → deferred translation
    expect((err as Error).message).toContain('F-SCAN');
  });
});
