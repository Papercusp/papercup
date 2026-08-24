import { describe, expect, it, vi } from 'vitest';

import { computeSpecReconciliationLedger, type PlanAdoptionRow } from './spec-reconciliation';
import type { PlanSpecCoverageAggregate } from './plan-spec-coverage-gate';

/**
 * P-012 — the reconciliation ledger.
 *
 * The properties under test are all forms of ONE claim: an absence must never render as a
 * pass. Live census of papercusp at 2026-08-24 found 1,306 plans and exactly ONE with any
 * first-class clause (two of them). So a gate that refuses on "uncovered clause" is
 * trivially satisfied by ~1,287 plans that never declared a behavior — the strongest
 * possible result produced by the weakest possible input. Every assertion below exists to
 * keep that distinguishable before P-013 turns enforcement on.
 *
 * The permanent negative control at the bottom is a rollup consumer that checks ONE
 * boundedness axis. It exists because `countsAreFloor` composes two independent axes, and
 * a caller that checks only the obvious one reads a floor as a total.
 */

type Aggregate = PlanSpecCoverageAggregate;

function aggregate(over: Partial<Aggregate> = {}): Aggregate {
  return {
    planSlug: 'p',
    clauses: { total: 3, enforceable: 2, exempt: 1, draft: 0, inactive: 0, falsifierDeclared: 2 },
    coverage: { proven: 2, staleProof: 0, unproven: 0, staleProofClauses: [], unprovenSpecIds: [] },
    adequacy: { graded: 2, ungraded: 0, ungradedSpecIds: [] },
    bounded: {
      evidenceCensusLimit: 2000,
      evidenceRowsRead: 5,
      truncatedByLimit: false,
      adequacyClauseLimit: 200,
      adequacyTruncatedByLimit: false,
    },
    ...over,
  } as Aggregate;
}

const plan = (over: Partial<PlanAdoptionRow> = {}): PlanAdoptionRow => ({
  planSlug: 'plan-a',
  status: 'active',
  clauseCount: 0,
  legacyValSignal: false,
  ...over,
});

/** Build a ledger over an explicit population, with a stub census. */
function ledgerOver(rows: PlanAdoptionRow[], coverage?: (slug: string) => Aggregate | Promise<never>) {
  const computeCoverage = vi.fn(async ({ planSlug }: { planSlug: string }) => {
    const r = coverage?.(planSlug) ?? aggregate({ planSlug });
    return r as Aggregate;
  });
  return {
    computeCoverage,
    run: (planLimit?: number) =>
      computeSpecReconciliationLedger(
        { harnessSlug: 'papercusp', planLimit },
        {
          listPlanAdoption: async ({ limit }) => rows.slice(0, limit),
          computeCoverage: computeCoverage as never,
        },
      ),
  };
}

describe('P-012 ledger — an absence is never a pass', () => {
  it('reports a plan with NO declared behavior as work, not compliance', async () => {
    const { run } = ledgerOver([plan({ planSlug: 'empty-plan' })]);
    const { rows, rollup } = await run();

    expect(rows[0].adoption).toBe('no-behavior-declared');
    expect(rows[0].actions.map((a) => a.kind)).toEqual(['declare-behavior']);
    expect(rollup.byAdoption['no-behavior-declared']).toBe(1);
    // The trap this exists for: zero clauses and zero uncovered clauses.
    expect(rollup.clauses.total).toBe(0);
    expect(rollup.coverage.unproven).toBe(0);
    // ...yet the plan is emphatically NOT actionless.
    expect(rows[0].actions).not.toHaveLength(0);
  });

  it('reports a legacy VAL-only plan as a BACKFILL, distinct from an empty one', async () => {
    const { run } = ledgerOver([
      plan({ planSlug: 'legacy', legacyValSignal: true }),
      plan({ planSlug: 'empty' }),
    ]);
    const { rows, rollup } = await run();

    expect(rows[0].adoption).toBe('legacy-val-only');
    expect(rows[0].actions[0].kind).toBe('backfill-val-clauses');
    expect(rows[1].adoption).toBe('no-behavior-declared');
    // Both have zero clauses; they must not collapse into one bucket.
    expect(rollup.byAdoption).toMatchObject({
      'legacy-val-only': 1,
      'no-behavior-declared': 1,
      adopted: 0,
    });
  });

  it('never censuses a plan that adopted nothing', async () => {
    const { computeCoverage, run } = ledgerOver([
      plan({ planSlug: 'legacy', legacyValSignal: true }),
      plan({ planSlug: 'empty' }),
    ]);
    await run();

    expect(computeCoverage).not.toHaveBeenCalled();
  });

  it('censuses each ADOPTED plan exactly once, through the injected gate census', async () => {
    const { computeCoverage, run } = ledgerOver([
      plan({ planSlug: 'adopted-1', clauseCount: 2 }),
      plan({ planSlug: 'adopted-2', clauseCount: 1 }),
    ]);
    const { rollup } = await run();

    // One call per adopted plan — no second census, and no per-plan fan-out beyond it.
    expect(computeCoverage).toHaveBeenCalledTimes(2);
    expect(rollup.byAdoption.adopted).toBe(2);
    expect(rollup.clauses.total).toBe(6);
  });
});

