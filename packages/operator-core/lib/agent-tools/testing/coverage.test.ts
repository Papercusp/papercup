/**
 * testing:coverage — the read surface for the census
 * (deterministic-coverage-census-2026-08-17 P-005).
 *
 * WHAT THESE TESTS ARE FOR. This tool's whole job is to stop one misread: a coverage
 * ratio over an empty or weak census being read as a real number. The arithmetic is
 * trivial; the HONESTY is the feature. So these tests are aimed at the honesty
 * properties, not at whether 3/4 is 75.
 *
 * They run against the real exported `assembleCoverage`, not a mocked `sql` — the tool
 * is deliberately split so the guarantees are asserted against the function that
 * actually produces them. A guarantee testable only through a mock is one the mock can
 * be wrong about.
 */

import { describe, it, expect } from 'vitest';
import {
  assembleCoverage,
  assessTestingCensusPopulation,
  assessTestingCoverageFloor,
  aggregate,
  emptyFidelityCounts,
  fidelityMarker,
  pct,
  AGGREGATE_BASIS,
  FIDELITY_ORDER,
  RUNGS,
  type CoverageRawInput,
} from './coverage';

const SCOPE = { workspace: 'ws', harness: 'papercusp' };

function counts(over: Partial<Record<(typeof FIDELITY_ORDER)[number], number>>) {
  return { ...emptyFidelityCounts(), ...over };
}

/** A census with `surfaces` rows, all `declared`, none meeting any rung unless said. */
function input(over: Partial<CoverageRawInput> = {}): CoverageRawInput {
  return {
    scope: SCOPE,
    rung: 'l1',
    totals: {
      surfaces: 0,
      retired: 0,
      waived: 0,
      last_census_at: null,
      meets_l1: 0,
      meets_l2: 0,
      meets_l3: 0,
      meets_l4: 0,
      meets_floor: 0,
      evidenced: 0,
      // below_unwaived_* mirrors the SQL: count(NOT meets_lN AND NOT waived) over the
      // whole population — i.e. `surfaces - meets_lN - waived` while waived ∩ meets = ∅.
      below_unwaived_l1: 0,
      below_unwaived_l2: 0,
      below_unwaived_l3: 0,
      below_unwaived_l4: 0,
      below_unwaived_floor: 0,
    },
    fidelityRows: [],
    byKindRows: [],
    registrations: { registered: 0, enabled: 0 },
    rows: [],
    rowTotal: 0,
    ...over,
  };
}

/**
 * Walk every AGGREGATE node in a response. Structural rather than a hardcoded list, so
 * a new aggregate added later is covered the day it appears — the marker requirement is
 * about the CLASS of thing, and a test that enumerates today's three would silently stop
 * covering tomorrow's fourth.
 */
function everyAggregate(result: ReturnType<typeof assembleCoverage>): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [
    ['census', result.census],
    ['coverage', result.coverage],
  ];
  for (const [rung, agg] of Object.entries(result.coverage.byRung)) out.push([`coverage.byRung.${rung}`, agg]);
  for (const k of result.byKind) out.push([`byKind.${k.kind}`, k]);
  return out;
}

