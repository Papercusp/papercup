/**
 * Acceptance for the target-list tiering rule (fundraise-automation-2026-08-23 P-001 / P-002).
 *
 * The single most important assertion here is that NO INPUT PRODUCES A TIER 3. The plan's list
 * discipline is "tier 1 = matched + warm, tier 2 = matched cold, tier 3 does not exist", and the
 * pressure to violate it is real and predictable: a list short of its target count, with a
 * plausible name available. `never admits an unmatched target` is the executable form of that rule.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyTarget,
  isRealWarmPath,
  assessList,
  TARGET_LIST_MAX,
  type TargetAssessment,
} from './pipeline-tiering';

const confirmedWarm = { connector: 'Dana', connectorRelationship: 'former colleague', connectorConfirmed: true };

function target(overrides: Partial<TargetAssessment> = {}): TargetAssessment {
  return { counterparty: 'Example Capital', thesisMatch: 'strong', researched: true, ...overrides };
}

describe('warm path reality check', () => {
  it('accepts a named, confirmed connector', () => {
    expect(isRealWarmPath(confirmedWarm)).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty object', {}],
    ['unnamed connector', { connectorConfirmed: true }],
    ['blank connector', { connector: '   ', connectorConfirmed: true }],
    ['unconfirmed connector', { connector: 'Dana', connectorRelationship: 'met once' }],
    ['explicitly unconfirmed', { connector: 'Dana', connectorConfirmed: false }],
  ])('rejects %s', (_label, value) => {
    expect(isRealWarmPath(value as never)).toBe(false);
  });
});

describe('tiering', () => {
  it('puts a matched target with a confirmed warm path in tier 1', () => {
    const decision = classifyTarget(target({ warmPath: confirmedWarm }));
    expect(decision).toMatchObject({ admitted: true, tier: 1, code: 'tier-1-warm-and-matched' });
    expect(decision.reason).toContain('Dana');
  });

  it('puts a matched target with no warm path in tier 2', () => {
    expect(classifyTarget(target())).toMatchObject({
      admitted: true,
      tier: 2,
      code: 'tier-2-matched-cold',
    });
  });

  it('treats a plausible match as admissible, not just a strong one', () => {
    expect(classifyTarget(target({ thesisMatch: 'plausible' })).admitted).toBe(true);
  });

  it('drops a weak thesis match even when the warm path is excellent', () => {
    const decision = classifyTarget(target({ thesisMatch: 'weak', warmPath: confirmedWarm }));
    expect(decision).toMatchObject({ admitted: false, tier: null, code: 'dropped-weak-thesis' });
    expect(decision.reason).toContain('correct outcome');
  });

  it('refuses to tier an unresearched target', () => {
    expect(classifyTarget(target({ researched: false }))).toMatchObject({
      admitted: false,
      code: 'dropped-unresearched',
    });
  });

  it.each([
    ['null', null],
    ['a string', 'Example Capital'],
    ['an array', []],
    ['no counterparty', { thesisMatch: 'strong' }],
    ['a blank counterparty', { counterparty: '  ', thesisMatch: 'strong' }],
  ])('drops %s as malformed rather than guessing a tier', (_label, value) => {
    expect(classifyTarget(value as never)).toMatchObject({
      admitted: false,
      tier: null,
      code: 'dropped-malformed',
    });
  });

  it('never admits an unmatched target — there is no tier 3', () => {
    // Exhaustive over the rule's real input space, so a future edit cannot introduce a third
    // tier or admit an unmatched name without failing here.
    const matches = ['strong', 'plausible', 'weak'] as const;
    const warmths = [undefined, null, { connector: 'Dana' }, confirmedWarm];
    const researched = [true, false];

    for (const thesisMatch of matches) {
      for (const warmPath of warmths) {
        for (const wasResearched of researched) {
          const decision = classifyTarget(
            target({ thesisMatch, warmPath: warmPath as never, researched: wasResearched }),
          );
          expect(decision.tier === null || decision.tier === 1 || decision.tier === 2).toBe(true);
          if (thesisMatch === 'weak' || !wasResearched) {
            expect(decision.admitted).toBe(false);
          }
          if (decision.admitted) expect(decision.tier).not.toBeNull();
          else expect(decision.tier).toBeNull();
        }
      }
    }
  });
});

describe('list health', () => {
  const matchedCold = target();
  const matchedWarm = target({ warmPath: confirmedWarm });

  it('counts tiers and drops', () => {
    const health = assessList([matchedWarm, matchedCold, target({ thesisMatch: 'weak' })]);
    expect(health).toMatchObject({ total: 2, tier1: 1, tier2: 1, dropped: 1 });
  });

  it('warns when a list has no warm paths at all', () => {
    const health = assessList([matchedCold, matchedCold]);
    expect(health.warnings.join(' ')).toContain('all-cold list is a mapping gap');
  });

  it('warns when the list grows past the band', () => {
    const health = assessList(Array.from({ length: TARGET_LIST_MAX + 1 }, () => matchedWarm));
    expect(health.withinTargetBand).toBe(false);
    expect(health.warnings.join(' ')).toContain('qualification failure');
  });

  it('warns when qualification dropped nobody', () => {
    const health = assessList(Array.from({ length: 120 }, () => matchedWarm));
    expect(health.warnings.join(' ')).toContain('is not qualifying');
  });

  it('is quiet on a healthy list (positive control)', () => {
    // Calibration: without this, every warning test above would also pass a function that
    // always warns.
    const list = [
      ...Array.from({ length: 70 }, () => matchedWarm),
      ...Array.from({ length: 40 }, () => matchedCold),
      ...Array.from({ length: 15 }, () => target({ thesisMatch: 'weak' })),
    ];
    const health = assessList(list);
    expect(health).toMatchObject({ total: 110, tier1: 70, tier2: 40, dropped: 15 });
    expect(health.withinTargetBand).toBe(true);
    expect(health.warnings).toEqual([]);
  });

  it('reports an empty list without warning about it', () => {
    expect(assessList([])).toMatchObject({ total: 0, warnings: [], withinTargetBand: false });
  });
});