describe('P-012 ledger — historical plans are visible but never blocking', () => {
  it.each(['shipped', 'superseded'])('puts a %s plan in the historical lane with no actions', async (status) => {
    const { run } = ledgerOver([plan({ planSlug: 'old', status, legacyValSignal: true })]);
    const { rows, rollup } = await run();

    expect(rows[0].lane).toBe('historical');
    expect(rows[0].actions).toEqual([]);
    expect(rollup.byLane.historical).toBe(1);
  });

  it('excludes historical plans from the adoption partition enforcement will hit', async () => {
    const { run } = ledgerOver([
      plan({ planSlug: 'old', status: 'shipped', legacyValSignal: true }),
      plan({ planSlug: 'live', status: 'active' }),
    ]);
    const { rollup } = await run();

    // Counting the shipped plan would dilute the population that enforcement reaches —
    // the exact number this ledger exists to state honestly.
    expect(rollup.byAdoption['no-behavior-declared']).toBe(1);
    expect(rollup.byLane).toMatchObject({ historical: 1, enforceable: 1 });
  });

  it('treats a draft plan as pre-enforcement, not enforceable (D-012)', async () => {
    const { run } = ledgerOver([plan({ planSlug: 'd', status: 'draft' })]);
    expect((await run()).rows[0].lane).toBe('pre-enforcement');
  });
});

describe('P-012 ledger — a failed census never shrinks the denominator', () => {
  it('keeps a plan whose census threw, and names it', async () => {
    const { run } = ledgerOver(
      [plan({ planSlug: 'ok', clauseCount: 1 }), plan({ planSlug: 'broken', clauseCount: 1 })],
      (slug) => (slug === 'broken' ? Promise.reject(new Error('census down')) : aggregate({ planSlug: slug })),
    );
    const { rows, rollup } = await run();

    // Dropping it would make the remaining coverage look better than it is.
    expect(rows).toHaveLength(2);
    const broken = rows.find((r) => r.planSlug === 'broken')!;
    expect(broken.coverage).toBeNull();
    expect(broken.coverageUnavailableReason).toContain('census down');
    expect(rollup.censusUnavailablePlanSlugs).toEqual(['broken']);
    expect(rollup.plansConsidered).toBe(2);
  });
});

describe('P-012 ledger — boundedness has TWO axes and they compose', () => {
  it('AXIS 1: a truncated plan population makes every count a floor', async () => {
    const { run } = ledgerOver([
      plan({ planSlug: 'a' }),
      plan({ planSlug: 'b' }),
      plan({ planSlug: 'c' }),
    ]);
    const { rollup } = await run(2);

    expect(rollup.bounded.truncatedByPlanLimit).toBe(true);
    expect(rollup.bounded.plansRead).toBe(2);
    expect(rollup.bounded.countsAreFloor).toBe(true);
  });

  it('a population that exactly fills the limit is NOT truncated (the boundary case)', async () => {
    const { run } = ledgerOver([plan({ planSlug: 'a' }), plan({ planSlug: 'b' })]);
    const { rollup } = await run(2);

    // Observed via a limit+1 probe rather than inferred from a full page, which is
    // otherwise ambiguous at exactly `limit`.
    expect(rollup.bounded.truncatedByPlanLimit).toBe(false);
    expect(rollup.bounded.countsAreFloor).toBe(false);
  });

  it('AXIS 2: a truncated per-plan census makes every count a floor', async () => {
    const { run } = ledgerOver([plan({ planSlug: 'big', clauseCount: 1 })], (slug) =>
      aggregate({
        planSlug: slug,
        bounded: {
          evidenceCensusLimit: 2000,
          evidenceRowsRead: 2000,
          truncatedByLimit: true,
          adequacyClauseLimit: 200,
          adequacyTruncatedByLimit: false,
        },
      }),
    );
    const { rollup } = await run();

    expect(rollup.bounded.anyCensusTruncated).toBe(true);
    expect(rollup.bounded.censusTruncatedPlanSlugs).toEqual(['big']);
    // Axis 1 is clean here — which is precisely why countsAreFloor must not be axis 1 alone.
    expect(rollup.bounded.truncatedByPlanLimit).toBe(false);
    expect(rollup.bounded.countsAreFloor).toBe(true);
  });
});