describe('testing assessment truth tables', () => {
  it.each([
    [{ surfaces: 0, providersRegistered: 0, lastCensusAt: null }, 'no-providers'],
    [{ surfaces: 0, providersRegistered: 1, lastCensusAt: null }, 'census-not-run'],
    [{ surfaces: 0, providersRegistered: 1, lastCensusAt: '2026-08-18T00:00:00.000Z' }, 'empty-measured'],
    [{ surfaces: 1, providersRegistered: 0, lastCensusAt: null }, 'populated'],
  ] as const)('population %j → %s', (facts, expected) => {
    expect(assessTestingCensusPopulation(facts)).toBe(expected);
  });

  it.each([
    // ⚠ The CODE is `no-population` while the sibling VERDICT field stays `not-measured`
    // (D-012): the verdict is not an assessment code, so only the code had to move off the
    // CellUnknownCode vocabulary. Both rows below are the empty-population case reached by
    // its two different routes, and both must yield the same code.
    [{ verdict: 'not-measured', surfaces: 0, below: 0, belowUnwaived: 0, evidenced: 0 }, 'no-population'],
    [{ verdict: 'measured', surfaces: 0, below: 0, belowUnwaived: 0, evidenced: 0 }, 'no-population'],
    [{ verdict: 'measured', surfaces: 10, below: 2, belowUnwaived: 2, evidenced: 10 }, 'below-floor'],
    [{ verdict: 'measured', surfaces: 10, below: 2, belowUnwaived: 0, evidenced: 10 }, 'measured-with-waivers'],
    [{ verdict: 'measured', surfaces: 10, below: 0, belowUnwaived: 0, evidenced: 10 }, 'meets-floor'],

    // P-008. The pair the `evidenced` dimension exists to separate: IDENTICAL ratio
    // inputs, opposite meanings. The first is a gap queue worth working; the second is
    // the state measured 2026-09-02 across all 2,017 live surfaces, where the queue was
    // the same size and none of it was work.
    [{ verdict: 'measured', surfaces: 10, below: 10, belowUnwaived: 10, evidenced: 1 }, 'below-floor'],
    [{ verdict: 'measured', surfaces: 10, below: 10, belowUnwaived: 10, evidenced: 0 }, 'no-evidence'],

    // A missing numerator may make a shortfall unattributable; it must NEVER turn a
    // passing floor into a failing one. Both of these read `evidenced: 0` and neither
    // is allowed to become `no-evidence`.
    [{ verdict: 'measured', surfaces: 10, below: 0, belowUnwaived: 0, evidenced: 0 }, 'meets-floor'],
    [
      { verdict: 'measured', surfaces: 10, below: 2, belowUnwaived: 0, evidenced: 0 },
      'measured-with-waivers',
    ],
  ] as const)('coverage %j → %s', (facts, expected) => {
    expect(assessTestingCoverageFloor(facts)).toBe(expected);
  });

  it('emits both codes from the same aggregate payload', () => {
    const r = assembleCoverage(input());
    expect(r.assessments).toEqual({
      censusPopulation: 'no-providers',
      coverageFloor: 'no-population',
    });
  });
});

describe('the vacuous-ratio guard — an empty census is NOT-MEASURED, never 0% and never 100%', () => {
  it('reports verdict "not-measured" and a NULL pct when there are no surfaces', () => {
    const r = assembleCoverage(input());

    expect(r.verdict).toBe('not-measured');
    // The load-bearing assertion of this entire file. `toBeNull` rather than `toBe(0)`:
    // 0 would be a claim that nothing is covered, which is a measurement nobody made.
    expect(r.coverage.pct).toBeNull();
    expect(r.coverage.below).toBe(0);
    expect(r.coverage.meets).toBe(0);
  });

  it('nulls the pct on EVERY rung, not just the requested floor', () => {
    // The floor is one aggregate among five; a guard applied only at the top would leave
    // four numbers a caller could still read as a measurement.
    const r = assembleCoverage(input());
    for (const rung of Object.keys(RUNGS)) {
      expect(r.coverage.byRung[rung as keyof typeof RUNGS].pct).toBeNull();
    }
  });

  it('hoists WHY at the result level, naming no-providers-registered — the WI-39809 state', () => {
    const r = assembleCoverage(input({ registrations: { registered: 0, enabled: 0 } }));

    expect(r.censusUnknown).not.toBeNull();
    expect(r.censusUnknown!.join(' ')).toContain('no-providers-registered');
    // Result-level, not buried per-row: a hurried caller must trip over it.
    expect(Array.isArray(r.censusUnknown)).toBe(true);
  });

  it('distinguishes "providers registered but the census never ran" from "no providers"', () => {
    // Two different repairs — seed registrations vs. find out why the cadence writes
    // nothing — so collapsing them into one message would send the reader to the wrong one.
    const r = assembleCoverage(input({ registrations: { registered: 3, enabled: 3 } }));

    expect(r.censusUnknown!.join(' ')).toContain('census-has-not-run');
    expect(r.censusUnknown!.join(' ')).not.toContain('no-providers-registered');
  });

  it('distinguishes "the filters matched nothing" from "the census is empty"', () => {
    const r = assembleCoverage(
      input({
        registrations: { registered: 3, enabled: 3 },
        totals: { ...input().totals!, last_census_at: '2026-08-18T13:50:25.828Z' },
      }),
    );

    expect(r.censusUnknown!.join(' ')).toContain('no-surfaces-match-filters');
  });

  it('goes quiet the moment there IS a denominator — the hoist must not become noise', () => {
    const r = assembleCoverage(
      input({
        totals: { ...input().totals!, surfaces: 4, meets_floor: 3, last_census_at: '2026-08-18T13:50:25.828Z' },
        registrations: { registered: 3, enabled: 3 },
      }),
    );

    expect(r.verdict).toBe('measured');
    expect(r.censusUnknown).toBeNull();
    expect(r.coverage.pct).toBe(75);
  });

  it('reports a GENUINE zero as 0, not as not-measured', () => {
    // The mirror image, and the reason the guard keys on the DENOMINATOR rather than on
    // the numerator: a census that found 10 surfaces and proved none of them is a real,
    // hard-won 0% — suppressing that would hide the exact finding the census exists for.
    const r = assembleCoverage(
      input({
        totals: { ...input().totals!, surfaces: 10, meets_floor: 0, last_census_at: '2026-08-18T13:50:25.828Z' },
        registrations: { registered: 3, enabled: 3 },
      }),
    );

    expect(r.verdict).toBe('measured');
    expect(r.coverage.pct).toBe(0);
    expect(r.censusUnknown).toBeNull();
  });
});

