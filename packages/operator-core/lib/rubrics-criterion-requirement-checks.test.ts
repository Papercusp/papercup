/**
 * kind:'requirements' criterion checks — the activation↔completion join exposed to the
 * independent grader (design-to-code-coverage-seam-2026-09-02 P-026).
 *
 * The suite is built around the two things this check can get WRONG in a way that looks
 * right: passing vacuously over an empty population, and counting in mixed units. Both
 * are failure modes this plan measured elsewhere, so a test that only asserted the happy
 * path would be self-refuting.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ActivationAuditMapping, EffectiveItemAudit, PlanItemStatus } from './plan-audits';
import {
  evaluateCriterionRequirementChecks,
  type CheckedCriterion,
  type RequirementRealizationReader,
} from './rubrics-criterion-checks';

const REQUIREMENTS_CHECK = { kind: 'requirements' } as const;

function mapping(
  id: string,
  planTargets: string[],
  disposition: ActivationAuditMapping['disposition'] = 'covered',
): ActivationAuditMapping {
  return {
    id,
    sourceRefs: [`session_turn:claude:sess-1:${id}`],
    requirement: `requirement ${id}`,
    planTargets,
    disposition,
  };
}

/** An audit entry carrying a VERIFYING (code) citation — the item is proven. */
function verifiedAudit(itemId: string): EffectiveItemAudit {
  return {
    entry: {
      itemId,
      verdict: 'implemented',
      citations: [{ kind: 'code', path: 'packages/operator-core/lib/example.ts', line: 1 }],
    },
    auditSeq: 1,
  };
}

/** An audit entry whose only citation is `doc` — explicitly NON-verification (D-008). */
function unverifiedAudit(itemId: string): EffectiveItemAudit {
  return {
    entry: {
      itemId,
      verdict: 'implemented',
      citations: [{ kind: 'doc', ref: 'some-doc', reason: 'described, not proven' }],
    },
    auditSeq: 1,
  };
}

function items(...specs: Array<[string, string]>): PlanItemStatus[] {
  return specs.map(([itemId, status]) => ({ itemId, status, itemText: `text for ${itemId}` }));
}

function reader(payload: {
  mappings: ActivationAuditMapping[];
  itemAudits?: EffectiveItemAudit[];
  planItems?: PlanItemStatus[];
  planSlug?: string;
}): RequirementRealizationReader {
  return async () => ({
    planSlug: payload.planSlug ?? 'a-plan',
    mappings: payload.mappings,
    itemAudits: payload.itemAudits ?? [],
    planItems: payload.planItems ?? [],
  });
}

const criteria: CheckedCriterion[] = [{ key: 'requirements-realized', check: REQUIREMENTS_CHECK }];
const healthyRating = { 'requirements-realized': { rating: 'healthy' } };

