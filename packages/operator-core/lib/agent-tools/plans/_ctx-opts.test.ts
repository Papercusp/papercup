/**
 * Unit coverage for the ctx → plan-source-opts resolver (_ctx-opts.ts).
 *
 * The load-bearing case is the SU wildcard `'*'` (set by http-projection on
 * `?superuser=1` with no `?harness=`): it must collapse to "no harness in scope"
 * (resolveCtxHarnessSlug → undefined; ctxToPlanSourceOpts → the papercup default)
 * — passing `'*'` through unfiltered would make the downstream PG queries match
 * nothing instead of the papercup-default plans.
 */
import { describe, it, expect } from 'vitest';
import { resolveCtxHarnessSlug, ctxToPlanSourceOpts } from './_ctx-opts';
import { PAPERCUP_HARNESS_SLUG } from '../../harness/register-papercup';

describe('resolveCtxHarnessSlug', () => {
  it('returns undefined for empty / missing / whitespace / wildcard scope', () => {
    expect(resolveCtxHarnessSlug({})).toBeUndefined();
    expect(resolveCtxHarnessSlug({ harnessSlug: '' })).toBeUndefined();
    expect(resolveCtxHarnessSlug({ harnessSlug: '   ' })).toBeUndefined();
    expect(resolveCtxHarnessSlug({ harnessSlug: '*' })).toBeUndefined(); // SU wildcard ≠ a real harness
  });

  it('returns the trimmed slug for a real harness', () => {
    expect(resolveCtxHarnessSlug({ harnessSlug: 'my-harness' })).toBe('my-harness');
    expect(resolveCtxHarnessSlug({ harnessSlug: '  spaced  ' })).toBe('spaced');
  });

  it('tolerates a primitive ctx with no harnessSlug field', () => {
    expect(resolveCtxHarnessSlug(42)).toBeUndefined();
  });
});

describe('ctxToPlanSourceOpts', () => {
  it('defaults to the papercup harness for empty / wildcard / papercup scope', async () => {
    expect(await ctxToPlanSourceOpts({})).toEqual({ harnessSlug: PAPERCUP_HARNESS_SLUG });
    expect(await ctxToPlanSourceOpts({ harnessSlug: '*' })).toEqual({ harnessSlug: PAPERCUP_HARNESS_SLUG });
    expect(await ctxToPlanSourceOpts({ harnessSlug: PAPERCUP_HARNESS_SLUG })).toEqual({ harnessSlug: PAPERCUP_HARNESS_SLUG });
  });

  it('threads a real harness slug through (trimmed)', async () => {
    expect(await ctxToPlanSourceOpts({ harnessSlug: 'web' })).toEqual({ harnessSlug: 'web' });
    expect(await ctxToPlanSourceOpts({ harnessSlug: '  web  ' })).toEqual({ harnessSlug: 'web' });
  });
});
