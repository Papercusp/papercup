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

/**
 * ⚠ NO `as Aggregate` CAST HERE, DELIBERATELY, AND IT MUST NOT COME BACK.
 *
 * This helper used to end `} as Aggregate`, which made it compile no matter what the
 * real type required. That is not a style nit: when `PlanSpecCoverageAggregate` grew
 * its P-013 partitions, the cast let this fixture keep omitting them, so every test
 * below would have exercised the rollup against a shape production can never produce
 * — `byBehaviorClass: undefined` — and the summation would have been "verified" by
 * tests that never saw a partition at all. The cast converts a compile error that
 * names the missing field into a runtime shape mismatch nobody is looking for.
 *
 * Returning a plain typed literal means adding a required field to the aggregate
 * BREAKS THIS FILE loudly, which is exactly the reminder that the fixture has to
 * grow with it. Keep it that way.
 *
 * The default is also deliberately CONSISTENT rather than minimal: the partitions
 * below reconcile with the flat counts (3 total / 2 enforceable / 2 proven / 2
 * falsifiers). A fixture whose partition disagreed with its own totals would make
 * the reconciliation assertions pass or fail for reasons unrelated to the code.
 */
function aggregate(over: Partial<Aggregate> = {}): Aggregate {
  return {
    planSlug: 'p',
    clauses: { total: 3, enforceable: 2, exempt: 1, draft: 0, inactive: 0, falsifierDeclared: 2 },
    coverage: { proven: 2, staleProof: 0, unproven: 0, staleProofClauses: [], unprovenSpecIds: [] },
    adequacy: { graded: 2, ungraded: 0, ungradedSpecIds: [] },
    byBehaviorClass: {
      'happy-path': { total: 2, enforceable: 2, proven: 2, staleProof: 0, unproven: 0, falsifierDeclared: 2 },
      // The exempt clause: present in `total`, never enforceable. Keeps the fixture
      // honest about the one case where total and enforceable legitimately differ.
      boundary: { total: 1, enforceable: 0, proven: 0, staleProof: 0, unproven: 0, falsifierDeclared: 0 },
    },
    evidence: {
      byKind: { test: 5 },
      currentByKind: { test: 5 },
      staleness: {
        maxRevisionLag: 0,
        oldestCurrentProofAt: '2026-08-01T00:00:00.000Z',
        newestProofAt: '2026-08-02T00:00:00.000Z',
      },
    },
    bounded: {
      evidenceCensusLimit: 2000,
      evidenceRowsRead: 5,
      truncatedByLimit: false,
      adequacyClauseLimit: 200,
      adequacyTruncatedByLimit: false,
    },
    ...over,
  };
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

/**
 * P-013 instrumentation — GATE REASONS at census scope, and the corpus partitions.
 *
 * `byLane` and `byAdoption` between them already contain the information, and that is
 * precisely the problem this block exists to fix: getting the answer out of them
 * requires cross-multiplying two partitions and knowing which combination the gates
 * treat as enforcing. Every reader who does that arithmetic is a second implementation
 * of the eligibility rule, and the ledger has no way to notice when one of them drifts.
 */
describe('computeSpecReconciliationLedger — P-013 enforcement census', () => {
  it('counts, for the whole corpus, how many plans a clause gate can actually refuse for', async () => {
    const { run } = ledgerOver([
      // Enforceable + adopted ⇒ the ONLY combination that enforces.
      plan({ planSlug: 'adopted-active', status: 'active', clauseCount: 3 }),
      // Adopted clauses, but the plan has shipped: historical, never enforced.
      plan({ planSlug: 'shipped', status: 'shipped', clauseCount: 3 }),
      // A draft plan is a candidate, never enforceable until promotion (D-012).
      plan({ planSlug: 'draft', status: 'draft', clauseCount: 3 }),
      // Active, but nothing adopted — the silent-waiver population.
      plan({ planSlug: 'legacy', status: 'active', clauseCount: 0, legacyValSignal: true }),
      plan({ planSlug: 'silent', status: 'active', clauseCount: 0 }),
    ]);
    const { rollup } = await run();

    expect(rollup.byEnforcement.enforcing).toBe(1);
    expect(rollup.byEnforcement.notEnforcing).toEqual({
      historical: 1,
      'pre-enforcement': 1,
      // Both the legacy-VAL plan and the declares-nothing plan land here: neither has
      // reconciled, and collapsing them into "compliant" is the failure this ledger exists
      // to prevent.
      'not-yet-reconciled': 2,
    });
  });

  it('accounts for EVERY plan considered — the reason census cannot silently drop a term', async () => {
    const population = [
      plan({ planSlug: 'a', status: 'active', clauseCount: 2 }),
      plan({ planSlug: 'b', status: 'shipped', clauseCount: 2 }),
      plan({ planSlug: 'c', status: 'draft', clauseCount: 0 }),
      plan({ planSlug: 'd', status: 'active', clauseCount: 0 }),
    ];
    const { rollup } = await ledgerOver(population).run();

    // Unlike `byAdoption`, which deliberately excludes historical plans, this partition
    // spans the whole population — "enforcement does not reach these 1,290 plans" IS the
    // finding, and dropping the historical term would delete the largest part of it.
    const totalCounted =
      rollup.byEnforcement.enforcing +
      Object.values(rollup.byEnforcement.notEnforcing).reduce((a, b) => a + b, 0);
    expect(totalCounted).toBe(rollup.plansConsidered);
    expect(totalCounted).toBe(population.length);
  });

  it('reports each row’s eligibility from the same predicate the gates use, not a re-derivation', async () => {
    const { run } = ledgerOver([
      plan({ planSlug: 'adopted-active', status: 'active', clauseCount: 3 }),
      plan({ planSlug: 'silent', status: 'active', clauseCount: 0 }),
    ]);
    const { rows } = await run();

    const enforcing = rows.find((r) => r.planSlug === 'adopted-active');
    const silent = rows.find((r) => r.planSlug === 'silent');

    expect(enforcing?.eligibility).toEqual({ enforcing: true, lane: 'enforceable', adoption: 'adopted' });
    expect(silent?.eligibility).toEqual({
      enforcing: false,
      lane: 'enforceable',
      adoption: 'no-behavior-declared',
      reason: 'not-yet-reconciled',
    });

    // The row's own lane/adoption must be the SAME values the eligibility verdict was
    // built from. They were separately derived before P-013, which is exactly how a row
    // could describe an enforcement regime the gate was not running.
    for (const row of rows) {
      expect(row.lane).toBe(row.eligibility.lane);
      expect(row.adoption).toBe(row.eligibility.adoption);
    }
  });

  it('sums the behavior-class and evidence partitions across adopted plans', async () => {
    // Two adopted plans, each contributing the default fixture partition.
    const { run } = ledgerOver([
      plan({ planSlug: 'p1', status: 'active', clauseCount: 3 }),
      plan({ planSlug: 'p2', status: 'active', clauseCount: 3 }),
    ]);
    const { rollup } = await run();

    // Summed, not re-counted: two plans × the fixture's 2 happy-path enforceable clauses.
    expect(rollup.byBehaviorClass['happy-path']).toMatchObject({ total: 4, enforceable: 4, proven: 4 });
    expect(rollup.byBehaviorClass.boundary).toMatchObject({ total: 2, enforceable: 0 });
    expect(rollup.byBehaviorClass.concurrency).toBeUndefined();

    // The corpus partition must reconcile with the corpus flat totals, exactly as the
    // per-plan one does — a sum of reconciling parts that does not itself reconcile means
    // the fold dropped something.
    const sum = (field: 'total' | 'enforceable' | 'proven') =>
      Object.values(rollup.byBehaviorClass).reduce((n, s) => n + (s?.[field] ?? 0), 0);
    expect(sum('total')).toBe(rollup.clauses.total);
    expect(sum('enforceable')).toBe(rollup.clauses.enforceable);
    expect(sum('proven')).toBe(rollup.coverage.proven);

    expect(rollup.evidence.byKind).toEqual({ test: 10 });
    expect(rollup.evidence.currentByKind).toEqual({ test: 10 });
  });

  it('takes the WORST revision lag and the OLDEST current proof across the corpus', async () => {
    const { run } = ledgerOver(
      [
        plan({ planSlug: 'mild', status: 'active', clauseCount: 1 }),
        plan({ planSlug: 'severe', status: 'active', clauseCount: 1 }),
      ],
      (slug) =>
        aggregate({
          planSlug: slug,
          evidence: {
            byKind: { test: 1 },
            currentByKind: { test: 1 },
            staleness:
              slug === 'severe'
                ? {
                    maxRevisionLag: 11,
                    oldestCurrentProofAt: '2025-01-01T00:00:00.000Z',
                    newestProofAt: '2026-08-01T00:00:00.000Z',
                  }
                : {
                    maxRevisionLag: 1,
                    oldestCurrentProofAt: '2026-08-01T00:00:00.000Z',
                    newestProofAt: '2026-08-02T00:00:00.000Z',
                  },
          },
        }),
    );
    const { rollup } = await run();

    // A corpus-level staleness figure has to be the worst case, not an average: averaging
    // an eleven-revision gap against a healthy majority reports a comfortable number for a
    // corpus containing a clause whose proof no longer describes what it promises.
    expect(rollup.evidence.maxRevisionLag).toBe(11);
    expect(rollup.evidence.oldestCurrentProofAt).toBe('2025-01-01T00:00:00.000Z');
  });
});
