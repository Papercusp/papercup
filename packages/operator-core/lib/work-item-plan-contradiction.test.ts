/**
 * work-item-plan-contradiction.test.ts — the WI-39498 claim-time "PLAN SAYS DONE" hint.
 *
 * The pure legs are tested directly (the text predicate, the warning render, and the
 * no-stamp early exits of the reader — none touch PG). The DB read itself is a single
 * indexed SELECT exercised by the live claim path; its fail-soft contract (any error →
 * null) is the same seam every sibling claim-time hint uses.
 *
 * FALSIFIABILITY CONTROL: the deliberately-wrong predicate below (idOnlyMatcher — the
 * pre-WI-39498 intuition that naming the id is enough) must FAIL the cases the real
 * predicate passes, so a regression that weakens the completion-token requirement is
 * caught here rather than re-discovered by the next burned agent.
 */
import { describe, expect, it } from 'vitest';
import {
  getClaimTimePlanItemContradiction,
  planItemContradictionWarning,
  planItemTextNamesCompleted,
  type ClaimTimePlanItemContradictionHint,
} from './work-item-plan-contradiction';

const ZOMBIE_TEXT =
  'Verify the cited sources, reported constellation-by-constellation. — note: ← WI-37944 completed (done)';

describe('planItemTextNamesCompleted — the WI-39498 population predicate', () => {
  it('matches the live zombie annotation shape (id + "completed (done)")', () => {
    expect(planItemTextNamesCompleted(ZOMBIE_TEXT, 'WI-37944')).toBe(true);
  });

  it('is case-insensitive on both the id and the completion token', () => {
    expect(planItemTextNamesCompleted('… ← wi-37944 COMPLETED …', 'WI-37944')).toBe(true);
  });

  it('accepts the bare "(done)" token without the word completed', () => {
    expect(planItemTextNamesCompleted('WI-12 shipped (done)', 'WI-12')).toBe(true);
  });

  it('does NOT match when the text names the id without any completion token', () => {
    expect(planItemTextNamesCompleted('fix the residue degrading X — WI-37944', 'WI-37944')).toBe(false);
  });

  it('does NOT match when the completion token is about a DIFFERENT id', () => {
    // The id must appear; a sibling's annotation alone is not this item's contradiction.
    expect(planItemTextNamesCompleted('— note: ← WI-99999 completed (done)', 'WI-37944')).toBe(false);
  });

  it('empty text / empty id never match', () => {
    expect(planItemTextNamesCompleted('', 'WI-1')).toBe(false);
    expect(planItemTextNamesCompleted('x', '')).toBe(false);
  });

  it('CONTROL: an id-only matcher (the pre-fix intuition) is measurably weaker', () => {
    const idOnlyMatcher = (text: string, id: string) => text.toLowerCase().includes(id.toLowerCase());
    const noTokenText = 'fix the residue degrading X — WI-37944';
    // The control passes where the real predicate refuses — proving the completion-token
    // leg is load-bearing, not decorative.
    expect(idOnlyMatcher(noTokenText, 'WI-37944')).toBe(true);
    expect(planItemTextNamesCompleted(noTokenText, 'WI-37944')).toBe(false);
  });
});

describe('getClaimTimePlanItemContradiction — stampless early exits (no PG touched)', () => {
  it('returns null with no payload, a payload without a stamp, and a partial stamp', async () => {
    expect(await getClaimTimePlanItemContradiction({ workItemId: 'WI-1', payload: null })).toBeNull();
    expect(await getClaimTimePlanItemContradiction({ workItemId: 'WI-1', payload: {} })).toBeNull();
    expect(
      await getClaimTimePlanItemContradiction({
        workItemId: 'WI-1',
        payload: { plan_item: { plan_slug: 'p-only' } },
      }),
    ).toBeNull();
    expect(await getClaimTimePlanItemContradiction({ workItemId: '', payload: { plan_item: {} } })).toBeNull();
  });
});

describe('planItemContradictionWarning — the claim-time render', () => {
  const hint: ClaimTimePlanItemContradictionHint = {
    planSlug: 'constellations-88-reference-site-2026-08-11',
    itemId: 'P-005',
    planItemStatus: 'done',
    annotatedCompleted: true,
  };

  it('null hint renders nothing', () => {
    expect(planItemContradictionWarning(null, 'WI-37944')).toBeNull();
  });

  it('names the plan item ref, the status, the id, and the verify-then-close recipe', () => {
    const w = planItemContradictionWarning(hint, 'WI-37944')!;
    expect(w).toContain('PLAN SAYS DONE');
    expect(w).toContain('constellations-88-reference-site-2026-08-11#P-005');
    expect(w).toContain("grep the source for 'WI-37944'");
    expect(w).toContain('work_items:complete');
    expect(w).toContain('[WI-39498]');
    // The annotated variant must quote the annotation shape so the claimant can find it.
    expect(w).toContain('← WI-37944 completed');
  });

  it('the un-annotated variant drops the annotation quote but keeps the recipe', () => {
    const w = planItemContradictionWarning({ ...hint, annotatedCompleted: false }, 'WI-37944')!;
    expect(w).not.toContain('← WI-37944 completed');
    expect(w).toContain("grep the source for 'WI-37944'");
  });

  it('a dropped plan item says PLAN SAYS DROPPED, not DONE', () => {
    const w = planItemContradictionWarning({ ...hint, planItemStatus: 'dropped' }, 'WI-37944')!;
    expect(w).toContain('PLAN SAYS DROPPED');
    expect(w).not.toContain('PLAN SAYS DONE');
  });
});