describe('markers ride EVERY aggregate (the P-005 acceptance requirement)', () => {
  const populated = assembleCoverage(
    input({
      totals: {
        surfaces: 100,
        retired: 2,
        waived: 1,
        last_census_at: '2026-08-18T13:50:25.828Z',
        meets_l1: 40,
        meets_l2: 10,
        meets_l3: 30,
        meets_l4: 5,
        meets_floor: 40,
        // Rungs are met here, so the apparatus plainly reached this population — the
        // ratio cases below are about the ratio, not about a missing numerator (P-008).
        evidenced: 100,
        // 100 surfaces, 1 waived: below_unwaived_lN = 100 - meets_lN - 1.
        below_unwaived_l1: 59,
        below_unwaived_l2: 89,
        below_unwaived_l3: 69,
        below_unwaived_l4: 94,
        below_unwaived_floor: 59,
      },
      fidelityRows: [
        { fidelity: 'declared', n: 90 },
        { fidelity: 'file-only', n: 10 },
      ],
      byKindRows: [
        // below_unwaived = n - meets - waived, per kind+fidelity row.
        { kind: 'http-route', fidelity: 'declared', n: 80, meets: 30, waived: 1, below_unwaived: 49 },
        { kind: 'mcp-tool', fidelity: 'file-only', n: 10, meets: 5, waived: 0, below_unwaived: 5 },
        { kind: 'mcp-tool', fidelity: 'declared', n: 10, meets: 5, waived: 0, below_unwaived: 5 },
      ],
      registrations: { registered: 3, enabled: 3 },
    }),
  );

  it('gives every aggregate BOTH a fidelity marker and a basis', () => {
    const nodes = everyAggregate(populated);
    expect(nodes.length).toBeGreaterThanOrEqual(7); // census + coverage + 4 rungs + 2 kinds

    for (const [path, node] of nodes) {
      const n = node as { fidelity?: unknown; basis?: unknown };
      expect(n.fidelity, `${path} is missing its fidelity marker`).toBeDefined();
      expect(n.basis, `${path} is missing its basis marker`).toBeDefined();
    }
  });

  it('states boundedness rather than leaving it implied', () => {
    for (const [path, node] of everyAggregate(populated)) {
      const basis = (node as { basis: typeof AGGREGATE_BASIS }).basis;
      expect(basis.boundedByLimit, `${path} must declare it is not limit-bounded`).toBe(false);
      expect(basis.limitAppliesTo).toBe('rows');
    }
  });

  it('carries the WEAKEST fidelity present, not the strongest', () => {
    // The ceiling on what a number means is set by the flimsiest row in the population.
    // Reporting the strongest would flatter exactly the census that most needs a caveat.
    expect(populated.census.fidelity.weakest).toBe('file-only');
    expect(populated.census.fidelity.declaredPct).toBe(90);
  });

  it('scopes each per-kind marker to THAT kind, not to the whole census', () => {
    const http = populated.byKind.find((k) => k.kind === 'http-route')!;
    const mcp = populated.byKind.find((k) => k.kind === 'mcp-tool')!;

    // A global marker copied onto every kind would report http-route as file-only-tainted
    // when all 80 of its rows are declared — a caveat in the wrong place is a false alarm,
    // and a reader who learns the caveat is always there stops reading it.
    expect(http.fidelity.weakest).toBe('declared');
    expect(http.fidelity.declaredPct).toBe(100);
    expect(mcp.fidelity.weakest).toBe('file-only');
    expect(mcp.fidelity.declaredPct).toBe(50);
  });
});

