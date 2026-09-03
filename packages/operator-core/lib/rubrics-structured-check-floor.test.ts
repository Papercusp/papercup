/**
 * P-013 (design-to-code-coverage-seam-2026-09-02) — the acceptance-rubric
 * STRUCTURED-CHECK FLOOR.
 *
 * ⚠ FIXTURE DISCIPLINE (the lesson P-020 paid for in this same plan): every criterion
 * below is typed as the REAL exported `RubricCriterion`, and every check as the REAL
 * `RubricCriterionCheck` (which is `z.infer<typeof rubricCriterionCheckSchema>` — the
 * schema the propose path actually validates against). A fixture that invents its own
 * row shape encodes the SAME assumption as the code under test and therefore cannot
 * falsify it; P-020 shipped a silent no-op exactly that way, 12/12 green, because the
 * production filter and its fixture agreed on a key that production data never had.
 * If the criterion shape or the check union changes under us, these fixtures stop
 * compiling — which is the point.
 */
import { describe, it, expect } from 'vitest';
import type { RubricCriterionCheck } from './agent-tools/plans/rubric-template';
import {
  acceptanceRubricLacksStructuredCheck,
  structuredCheckFloorRefusal,
  proposeRubric,
  type RubricCriterion,
} from './rubrics';

/** A fuzzy (prose-only) criterion — the population this floor exists to refuse. */
function fuzzyCriterion(key: string): RubricCriterion {
  return {
    key,
    title: `title for ${key}`,
    model: 'how it is supposed to work',
    method: 'how to investigate it',
    driftMarkers: 'what degraded looks like',
  };
}

/** The same criterion, carrying a real structured check. */
function checkedCriterion(key: string, check: RubricCriterionCheck): RubricCriterion {
  return { ...fuzzyCriterion(key), check };
}

const TESTS_CHECK: RubricCriterionCheck = {
  kind: 'tests',
  files: ['packages/operator-core/lib/rubrics-structured-check-floor.test.ts'],
};
/** The explicit MANUAL declaration — a legitimate answer, not a loophole to close. */
const MANUAL_CHECK: RubricCriterionCheck = { kind: 'instrument', instrumentKey: 'none' };

describe('acceptanceRubricLacksStructuredCheck', () => {
  it('REFUSES an acceptance rubric whose criteria are all prose', () => {
    expect(
      acceptanceRubricLacksStructuredCheck({
        kind: 'acceptance',
        criteria: [fuzzyCriterion('a'), fuzzyCriterion('b'), fuzzyCriterion('c')],
      }),
    ).toBe(true);
  });

  it('accepts an acceptance rubric where ONE criterion carries a tests check', () => {
    expect(
      acceptanceRubricLacksStructuredCheck({
        kind: 'acceptance',
        criteria: [fuzzyCriterion('a'), checkedCriterion('b', TESTS_CHECK), fuzzyCriterion('c')],
      }),
    ).toBe(false);
  });

  it("accepts an explicit MANUAL declaration — the floor forbids silence, not manual verification", () => {
    expect(
      acceptanceRubricLacksStructuredCheck({
        kind: 'acceptance',
        criteria: [checkedCriterion('a', MANUAL_CHECK)],
      }),
    ).toBe(false);
  });

  it('exempts the pure-investigation case: empty criteria (classRef, plan D-009)', () => {
    // There is no criterion to attach a check to, so there is nothing to be silent ABOUT.
    expect(acceptanceRubricLacksStructuredCheck({ kind: 'acceptance', criteria: [] })).toBe(false);
  });

  it('leaves NON-acceptance rubrics alone — this is what keeps the cold-start seeder safe', () => {
    // Measured 2026-09-03: all 13 first-party rubric seeds carry kind = null and NONE of
    // them carries a structured check, so a blanket floor would refuse
    // reseedRubricsAfterInstall on every boot. These two cases pin that scoping.
    const prose = [fuzzyCriterion('a'), fuzzyCriterion('b')];
    expect(acceptanceRubricLacksStructuredCheck({ kind: 'standard', criteria: prose })).toBe(false);
    expect(acceptanceRubricLacksStructuredCheck({ kind: '', criteria: prose })).toBe(false);
  });

  it('CALIBRATION: the predicate reads `check`, not merely the presence of some field', () => {
    // Guards against a predicate that accidentally passes on any rich criterion. A
    // criterion carrying instrumentKey but NO structured check is still silence, because
    // the top-level instrumentKey is the legacy binding the check slot generalizes.
    const legacyOnly: RubricCriterion = { ...fuzzyCriterion('a'), instrumentKey: 'some-instrument' };
    expect(acceptanceRubricLacksStructuredCheck({ kind: 'acceptance', criteria: [legacyOnly] })).toBe(
      true,
    );
  });
});

