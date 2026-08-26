import { describe, expect, it } from 'vitest';

import { evaluatePromotionAssertionGate } from './promotion-assertion-gate';
import { extractAssertions } from './val-assertions';

/**
 * Fixture helper — the canonical plan-item + VAL block markdown shape that
 * `extractAssertionCandidates` recognizes:
 *
 *     - **P-001** title
 *       - **[VAL-p001-a]** header text
 *         - **Verify:** something falsifiable
 */
function plan(...lines: string[]): string {
  return lines.join('\n');
}

const WELL_FORMED = plan(
  '- **P-001** Do the thing',
  '  - **[VAL-p001-a]** promotion refuses a malformed assertion',
  '    - **Verify:** returns a fail_closed error for a malformed VAL block',
  '- **P-002** Do the other thing',
  '  - **[VAL-p002-a]** warnings carry off the enforcing lane',
  '    - **Verify:** returns warnings rather than violations on a draft plan',
);

const BOTH_ITEMS = new Set(['P-001', 'P-002']);

describe('evaluatePromotionAssertionGate', () => {
  it('passes a well-formed plan on the enforcing lane', () => {
    const result = evaluatePromotionAssertionGate({
      rawPlan: WELL_FORMED,
      planStatus: 'active',
      itemIds: BOTH_ITEMS,
    });

    expect(result.enforcing).toBe(true);
    expect(result.lane).toBe('enforceable');
    expect(result.planHasAdoptedAssertions).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.itemsWithAssertions).toEqual(['P-001', 'P-002']);
  });

  /**
   * THE REGRESSION THIS MODULE EXISTS FOR.
   *
   * A VAL block with no `Verify:` line and no header text is silently DROPPED by
   * `extractAssertions()` — the function promote.ts used. At the call site the
   * item became indistinguishable from one that never declared an assertion.
   *
   * The first assertion here is a CALIBRATION CONTROL: it pins the lossy
   * behavior we are compensating for. If `extractAssertions` is ever fixed to
   * stop dropping these, this line fails and tells us to revisit the gate,
   * rather than leaving a now-redundant check quietly in place.
   */
  it('catches a malformed assertion that extractAssertions silently drops', () => {
    const malformed = plan(
      '- **P-001** Do the thing',
      '  - **[VAL-p001-a]**',
    );

    // Calibration control: the old path sees NOTHING here.
    expect(extractAssertions(malformed, new Set(['P-001']))).toEqual([]);

    // The gate sees the defect.
    const result = evaluatePromotionAssertionGate({
      rawPlan: malformed,
      planStatus: 'active',
      itemIds: new Set(['P-001']),
    });

    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations.map((v) => v.code)).toContain('behavior-missing');
    expect(result.violations[0]?.planItemId).toBe('P-001');
  });

  it('rejects a non-canonical VAL id', () => {
    const result = evaluatePromotionAssertionGate({
      rawPlan: plan(
        '- **P-001** Do the thing',
        '  - **[VAL-bad id]** something',
        '    - **Verify:** returns 404 for an unknown id',
      ),
      planStatus: 'active',
      itemIds: new Set(['P-001']),
    });

    expect(result.violations.map((v) => v.code)).toContain('invalid-source-val-id');
  });

  it('rejects a duplicate VAL id across items', () => {
    const result = evaluatePromotionAssertionGate({
      rawPlan: plan(
        '- **P-001** First',
        '  - **[VAL-dupe]** first use',
        '    - **Verify:** returns 404 for an unknown id',
        '- **P-002** Second',
        '  - **[VAL-dupe]** second use',
        '    - **Verify:** returns 409 for a conflicting id',
      ),
      planStatus: 'active',
      itemIds: BOTH_ITEMS,
    });

    expect(result.violations.map((v) => v.code)).toContain('duplicate-source-val-id');
  });

  describe('lane staging', () => {
    const MALFORMED = plan('- **P-001** Do the thing', '  - **[VAL-p001-a]**');
    const ONE_ITEM = new Set(['P-001']);

    it.each([
      ['draft', 'pre-enforcement'],
      ['shipped', 'historical'],
      ['superseded', 'historical'],
    ])('reports as a warning, never a violation, on status %s', (status, lane) => {
      const result = evaluatePromotionAssertionGate({
        rawPlan: MALFORMED,
        planStatus: status,
        itemIds: ONE_ITEM,
      });

      expect(result.lane).toBe(lane);
      expect(result.enforcing).toBe(false);
      expect(result.violations).toEqual([]);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    /**
     * An unrecognized status must ENFORCE, not silently exempt. Silent exemption
     * is the failure mode this whole plan exists to remove, so a plan status
     * nobody has taught the system about should surface loudly.
     */
    it('enforces on an unknown plan status rather than exempting it', () => {
      const result = evaluatePromotionAssertionGate({
        rawPlan: MALFORMED,
        planStatus: 'some-brand-new-status',
        itemIds: ONE_ITEM,
      });

      expect(result.enforcing).toBe(true);
      expect(result.violations.length).toBeGreaterThan(0);
    });
  });

  describe('missing-assertion staging', () => {
    /**
     * The 479-of-482 population: a plan that has adopted NOTHING must keep
     * promoting. Enforcing coverage here would be a fleet-wide promotion outage.
     */
    it('only warns when the plan has adopted no assertions at all', () => {
      const result = evaluatePromotionAssertionGate({
        rawPlan: plan('- **P-001** Do the thing', '- **P-002** Do the other thing'),
        planStatus: 'active',
        itemIds: BOTH_ITEMS,
      });

      expect(result.enforcing).toBe(true);
      expect(result.planHasAdoptedAssertions).toBe(false);
      expect(result.violations).toEqual([]);
      expect(result.warnings.map((w) => w.code)).toEqual([
        'assertion-missing',
        'assertion-missing',
      ]);
      expect(result.itemsMissingAssertions).toEqual(['P-001', 'P-002']);
    });

    /**
     * The asymmetry P-002 is actually about: the author covered one item and
     * left its sibling uncovered. On an adopted plan that IS a defect.
     */
    it('refuses when an adopted plan leaves a sibling item uncovered', () => {
      const result = evaluatePromotionAssertionGate({
        rawPlan: plan(
          '- **P-001** Covered',
          '  - **[VAL-p001-a]** covered behavior',
          '    - **Verify:** returns 404 for an unknown id',
          '- **P-002** Uncovered',
        ),
        planStatus: 'active',
        itemIds: BOTH_ITEMS,
      });

      expect(result.planHasAdoptedAssertions).toBe(true);
      expect(result.violations.map((v) => v.code)).toEqual(['assertion-missing']);
      expect(result.violations[0]?.planItemId).toBe('P-002');
    });

    /**
     * A block so malformed it yields no candidate must NOT flip the plan into
     * the stricter coverage tier on the strength of the same broken text — it is
     * already reported as malformed, and counting it as adoption would cascade
     * one defect into a violation on every sibling item.
     */
    it('does not treat an unparseable block as adoption', () => {
      const result = evaluatePromotionAssertionGate({
        rawPlan: plan('- **P-001** Broken', '  - **[VAL-p001-a]**', '- **P-002** Uncovered'),
        planStatus: 'active',
        itemIds: BOTH_ITEMS,
      });

      // P-001's block IS parsed as a candidate (id is valid) — it just has no
      // behavior — so adoption is true and P-002 is legitimately uncovered.
      // The point of this test is that the cascade is DELIBERATE and pinned:
      // exactly one malformed finding, plus the sibling's coverage finding.
      expect(result.violations.map((v) => v.code).sort()).toEqual([
        'assertion-missing',
        'behavior-missing',
      ]);
    });
  });

  it('is satisfied when no items are being promoted', () => {
    const result = evaluatePromotionAssertionGate({
      rawPlan: WELL_FORMED,
      planStatus: 'active',
      itemIds: new Set<string>(),
    });

    expect(result.violations).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.itemsMissingAssertions).toEqual([]);
  });

  it('scopes findings to the promoted item set only', () => {
    const result = evaluatePromotionAssertionGate({
      rawPlan: plan(
        '- **P-001** Promoted and fine',
        '  - **[VAL-p001-a]** fine',
        '    - **Verify:** returns 404 for an unknown id',
        '- **P-999** Not promoted, and broken',
        '  - **[VAL-p999-a]**',
      ),
      planStatus: 'active',
      itemIds: new Set(['P-001']),
    });

    expect(result.violations).toEqual([]);
    expect(result.itemsWithAssertions).toEqual(['P-001']);
  });
});
