import { describe, expect, it } from 'vitest';
import { detectZeroPromotion, type PlanPromotionCount } from './zero-promotion-detect';

describe('zero-promotion detector (unified-work-item-ledger P-009)', () => {
  it('flags a started plan with open items but zero work-items', () => {
    const plans: PlanPromotionCount[] = [
      { planSlug: 'idle-plan', harnessSlug: 'papercusp', openItemCount: 5, workItemCount: 0 },
    ];
    const findings = detectZeroPromotion(plans);
    expect(findings).toHaveLength(1);
    expect(findings[0].source).toBe('zero-promotion');
    expect(findings[0].key).toBe('idle-plan');
    expect(findings[0].scope).toBe('harness:papercusp');
    expect(findings[0].severity).toBe('major');
    expect(findings[0].findingClass).toBe('promotion:zero-conversion');
    expect(findings[0].title).toContain('idle-plan');
    expect(findings[0].body).toContain('5 open');
  });

  it('does NOT flag a plan that has at least one work-item', () => {
    expect(
      detectZeroPromotion([
        { planSlug: 'healthy', harnessSlug: 'h', openItemCount: 3, workItemCount: 3 },
        { planSlug: 'partial', harnessSlug: 'h', openItemCount: 3, workItemCount: 1 },
      ]),
    ).toEqual([]);
  });

  it('does NOT flag a plan with no open items (nothing to promote)', () => {
    expect(
      detectZeroPromotion([{ planSlug: 'done', harnessSlug: 'h', openItemCount: 0, workItemCount: 0 }]),
    ).toEqual([]);
  });

  it('flags only the offending plans in a mixed set', () => {
    const findings = detectZeroPromotion([
      { planSlug: 'bad-1', harnessSlug: 'a', openItemCount: 2, workItemCount: 0 },
      { planSlug: 'ok', harnessSlug: 'a', openItemCount: 2, workItemCount: 2 },
      { planSlug: 'bad-2', harnessSlug: 'b', openItemCount: 1, workItemCount: 0 },
    ]);
    expect(findings.map((f) => f.key)).toEqual(['bad-1', 'bad-2']);
  });

  it('returns nothing for an empty input', () => {
    expect(detectZeroPromotion([])).toEqual([]);
  });
});
