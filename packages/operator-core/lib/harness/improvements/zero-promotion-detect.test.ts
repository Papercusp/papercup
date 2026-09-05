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
    // minor, not major: with the Mug/Kettle tier retired this costs attribution, not
    // placement, and severity is what triage ranks on (EI-20119196410091151).
    expect(findings[0].severity).toBe('minor');
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

  it('does NOT flag an intentional SPEC TRIAD hold with an open exit filing', () => {
    expect(
      detectZeroPromotion([
        {
          planSlug: 'triad-held',
          harnessSlug: 'h',
          openItemCount: 5,
          workItemCount: 0,
          specTriadBlocked: true,
        },
      ]),
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

  // EI-20119196410091151 — the finding's HARM MODEL, not its measurement. The old body
  // said "the Mug has nothing to place from it"; the Mug/Kettle tier is retired, so that
  // consequence cannot occur and the remedy it implies ("make promotion fire") mints
  // duplicate work-items on a nearly-finished plan.
  describe('harm model survives the Mug/Kettle retirement', () => {
    const finding = (over: Partial<PlanPromotionCount> = {}) =>
      detectZeroPromotion([
        { planSlug: 'p', harnessSlug: 'h', openItemCount: 3, workItemCount: 0, ...over },
      ])[0];

    it('does not attribute the harm to the retired Mug/placement tier', () => {
      const body = finding().body;
      expect(body).not.toMatch(/\bMug\b/);
      expect(body).not.toMatch(/\bKettle\b/);
      expect(body).not.toMatch(/nothing to place/i);
      expect(body).not.toMatch(/placeable work/i);
    });

    it('states the surviving consequence — attribution via source_plan_slug', () => {
      expect(finding().body).toContain('source_plan_slug');
      expect(finding().body).toMatch(/attributable/i);
    });

    it('tells a triager NOT to mint work-items when every open item is already wip', () => {
      const body = finding({ openItemCount: 3, wipItemCount: 3 }).body;
      expect(body).toMatch(/all 3 open item\(s\) are already wip/i);
      expect(body).toMatch(/do NOT mint/i);
      expect(body).toMatch(/attribution only/i);
    });

    it('keeps the look-into-it wording when some open items are still unstarted', () => {
      const body = finding({ openItemCount: 3, wipItemCount: 1 }).body;
      expect(body).toMatch(/genuinely unstarted/i);
      expect(body).not.toMatch(/do NOT mint/i);
    });

    it('does not claim all-wip when the caller supplies no wip count', () => {
      // wipItemCount is optional; a caller that omits it must not trip the all-wip branch
      // (undefined === openItemCount would be a false positive in the reassuring direction).
      const body = finding({ wipItemCount: undefined }).body;
      expect(body).not.toMatch(/do NOT mint/i);
      expect(body).toMatch(/genuinely unstarted/i);
    });

    it('still flags a zero-promotion plan at all — the measurement is unchanged', () => {
      expect(finding({ wipItemCount: 3 })).toBeDefined();
      expect(finding({ wipItemCount: 3 }).findingClass).toBe('promotion:zero-conversion');
    });
  });
});
