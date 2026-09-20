import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adhocPlanItemIdFor } from './adhoc-spec-scope';

/**
 * EI-23787801255099066. `plans:set-specs` requires a `planItemId` that a planless caller has
 * no plan to take one from, and the completion advice named only the argument to OMIT — so
 * each author invented a bucket. Measured over the whole ad-hoc scope on 2026-09-20, 4 of 12
 * real clauses carried an arbitrary one (`P-001` twice, `P-305`, `P-232120`).
 */
describe('adhocPlanItemIdFor', () => {
  it('derives the bucket from the work-item number, for both id families', () => {
    expect(adhocPlanItemIdFor('EI-23787801255099066')).toBe('P-23787801255099066');
    expect(adhocPlanItemIdFor('WI-10002028')).toBe('P-10002028');
  });

  it('is deterministic per item — the property that makes deriving it worth anything', () => {
    expect(adhocPlanItemIdFor('WI-10002028')).toBe(adhocPlanItemIdFor('  WI-10002028  '));
  });

  it('returns null rather than a value the database CHECK would reject', () => {
    // `EI-1` derives `P-1`, which fails `plan_spec_clause_revisions_plan_item_id_check`
    // (`^P-[0-9]{3,}$`). A caller building advice on this must be able to fall back to the
    // shape instead of naming an argument the very next write would refuse.
    expect(adhocPlanItemIdFor('EI-1')).toBeNull();
    expect(adhocPlanItemIdFor('F-12')).toBeNull();
    expect(adhocPlanItemIdFor('')).toBeNull();
    expect(adhocPlanItemIdFor(null)).toBeNull();
    expect(adhocPlanItemIdFor(undefined)).toBeNull();
  });

  it('never yields a value plans:set-specs would reject — pinned to that tool’s own regex', () => {
    // The consumer is the authority here, so read ITS declared shape rather than restating
    // one. If set-specs stops declaring planItemId with a regex, the positive control below
    // fails loudly instead of letting this assertion pass over nothing.
    const source = readFileSync(new URL('./set-specs.ts', import.meta.url), 'utf8');
    const declared = source.match(/planItemId:\s*z\.string\(\)\.regex\((\/[^/]+\/)\)/);
    expect(declared, 'plans:set-specs no longer declares planItemId with a regex — re-pin this').toBeTruthy();

    const consumerShape = new RegExp(declared![1].replace(/^\/|\/$/g, ''));
    // Positive control: the shape must actually reject something, or `.test` passing is meaningless.
    expect(consumerShape.test('P-1')).toBe(false);

    for (const id of ['EI-23787801255099066', 'WI-10002028', 'EI-23785816111021036']) {
      expect(consumerShape.test(adhocPlanItemIdFor(id)!)).toBe(true);
    }
  });
});
