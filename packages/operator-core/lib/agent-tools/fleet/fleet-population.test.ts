import { describe, expect, it } from 'vitest';
import {
  selectFleetPopulation,
  withShownCount,
  renderPopulationCensus,
  type FleetPopulationCensus,
} from './fleet-population';

/**
 * P-010 (fleet-lead-instrumentation-audit-2026-08-09) — measured on fleet
 * `nonp2p-bug-drain`: within a few minutes the same fleet read as 11 members
 * (leader-brief summary), 11 and 14 rows (leader-brief members[], the second with
 * include_stale), then 8 and 9 agents (fleet:assignments). Every number correct,
 * none reconciled inline. The property under test is that a count can no longer
 * be published without saying what it counted and what it withheld.
 */
const META = {
  population: 'member(s)',
  basis: 'shown if it holds a claim or is alive',
  withheldReason: 'idle AND not heartbeat-fresh (stale-idle)',
  reveal: 'include_stale: true',
};

const rows = [
  { id: 'a', live: true },
  { id: 'b', live: true },
  { id: 'c', live: false },
  { id: 'd', live: false },
];

describe('selectFleetPopulation', () => {
  it('derives rows and census from ONE pass, so the numbers cannot disagree with the payload', () => {
    const { rows: kept, census } = selectFleetPopulation(rows, (r) => r.live, META);
    expect(kept.map((r) => r.id)).toEqual(['a', 'b']);
    expect(census.counted).toBe(kept.length);
    expect(census.candidates).toBe(4);
    expect(census.withheld).toBe(2);
    expect(census.withheldReason).toContain('stale-idle');
    expect(census.reveal).toBe('include_stale: true');
  });

  it('reports withheld:0 with NO reason attached when the filter hid nothing', () => {
    const { census } = selectFleetPopulation(rows, () => true, META);
    expect(census.counted).toBe(4);
    expect(census.withheld).toBe(0);
    // A reason parked on zero rows reads as an admission that something is hidden,
    // and teaches readers to discount the field on the calls where it is real.
    expect(census.withheldReason).toBeNull();
    expect(census.reveal).toBeNull();
  });

  it('handles the empty roster without inventing a population', () => {
    const { rows: kept, census } = selectFleetPopulation([], (r: { live: boolean }) => r.live, META);
    expect(kept).toEqual([]);
    expect(census).toMatchObject({ candidates: 0, counted: 0, withheld: 0, withheldReason: null });
  });

  // CONTROL (falsifiability, per the repo's guard-testing rule): the whole point
  // is that the census is COMPUTED, not asserted. A hand-maintained census — the
  // arrangement this replaces — passes a count that no longer matches its filter;
  // the real one cannot. If this control ever stops discriminating, the tests
  // above have gone vacuous.
  it('CONTROL: a hand-written census can drift from its own filter; this one cannot', () => {
    const handWritten: FleetPopulationCensus = {
      population: 'member(s)',
      basis: 'shown if alive',
      candidates: 4,
      counted: 4, // stale label: written when the filter was a no-op
      withheld: 0,
      withheldReason: null,
      reveal: null,
    };
    const actuallyKept = rows.filter((r) => r.live);
    expect(handWritten.counted).not.toBe(actuallyKept.length);

    const { rows: kept, census } = selectFleetPopulation(rows, (r) => r.live, META);
    expect(census.counted).toBe(kept.length);
  });
});

describe('withShownCount', () => {
  const base = selectFleetPopulation(rows, () => true, META).census;

  it('records a transport truncation as a SECOND, separately-named reduction', () => {
    const out = withShownCount(base, 2, 'trimmed to the byte budget');
    expect(out.shown).toBe(2);
    expect(out.shownReason).toBe('trimmed to the byte budget');
    // The filter's verdict is untouched — the two reductions answer different
    // questions and collapsing them re-creates the ambiguity this item is about.
    expect(out.counted).toBe(4);
    expect(out.withheld).toBe(0);
  });

  it('is a NO-OP when nothing was actually trimmed — announcing a truncation of zero rows is noise', () => {
    expect(withShownCount(base, 4, 'trimmed')).toBe(base);
    expect(withShownCount(base, 9, 'trimmed')).toBe(base);
    expect(withShownCount(base, Number.NaN, 'trimmed')).toBe(base);
  });
});

describe('renderPopulationCensus', () => {
  it('reads as the reconciliation sentence a leader otherwise assembles by hand', () => {
    const census = withShownCount(
      selectFleetPopulation(rows, (r) => r.live, META).census,
      1,
      'trimmed to the byte budget',
    );
    const line = renderPopulationCensus(census);
    expect(line).toContain('2 member(s) (of 4 on the roster)');
    expect(line).toContain('2 withheld');
    expect(line).toContain('include_stale: true');
    expect(line).toContain('only 1 shown');
  });

  it('says nothing about withholding or truncation when neither happened', () => {
    const line = renderPopulationCensus(selectFleetPopulation(rows, () => true, META).census);
    expect(line).toContain('4 member(s) (of 4 on the roster)');
    expect(line).not.toContain('withheld');
    expect(line).not.toContain('shown in this payload');
  });
});