describe('evaluateCriterionRequirementChecks — the happy path', () => {
  it('uses the same exact non-code proof as the ship gate', async () => {
    const audit = unverifiedAudit('P-001');
    audit.entry.verdict = 'not-code';
    audit.entry.note = 'Verified operational outcome.';
    const result = await evaluateCriterionRequirementChecks({
      criteria, ratings: healthyRating,
      readRequirementRealization: async () => ({
        planSlug: 'a-plan', mappings: [mapping('M-001', ['P-001'])], itemAudits: [audit],
        planItems: items(['P-001', 'done']),
        nonCodeItemProofs: [{ planItemId: 'P-001', barKeys: ['R-1'], evidenceRefs: ['probe:current'] }],
      }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.checkRuns['requirements-realized']).toMatchObject({ verdict: 'pass', unrealized: 0 });
  });

  it('passes and records the run when every realizing requirement reaches a verified item', async () => {
    const result = await evaluateCriterionRequirementChecks({
      criteria,
      ratings: healthyRating,
      readRequirementRealization: reader({
        mappings: [mapping('M-001', ['P-001']), mapping('M-002', ['P-002'], 'repaired')],
        itemAudits: [verifiedAudit('P-001'), verifiedAudit('P-002')],
        planItems: items(['P-001', 'done'], ['P-002', 'done']),
      }),
      nowIso: () => '2026-09-03T00:00:00.000Z',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.checkRuns['requirements-realized']).toEqual({
      kind: 'requirements',
      verdict: 'pass',
      mappingsJudged: 2,
      checkedTargets: 2,
      unrealized: 0,
      unrealizedEntries: 0,
      exemptMappings: 0,
      droppedTargets: 0,
      droppedTargetsVouchedByStaleAudit: 0,
      measuredAt: '2026-09-03T00:00:00.000Z',
    });
  });

  it('ignores criteria that carry no requirements check, and criteria that were not rated', async () => {
    const readRequirementRealization = vi.fn(
      reader({ mappings: [mapping('M-001', ['P-001'])], itemAudits: [verifiedAudit('P-001')] }),
    );
    const result = await evaluateCriterionRequirementChecks({
      criteria: [
        { key: 'fuzzy' },
        { key: 'tests-bound', check: { kind: 'tests', files: ['a.test.ts'] } },
        { key: 'unrated', check: REQUIREMENTS_CHECK },
      ],
      ratings: { fuzzy: { rating: 'healthy' }, 'tests-bound': { rating: 'healthy' } },
      readRequirementRealization,
    });

    expect(result).toEqual({ ok: true, checkRuns: {} });
    // The reader is a database round-trip; an unrated criterion must not pay for it.
    expect(readRequirementRealization).not.toHaveBeenCalled();
  });

  it('resolves the subject plan ONCE even when several criteria carry the check', async () => {
    const readRequirementRealization = vi.fn(
      reader({ mappings: [mapping('M-001', ['P-001'])], itemAudits: [verifiedAudit('P-001')] }),
    );
    const result = await evaluateCriterionRequirementChecks({
      criteria: [
        { key: 'a', check: REQUIREMENTS_CHECK },
        { key: 'b', check: REQUIREMENTS_CHECK },
      ],
      ratings: { a: { rating: 'healthy' }, b: { rating: 'healthy' } },
      readRequirementRealization,
    });

    expect(result.ok).toBe(true);
    // Two reads could disagree if the audit moved between them, and the card would then
    // carry two verdicts about one plan.
    expect(readRequirementRealization).toHaveBeenCalledTimes(1);
  });
});

describe('evaluateCriterionRequirementChecks — refusing what cannot be judged', () => {
  it('refuses when the scorecard names no subject plan', async () => {
    const result = await evaluateCriterionRequirementChecks({
      criteria,
      ratings: healthyRating,
      readRequirementRealization: async () => null,
    });

    expect(result).toMatchObject({ ok: false, error: 'requirements_no_plan_subject' });
  });

  it('REFUSES a plan with no activation mappings rather than passing vacuously', async () => {
    const result = await evaluateCriterionRequirementChecks({
      criteria,
      ratings: healthyRating,
      readRequirementRealization: reader({ mappings: [] }),
    });

    expect(result).toMatchObject({ ok: false, error: 'requirements_scope_empty' });
    if (result.ok) return;
    expect(result.detail).toContain('NO activation-audit mappings at all');
  });

  it('REFUSES when mappings exist but none is dispositioned covered/repaired', async () => {
    // The subtler empty population: an activation audit that ran and concluded every
    // requirement was rejected or left open. Nothing claims realization, so there is
    // nothing to verify — and a green criterion here would be read by the grader as
    // independent evidence that the promises were kept.
    const result = await evaluateCriterionRequirementChecks({
      criteria,
      ratings: healthyRating,
      readRequirementRealization: reader({
        mappings: [mapping('M-001', ['P-001'], 'rejected'), mapping('M-002', ['P-002'], 'open')],
        itemAudits: [verifiedAudit('P-001')],
      }),
    });

    expect(result).toMatchObject({ ok: false, error: 'requirements_scope_empty' });
    if (result.ok) return;
    expect(result.detail).toContain('no mappings dispositioned covered/repaired');
  });

  it("states WHY it diverges from the ship gate, so the difference is not read as a bug", async () => {
    // The gate fails OPEN on this same condition by documented design. A future reader
    // comparing the two will see an inconsistency; the refusal has to explain itself.
    const result = await evaluateCriterionRequirementChecks({
      criteria,
      ratings: healthyRating,
      readRequirementRealization: reader({ mappings: [] }),
    });

    if (result.ok) throw new Error('expected a refusal');
    expect(result.detail).toContain('fails OPEN');
    expect(result.detail).toContain('vacuous');
  });
});

describe('evaluateCriterionRequirementChecks — a measured gap outranks judgment', () => {
  const unrealizedInput = {
    mappings: [mapping('M-001', ['P-001'])],
    itemAudits: [unverifiedAudit('P-001')],
    planItems: items(['P-001', 'done']),
  };

  it('refuses a pass-claiming rating that the join contradicts', async () => {
    const result = await evaluateCriterionRequirementChecks({
      criteria,
      ratings: healthyRating,
      readRequirementRealization: reader(unrealizedInput),
    });

    expect(result).toMatchObject({ ok: false, error: 'requirements_contradicted', rating: 'healthy' });
    if (result.ok || result.error !== 'requirements_contradicted') return;
    expect(result.run.verdict).toBe('fail');
    expect(result.run.unrealized).toBe(1);
    expect(result.detail).toContain('requirement M-001');
  });

  it('RECORDS the failing run without refusing when the rating is honest', async () => {
    const result = await evaluateCriterionRequirementChecks({
      criteria,
      ratings: { 'requirements-realized': { rating: 'broken' } },
      readRequirementRealization: reader(unrealizedInput),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const run = result.checkRuns['requirements-realized'];
    expect(run).toMatchObject({ kind: 'requirements', verdict: 'fail', unrealized: 1 });
  });
});

describe('evaluateCriterionRequirementChecks — the counts are in honest units', () => {
  it('counts the DENOMINATOR in mappings, not targets', async () => {
    // The bug this guards: deriving the denominator as `checkedTargets +
    // exemptMappings.length` adds a target count to a mapping count. One mapping naming
    // four items would report 4, and D-035 measured that error running ~11x fleet-wide.
    const result = await evaluateCriterionRequirementChecks({
      criteria,
      ratings: healthyRating,
      readRequirementRealization: reader({
        mappings: [mapping('M-001', ['P-001', 'P-002', 'P-003', 'P-004'])],
        itemAudits: [
          verifiedAudit('P-001'),
          verifiedAudit('P-002'),
          verifiedAudit('P-003'),
          verifiedAudit('P-004'),
        ],
        planItems: items(['P-001', 'done'], ['P-002', 'done'], ['P-003', 'done'], ['P-004', 'done']),
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const run = result.checkRuns['requirements-realized'];
    expect(run).toMatchObject({ mappingsJudged: 1, checkedTargets: 4 });
  });

  it('reports ONE unrealized requirement routed to three unproven items, with the entry count beside it', async () => {
    const result = await evaluateCriterionRequirementChecks({
      criteria,
      ratings: { 'requirements-realized': { rating: 'broken' } },
      readRequirementRealization: reader({
        mappings: [mapping('M-001', ['P-001', 'P-002', 'P-003'])],
        itemAudits: [unverifiedAudit('P-001'), unverifiedAudit('P-002'), unverifiedAudit('P-003')],
        planItems: items(['P-001', 'done'], ['P-002', 'done'], ['P-003', 'done']),
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const run = result.checkRuns['requirements-realized'];
    // One requirement is unkept; it is unkept in three places. Both facts, both units.
    expect(run).toMatchObject({ unrealized: 1, unrealizedEntries: 3, mappingsJudged: 1 });
  });

  it('reports the exempt population (D-035) without ever making it a violation', async () => {
    const result = await evaluateCriterionRequirementChecks({
      criteria,
      ratings: healthyRating,
      readRequirementRealization: reader({
        mappings: [
          mapping('M-001', ['P-001']),
          // Judged by nothing: a conversational requirement whose home is a decision.
          mapping('M-002', ['D-004', 'section:Rationale']),
        ],
        itemAudits: [verifiedAudit('P-001')],
        planItems: items(['P-001', 'done']),
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const run = result.checkRuns['requirements-realized'];
    expect(run).toMatchObject({ verdict: 'pass', mappingsJudged: 2, checkedTargets: 1, exemptMappings: 1 });
  });

  it('reports a dropped target still vouched by a stale pre-drop audit entry (P-016)', async () => {
    const result = await evaluateCriterionRequirementChecks({
      criteria,
      ratings: healthyRating,
      readRequirementRealization: reader({
        mappings: [mapping('M-001', ['P-001'])],
        // The item was audited with a verifying citation, THEN dropped from the plan.
        itemAudits: [verifiedAudit('P-001')],
        planItems: items(['P-001', 'dropped']),
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const run = result.checkRuns['requirements-realized'];
    expect(run).toMatchObject({ droppedTargets: 1, droppedTargetsVouchedByStaleAudit: 1 });
  });

  it('CONTROL: the mixed-unit denominator this suite guards against really is distinguishable here', async () => {
    // The repo's falsifiability discipline for an imported module: keep the deliberately
    // WRONG implementation in the test as a permanent control, so the fixture is proven
    // to discriminate rather than assumed to. Without this, `mappingsJudged: 1` above
    // could be passing because the fixture is degenerate.
    //
    // `checkedTargets + exemptMappings.length` is the arithmetic the first draft of this
    // module actually shipped, and it is wrong in the unit, not the value: it adds a
    // TARGET count to a MAPPING count.
    const input = {
      mappings: [mapping('M-001', ['P-001', 'P-002', 'P-003', 'P-004'])],
      itemAudits: [
        verifiedAudit('P-001'),
        verifiedAudit('P-002'),
        verifiedAudit('P-003'),
        verifiedAudit('P-004'),
      ],
      planItems: items(['P-001', 'done'], ['P-002', 'done'], ['P-003', 'done'], ['P-004', 'done']),
    };
    const result = await evaluateCriterionRequirementChecks({
      criteria,
      ratings: healthyRating,
      readRequirementRealization: reader(input),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const run = result.checkRuns['requirements-realized'];
    if (run.kind !== 'requirements') throw new Error('expected a requirements run');

    // The WRONG denominator, computed here from the same run the subject produced.
    const buggyDenominator = run.checkedTargets + run.exemptMappings;

    // CALIBRATION: the real subject must pass — one mapping was judged.
    expect(run.mappingsJudged).toBe(1);
    // FALSIFIER: and the buggy form must produce a DIFFERENT answer on this fixture,
    // which is what makes the assertion above capable of failing.
    expect(buggyDenominator).toBe(4);
    expect(buggyDenominator).not.toBe(run.mappingsJudged);
  });

  it('bounds the named requirements and says the sample stands for more', async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      mapping(`M-${String(i + 1).padStart(3, '0')}`, [`P-${String(i + 1).padStart(3, '0')}`]),
    );
    const result = await evaluateCriterionRequirementChecks({
      criteria,
      ratings: healthyRating,
      readRequirementRealization: reader({
        mappings: many,
        itemAudits: many.map((m) => unverifiedAudit(m.planTargets[0]!)),
        planItems: items(...many.map((m) => [m.planTargets[0]!, 'done'] as [string, string])),
      }),
    });

    expect(result).toMatchObject({ ok: false, error: 'requirements_contradicted' });
    if (result.ok || result.error !== 'requirements_contradicted') return;
    // A bounded sample presented as the whole is the same lie as a bounded aggregate
    // presented as a total, so the message must say there are more.
    expect(result.run.unrealized).toBe(12);
    expect(result.run.unrealizedRequirements).toHaveLength(8);
    expect(result.detail).toContain('+4 more');
  });
});
