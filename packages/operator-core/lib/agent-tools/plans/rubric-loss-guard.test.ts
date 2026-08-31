/**
 * rubric-loss-guard.test.ts — the RECURRENCE GUARD for EI-21972673091438558.
 *
 * A rubric's criteria live in a plan row's `template_data`. Two doors write that column,
 * and until this guard only `rubrics:propose` was checked: `plans:set-template-data`
 * validates STRUCTURE ONLY, so a criteria array of length 1 satisfied its zod schema
 * exactly as well as one of length 27. The portfolio-activity-floor criterion added by
 * goal-mode-drift-guards P-001 went in through that unguarded door and could have been
 * deleted through it just as silently.
 *
 * These cases pin the RULES (this file, pure). The WIRING — that withPlanLock actually
 * calls the guard on the set-template-data path — is pinned by
 * rubrics.integration.test.ts § 'template_data persistence boundary', because the
 * boundary itself is DB-bound. Both are required: rules that nothing calls, and a call
 * site with no rules, each look exactly like a working guard from the other side.
 */
import { describe, expect, it } from 'vitest';
import {
  assertNoSilentRubricTemplateDataLoss,
  collectRubricLossViolations,
  criterionProcedureText,
  METHOD_SHRINK_GUARD_MIN_CHARS,
  REPLICATION_DRILL_MARKER,
  type RubricLossCriterion,
} from './rubric-loss-guard';

const LONG_DRILL =
  `${REPLICATION_DRILL_MARKER} — full end-to-end procedure: seed two SYNTHETIC portfolio acts ` +
  'inside the graded window, confirm the ledger query returns exactly those two, then delete ' +
  'them and confirm the same query returns zero. A zero from a mis-scoped query is byte-identical ' +
  'to a genuinely idle subject, so the positive control is what tells the two apart. Only after ' +
  'the control passes may a zero be rated FAIL rather than unknown.';

function crit(over: Partial<RubricLossCriterion> = {}): RubricLossCriterion {
  return { key: 'a', method: LONG_DRILL, ...over };
}

/** The stored rubric these cases defend: two criteria, one carrying a long drill. */
function storedCriteria(): RubricLossCriterion[] {
  return [crit({ key: 'portfolio-activity-floor' }), crit({ key: 'never-implements' })];
}

/** template_data as the rubric schema actually stores it. */
function templateData(criteria: RubricLossCriterion[]): unknown {
  return {
    characteristic: 'goal-mode',
    criteria: criteria.map((c) => ({
      key: c.key,
      title: c.key,
      model: 'model prose',
      method: c.method ?? 'method prose',
      driftMarkers: 'drift prose',
      ...(c.replication !== undefined ? { replication: c.replication } : {}),
      ...(c.check !== undefined ? { check: c.check } : {}),
      ...(c.criterionClass !== undefined ? { criterionClass: c.criterionClass } : {}),
    })),
    ratingScale: ['pass', 'fail', 'unknown'],
  };
}