describe('the aggregates do not move with `limit` — behavioural, not by field name', () => {
  // CLAUDE.md's rule is that a caller's limit bounds ROW LISTS ONLY, and an aggregate
  // computed over a capped fetch must say so ON the aggregate. Asserting the presence of
  // a field named `truncatedByLimit` would pass just as well against a tool whose counts
  // silently shrank with the page size, so the property is exercised instead: same census,
  // two different row pages, identical aggregates.
  const totals = {
    surfaces: 500,
    retired: 0,
    waived: 0,
    last_census_at: '2026-08-18T13:50:25.828Z',
    meets_l1: 200,
    meets_l2: 0,
    meets_l3: 0,
    meets_l4: 0,
    meets_floor: 200,
    // Rungs are met here, so the apparatus reached this population (P-008).
    evidenced: 500,
    // 500 surfaces, 0 waived: below_unwaived_lN = 500 - meets_lN.
    below_unwaived_l1: 300,
    below_unwaived_l2: 500,
    below_unwaived_l3: 500,
    below_unwaived_l4: 500,
    below_unwaived_floor: 300,
  };
  const fidelityRows = [{ fidelity: 'declared', n: 500 }];
  const registrations = { registered: 3, enabled: 3 };

  const row = (id: string) => ({
    kind: 'http-route',
    surface_id: id,
    source_file: 'apps/x.ts',
    provider: 'hono-routes',
    fidelity: 'declared',
    depth: 0,
    meets_l1: false,
    meets_l2: false,
    meets_l3: false,
    meets_l4: false,
    mutation_score: null,
    authored_evidence: 0,
    last_evidence_at: null,
    first_seen: '2026-08-18T13:50:25.828Z',
    retired_at: null,
    waived: false,
  });

  const small = assembleCoverage(input({ totals, fidelityRows, registrations, rows: [row('a')], rowTotal: 500 }));
  const large = assembleCoverage(
    input({ totals, fidelityRows, registrations, rows: [row('a'), row('b'), row('c')], rowTotal: 500 }),
  );

  it('reports the same coverage regardless of how many rows came back', () => {
    expect(small.coverage.pct).toBe(40);
    expect(large.coverage.pct).toBe(40);
    expect(small.coverage.surfaces).toBe(large.coverage.surfaces);
    expect(small.census.surfaces).toBe(500);
  });

  it('reports the aggregate over the population, not over the page', () => {
    // The specific wrong answer this rules out: 1 row back, 0 of them meeting the floor,
    // reported as 0%.
    expect(small.coverage.meets).toBe(200);
    expect(small.rows.length).toBe(1);
  });

  it('marks the ROW LIST as truncated, since that is the thing the limit bounded', () => {
    expect(small.truncatedByLimit).toBe(true);
    expect(small.total).toBe(500);
    expect(small.count).toBe(1);
  });

  it('does not claim truncation when the page holds everything', () => {
    const whole = assembleCoverage(input({ totals, fidelityRows, registrations, rows: [row('a')], rowTotal: 1 }));
    expect(whole.truncatedByLimit).toBe(false);
  });
});

