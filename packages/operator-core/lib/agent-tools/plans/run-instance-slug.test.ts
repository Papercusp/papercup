/**
 * The `<templateSlug>@run-<token>` instance-slug grammar (WI-7256).
 *
 * The producer (`harness/routines/plan-run-action.ts`) and the `coord.plans`
 * sync projection both go through this module, so these pins are what stop the
 * two sides drifting apart.
 */
import { describe, expect, it } from 'vitest';
import {
  PLAN_RUN_INSTANCE_SEPARATOR,
  isPlanRunInstanceSlug,
  planRunInstanceSlug,
  planRunTemplateSlug,
} from './run-instance-slug';

describe('planRunInstanceSlug', () => {
  it('builds the slug the producer mints', () => {
    expect(planRunInstanceSlug('nightly-alert-2026-07-06', 1784241963690)).toBe(
      'nightly-alert-2026-07-06@run-1784241963690',
    );
  });

  it('round-trips through the predicate and the parent parser', () => {
    const slug = planRunInstanceSlug('my-plan', Date.now());
    expect(isPlanRunInstanceSlug(slug)).toBe(true);
    expect(planRunTemplateSlug(slug)).toBe('my-plan');
  });

  it('uses the exported separator', () => {
    expect(planRunInstanceSlug('a', 1)).toContain(PLAN_RUN_INSTANCE_SEPARATOR);
  });
});

describe('isPlanRunInstanceSlug', () => {
  it('accepts a real instance slug', () => {
    expect(isPlanRunInstanceSlug('critical-severity-alert-2026-07-06@run-1784241963690')).toBe(true);
  });

  it('rejects a plain authored plan slug', () => {
    expect(isPlanRunInstanceSlug('critical-severity-alert-2026-07-06')).toBe(false);
  });

  // Stricter than a bare includes('@run-') on purpose: these must all survive
  // the coord.plans projection.
  it.each([
    ['no digit token', 'plan-about-@run-semantics'],
    ['token not terminal', 'foo@run-123-notes'],
    ['no template part', '@run-123'],
    ['empty token', 'foo@run-'],
    ['non-numeric token', 'foo@run-abc'],
  ])('rejects %s (%s)', (_why, slug) => {
    expect(isPlanRunInstanceSlug(slug)).toBe(false);
  });

  it('is defensive about non-strings', () => {
    for (const v of [null, undefined, 42, {}, []]) expect(isPlanRunInstanceSlug(v)).toBe(false);
  });
});

describe('planRunTemplateSlug', () => {
  it('returns the parent for an instance slug', () => {
    expect(planRunTemplateSlug('a-b-c@run-17842419')).toBe('a-b-c');
  });

  it('returns null for anything that is not an instance slug', () => {
    for (const v of ['a-b-c', '@run-1', 'foo@run-abc', null, 7]) {
      expect(planRunTemplateSlug(v)).toBeNull();
    }
  });

  it('keeps a template slug that itself contains the separator text', () => {
    expect(planRunTemplateSlug('weird@run-1@run-2')).toBe('weird@run-1');
  });
});
