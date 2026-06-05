/**
 * Unit tests for the explicit harness-scope resolver (_harness-scope.ts).
 * Pure function — covers the arg/ctx precedence + the '*'-as-no-choice rule.
 */
import { describe, expect, it } from 'vitest';
import { HarnessRequiredError } from '@papercusp/agent-mcp';
import { harnessScopedCtx, isAllHarnessSentinel, resolveHarnessScope } from './_harness-scope';

describe('isAllHarnessSentinel', () => {
  it('treats * and all (any case) as the sentinel', () => {
    for (const v of ['*', 'all', 'ALL', ' All ']) expect(isAllHarnessSentinel(v)).toBe(true);
  });
  it('treats a real slug / empty / nullish as not-sentinel', () => {
    for (const v of ['papercup', 'restart', '', undefined, null]) expect(isAllHarnessSentinel(v)).toBe(false);
  });
});

describe('resolveHarnessScope', () => {
  it('explicit all arg → { all } (deliberate operator scope)', () => {
    expect(resolveHarnessScope('all', { harnessSlug: undefined })).toEqual({ kind: 'all' });
    expect(resolveHarnessScope('*', { harnessSlug: '*' })).toEqual({ kind: 'all' });
  });

  it('explicit concrete arg → { harness } (wins over ctx)', () => {
    expect(resolveHarnessScope('restart', { harnessSlug: 'papercup' })).toEqual({ kind: 'harness', slug: 'restart' });
  });

  it('no arg + concrete ctx → { harness } (scoped session)', () => {
    expect(resolveHarnessScope(undefined, { harnessSlug: 'papercup' })).toEqual({ kind: 'harness', slug: 'papercup' });
  });

  it("no arg + ctx '*' (auto superuser default) → { none } (must opt in)", () => {
    expect(resolveHarnessScope(undefined, { harnessSlug: '*' })).toEqual({ kind: 'none' });
  });

  it('no arg + unset ctx → { none }', () => {
    expect(resolveHarnessScope(undefined, { harnessSlug: undefined })).toEqual({ kind: 'none' });
    expect(resolveHarnessScope(undefined, null)).toEqual({ kind: 'none' });
  });

  it("no arg + ctx 'all' literal → { none } (ctx all is not an explicit per-call choice)", () => {
    expect(resolveHarnessScope(undefined, { harnessSlug: 'all' })).toEqual({ kind: 'none' });
  });

  it('trims whitespace on the arg', () => {
    expect(resolveHarnessScope('  restart  ', null)).toEqual({ kind: 'harness', slug: 'restart' });
  });
});

describe('harnessScopedCtx', () => {
  it('throws HarnessRequiredError when no harness is resolvable', () => {
    expect(() => harnessScopedCtx(undefined, { harnessSlug: '*' })).toThrow(HarnessRequiredError);
    expect(() => harnessScopedCtx(undefined, { harnessSlug: undefined })).toThrow(HarnessRequiredError);
  });

  it("'all' arg → ctx with harnessSlug '*' (preserving other ctx fields)", () => {
    expect(harnessScopedCtx('all', { harnessSlug: '*', runId: 'r' })).toEqual({ harnessSlug: '*', runId: 'r' });
  });

  it('concrete arg wins over ctx → ctx with that slug', () => {
    expect(harnessScopedCtx('restart', { harnessSlug: 'papercup' })).toEqual({ harnessSlug: 'restart' });
  });

  it('scoped session (concrete ctx, no arg) → that slug', () => {
    expect(harnessScopedCtx(undefined, { harnessSlug: 'papercup' })).toEqual({ harnessSlug: 'papercup' });
  });
});