describe('rungs are judged by their FLAG, never by depth >= N', () => {
  it("maps each rung to the view's own boolean column", () => {
    // The view's comment is explicit that the rungs are not nested — an intent-tested
    // surface the fuzzer never ran against is L3 with no L2 — so `depth >= 2` would ask a
    // question the data cannot answer. This pins the mapping the SQL interpolates.
    expect(RUNGS.l1.column).toBe('meets_l1');
    expect(RUNGS.l2.column).toBe('meets_l2');
    expect(RUNGS.l3.column).toBe('meets_l3');
    expect(RUNGS.l4.column).toBe('meets_l4');
  });

  it('reports a non-nested ladder faithfully instead of monotonically', () => {
    // 30 surfaces are L3 while only 10 are L2. A depth>=N reading would have to report L3
    // <= L2 and would silently under-report the intent-tested population.
    const r = assembleCoverage(
      input({
        totals: {
          surfaces: 100,
          retired: 0,
          waived: 0,
          last_census_at: '2026-08-18T13:50:25.828Z',
          meets_l1: 40,
          meets_l2: 10,
          meets_l3: 30,
          meets_l4: 5,
          meets_floor: 40,
          // Rungs are met here, so the apparatus reached this population (P-008).
          evidenced: 100,
          // 100 surfaces, 0 waived: below_unwaived_lN = 100 - meets_lN.
          below_unwaived_l1: 60,
          below_unwaived_l2: 90,
          below_unwaived_l3: 70,
          below_unwaived_l4: 95,
          below_unwaived_floor: 60,
        },
        fidelityRows: [{ fidelity: 'declared', n: 100 }],
        registrations: { registered: 3, enabled: 3 },
      }),
    );

    expect(r.coverage.byRung.l2.meets).toBe(10);
    expect(r.coverage.byRung.l3.meets).toBe(30);
    expect(r.coverage.byRung.l3.pct).toBe(30);
  });

  it('honours the requested floor in the headline aggregate', () => {
    const base = {
      totals: {
        surfaces: 100,
        retired: 0,
        waived: 0,
        last_census_at: '2026-08-18T13:50:25.828Z',
        meets_l1: 40,
        meets_l2: 10,
        meets_l3: 30,
        meets_l4: 5,
        // The SQL computes meets_floor with the requested rung's column; mirrored here.
        meets_floor: 30,
        // Rungs are met here, so the apparatus reached this population (P-008).
        evidenced: 100,
        // 100 surfaces, 0 waived: below_unwaived_lN = 100 - meets_lN. The floor is l3
        // here, so below_unwaived_floor tracks below_unwaived_l3, not l1.
        below_unwaived_l1: 60,
        below_unwaived_l2: 90,
        below_unwaived_l3: 70,
        below_unwaived_l4: 95,
        below_unwaived_floor: 70,
      },
      fidelityRows: [{ fidelity: 'declared', n: 100 }],
      registrations: { registered: 3, enabled: 3 },
    };
    const r = assembleCoverage(input({ ...base, rung: 'l3' }));

    expect(r.coverage.floor).toBe('l3');
    expect(r.coverage.meets).toBe(30);
    expect(r.coverage.below).toBe(70);
  });
});

describe('the ratio primitive', () => {
  it('returns null rather than dividing by zero', () => {
    expect(pct(0, 0)).toBeNull();
    // NaN is the other wrong answer: it serialises to null in JSON and would look like a
    // deliberate unknown while actually being an arithmetic accident.
    expect(pct(0, 0)).not.toBeNaN();
  });

  it('rounds to one decimal', () => {
    expect(pct(1, 3)).toBe(33.3);
    expect(pct(2, 3)).toBe(66.7);
  });

  it('is exact at the boundaries', () => {
    expect(pct(0, 10)).toBe(0);
    expect(pct(10, 10)).toBe(100);
  });
});

describe('fidelityMarker', () => {
  it('has no weakest and no declaredPct over an empty population', () => {
    const m = fidelityMarker(emptyFidelityCounts(), 0);
    expect(m.weakest).toBeNull();
    expect(m.declaredPct).toBeNull();
  });

  it('picks the weakest present even when it is a single row', () => {
    // One file-only row among 999 declared still caps what the number means, so a
    // majority-weighted answer would be the wrong one.
    const m = fidelityMarker(counts({ declared: 999, observed: 1 }), 1000);
    expect(m.weakest).toBe('observed');
  });

  it('orders strength declared > spec > convention > observed > file-only', () => {
    expect(FIDELITY_ORDER).toEqual(['declared', 'spec', 'convention', 'observed', 'file-only']);
  });
});

describe('aggregate()', () => {
  it('derives below as surfaces - meets', () => {
    const a = aggregate({
      surfaces: 10,
      meets: 4,
      waived: 0,
      belowUnwaived: 6,
      fidelityCounts: counts({ declared: 10 }),
    });
    expect(a.below).toBe(6);
    expect(a.pct).toBe(40);
  });

  it('shares one frozen basis object rather than re-stating the claim per aggregate', () => {
    const a = aggregate({
      surfaces: 1,
      meets: 1,
      waived: 0,
      belowUnwaived: 0,
      fidelityCounts: counts({ declared: 1 }),
    });
    expect(a.basis).toBe(AGGREGATE_BASIS);
    expect(Object.isFrozen(a.basis)).toBe(true);
  });
});