describe('collectRubricLossViolations — the shared rule core', () => {
  it('passes an identical resubmit and an ADDITIVE one (the P-001 write itself)', () => {
    expect(collectRubricLossViolations(storedCriteria(), storedCriteria())).toEqual([]);
    expect(
      collectRubricLossViolations(storedCriteria(), [...storedCriteria(), crit({ key: 'new' })]),
    ).toEqual([]);
  });

  it('reports a dropped criterion, and names the dropKeys ack that would allow it', () => {
    const violations = collectRubricLossViolations(storedCriteria(), [
      crit({ key: 'never-implements' }),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("'portfolio-activity-floor'");
    expect(violations[0]).toContain('dropKeys');
  });

  it('accepts a dropped criterion once it is acknowledged', () => {
    expect(
      collectRubricLossViolations(storedCriteria(), [crit({ key: 'never-implements' })], {
        dropKeys: ['portfolio-activity-floor'],
      }),
    ).toEqual([]);
  });

  it('reports a gutted procedure (marker loss) on a surviving criterion', () => {
    const gutted = storedCriteria().map((c) =>
      c.key === 'portfolio-activity-floor' ? { ...c, method: 'Check it.' } : c,
    );
    const violations = collectRubricLossViolations(storedCriteria(), gutted);
    expect(violations.join(' ')).toContain(REPLICATION_DRILL_MARKER);
    // ...and an explained shrink is allowed.
    expect(
      collectRubricLossViolations(storedCriteria(), gutted, {
        allowMethodShrink: true,
        shrinkReason: 'drill moved to the shared methodRef',
      }),
    ).toEqual([]);
  });

  it('reports structured-check removal and violatable→settle-once downgrade', () => {
    const withCheck = storedCriteria().map((c) =>
      c.key === 'never-implements'
        ? { ...c, check: { kind: 'tests' }, criterionClass: 'violatable' }
        : c,
    );
    const weakened = withCheck.map((c) =>
      c.key === 'never-implements' ? { key: c.key, method: c.method } : c,
    );
    const violations = collectRubricLossViolations(withCheck, weakened).join(' ');
    expect(violations).toContain('LOSES its structured tests check');
    expect(violations).toContain('DOWNGRADES');
  });

  it('does not fire on a short method being reworded (below the shrink floor)', () => {
    const short = [crit({ key: 'a', method: 'Count the acts.' })];
    expect(short[0]!.method!.length).toBeLessThan(METHOD_SHRINK_GUARD_MIN_CHARS);
    expect(collectRubricLossViolations(short, [crit({ key: 'a', method: 'Count acts.' })])).toEqual(
      [],
    );
  });

  it('treats method+replication as ONE procedure text — moving the drill is not a loss', () => {
    const before = [crit({ key: 'a', method: LONG_DRILL })];
    const after = [crit({ key: 'a', method: 'See the drill.', replication: LONG_DRILL })];
    expect(criterionProcedureText(after[0]!)).toContain(REPLICATION_DRILL_MARKER);
    expect(collectRubricLossViolations(before, after)).toEqual([]);
  });
});

describe('assertNoSilentRubricTemplateDataLoss — the persistence boundary', () => {
  const stored = templateData(storedCriteria());

  it('THROWS when a template_data write would delete a stored criterion', () => {
    expect(() =>
      assertNoSilentRubricTemplateDataLoss({
        slug: 'goal-mode-e2e',
        storedTemplateData: stored,
        nextTemplateData: templateData([crit({ key: 'never-implements' })]),
      }),
    ).toThrowError(/portfolio-activity-floor/);
  });

  it('THROWS with the invalid_args caller-error prefix, pointing at the acking verbs', () => {
    let message = '';
    try {
      assertNoSilentRubricTemplateDataLoss({
        slug: 'goal-mode-e2e',
        storedTemplateData: stored,
        nextTemplateData: templateData([crit({ key: 'never-implements' })]),
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message.startsWith('invalid_args:')).toBe(true);
    expect(message).toContain('rubrics:propose');
    expect(message).toContain('plans:set-template-data');
  });

  it('THROWS on a CLEAR — data:null erases every criterion at once', () => {
    expect(() =>
      assertNoSilentRubricTemplateDataLoss({
        slug: 'goal-mode-e2e',
        storedTemplateData: stored,
        nextTemplateData: null,
      }),
    ).toThrowError(/DROPS 2 stored criteria/);
  });

  it('allows the same deletion once the caller acknowledged it (the propose door)', () => {
    expect(() =>
      assertNoSilentRubricTemplateDataLoss({
        slug: 'goal-mode-e2e',
        storedTemplateData: stored,
        nextTemplateData: templateData([crit({ key: 'never-implements' })]),
        ack: { dropKeys: ['portfolio-activity-floor'] },
      }),
    ).not.toThrow();
  });

  it('allows an ADDITIVE write — how P-001 added the floor criterion in the first place', () => {
    expect(() =>
      assertNoSilentRubricTemplateDataLoss({
        slug: 'goal-mode-e2e',
        storedTemplateData: templateData([crit({ key: 'never-implements' })]),
        nextTemplateData: stored,
      }),
    ).not.toThrow();
  });

  it('is inert for a brand-new rubric and for unparseable stored data', () => {
    const next = templateData([crit({ key: 'only-one' })]);
    for (const storedData of [null, undefined, { not: 'a rubric' }, { criteria: [] }]) {
      expect(() =>
        assertNoSilentRubricTemplateDataLoss({
          slug: 'fresh',
          storedTemplateData: storedData,
          nextTemplateData: next,
        }),
      ).not.toThrow();
    }
  });
});