describe('structuredCheckFloorRefusal', () => {
  const text = structuredCheckFloorRefusal({ rubricId: 'acceptance-some-plan', criteriaCount: 4 });

  it('names the refusal code, the rubric and the criteria count', () => {
    expect(text).toContain('acceptance_rubric_needs_structured_check');
    expect(text).toContain("'acceptance-some-plan'");
    expect(text).toContain('4 criteria');
  });

  it('names every repair the schema actually accepts', () => {
    expect(text).toContain("kind:'tests'");
    expect(text).toContain("kind:'cargo'");
    expect(text).toContain("instrumentKey:'none'");
  });

  it('steers authors AWAY from the coverage kind, which would block them at grading', () => {
    // The trap this sentence exists to prevent: kind:'coverage' is authorable and fully
    // wired into scorecards:emit, but all 2,019 censused surfaces sit at meets_l1..l4 = 0
    // (coverage_evidence holds 0 rows) and the grading rule is `belowUnwaived === 0`, so a
    // coverage check satisfies the FLOOR and then refuses the EMIT. See D-034.
    expect(text).toContain("kind:'coverage'");
    expect(text).toMatch(/do NOT reach for/i);
    expect(text).toContain('coverage_evidence is empty');
  });

  it('tells a pure-investigation author the exemption exists', () => {
    expect(text).toContain('classRef');
  });
});

/**
 * THE WIRING PROOF — the half a pure-predicate suite cannot give you.
 *
 * P-020 (same plan, same session) shipped a sweep whose unit tests were 12/12 green while
 * the production path silently did nothing, because the tests only ever exercised the
 * predicate. So these two cases drive the REAL `proposeRubric`.
 *
 * They need no database, and that is itself the assertion: the floor is placed BEFORE the
 * first PG-touching guard (`assertAcceptanceLinksResolve`). Both cases name a subjectPlan
 * that does not exist, so if the floor did NOT fire, control would reach Postgres and the
 * refusal would be the dangling-link one instead. Which error comes back therefore proves
 * the wiring AND the ordering at once.
 */
describe('proposeRubric wiring: the floor fires before any database access', () => {
  const proseOnly = {
    rubricId: 'scratch-p013-wiring-probe',
    kind: 'acceptance' as const,
    subjectPlan: 'this-plan-does-not-exist-p013-probe',
    characteristic: 'probe',
    title: 'P-013 wiring probe',
    description: 'must be refused by the structured-check floor',
    criteria: [fuzzyCriterion('prose-only-a'), fuzzyCriterion('prose-only-b')],
  };

  it('refuses a prose-only acceptance rubric with OUR refusal, never reaching PG', async () => {
    await expect(proposeRubric(proseOnly)).rejects.toThrow(
      /acceptance_rubric_needs_structured_check/,
    );
  });

  it('POSITIVE CONTROL: the same rubric WITH a check gets PAST the floor', async () => {
    // It must still fail — its subjectPlan is dangling — but for a DIFFERENT reason. This
    // is what separates a working floor from one that refuses every acceptance proposal.
    // An 'instrument' check is used deliberately: it has no filesystem dependency, so this
    // control cannot be confounded by check-path validation.
    const withCheck = {
      ...proseOnly,
      criteria: [fuzzyCriterion('prose-only-a'), checkedCriterion('manual-b', MANUAL_CHECK)],
    };
    const err = await proposeRubric(withCheck).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(err).not.toBeNull();
    expect(err).not.toMatch(/acceptance_rubric_needs_structured_check/);
  });
});