describe('P-012 ledger — census-derived actions', () => {
  it('names stale proof first, and carries the specIds that make it actionable', async () => {
    const { run } = ledgerOver([plan({ planSlug: 'p', clauseCount: 2 })], (slug) =>
      aggregate({
        planSlug: slug,
        coverage: {
          proven: 0,
          staleProof: 1,
          unproven: 1,
          staleProofClauses: [
            { specId: 'SPEC-a', planItemId: 'P-001', currentRevision: 4, provenRevisions: [2] },
          ],
          unprovenSpecIds: ['SPEC-b'],
        },
      }),
    );
    const { rows } = await run();
    const kinds = rows[0].actions.map((a) => a.kind);

    // Stale proof is the ONE thing the ship gate actually refuses on (D-018) — first.
    expect(kinds[0]).toBe('prove-at-current-revision');
    expect(kinds).toContain('bind-evidence');
    expect(rows[0].actions[0].specIds).toEqual(['SPEC-a']);
  });

  it('REPORTS an undeclared falsifier without inventing one (D-016)', async () => {
    const { run } = ledgerOver([plan({ planSlug: 'p', clauseCount: 2 })], (slug) =>
      aggregate({
        planSlug: slug,
        clauses: {
          total: 2,
          enforceable: 2,
          exempt: 0,
          draft: 0,
          inactive: 0,
          falsifierDeclared: 0,
        },
      }),
    );
    const { rows } = await run();
    const action = rows[0].actions.find((a) => a.kind === 'declare-falsifier')!;

    expect(action).toBeDefined();
    expect(action.detail).toContain('2 of 2');
    // The action must describe the gap, never supply a value that would close it.
    expect(action).not.toHaveProperty('falsifier');
    expect(action.detail.toLowerCase()).toContain('never synthesize');
  });

  it('emits NO actions for a censused plan that is genuinely clean', async () => {
    const { run } = ledgerOver([plan({ planSlug: 'p', clauseCount: 2 })]);
    const { rows } = await run();

    // An empty action list is reserved for this case, so "no actions" can never be
    // produced by absence of input.
    expect(rows[0].actions).toEqual([]);
    expect(rows[0].adoption).toBe('adopted');
  });
});

describe('permanent negative control — one-axis boundedness checking reads a floor as a total', () => {
  /** A consumer that checks only the obvious axis, i.e. the regression this composes against. */
  const oneAxisConsumer = (rollup: { bounded: { truncatedByPlanLimit: boolean } }) =>
    rollup.bounded.truncatedByPlanLimit ? 'floor' : 'total';

  it('misses a census-truncated rollup that countsAreFloor catches', async () => {
    const { run } = ledgerOver([plan({ planSlug: 'big', clauseCount: 1 })], (slug) =>
      aggregate({
        planSlug: slug,
        bounded: {
          evidenceCensusLimit: 2000,
          evidenceRowsRead: 2000,
          truncatedByLimit: true,
          adequacyClauseLimit: 200,
          adequacyTruncatedByLimit: false,
        },
      }),
    );
    const { rollup } = await run();

    expect(oneAxisConsumer(rollup)).toBe('total'); // ...and it is WRONG.
    expect(rollup.bounded.countsAreFloor).toBe(true);
  });
});
