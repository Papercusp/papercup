import { describe, expect, it } from 'vitest';
import {
  selectFleetPopulation,
  withShownCount,
  withLivenessComposition,
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

/**
 * EI-21550192883916303 — the SECOND way a headcount misleads.
 *
 * Reproduces the measured shape: fleet `nonp2p-bug-drain`, 2026-08-26. 415
 * processes carried the fleet's slug and were reported to the owner as "415
 * members saturating the MCP proxy". 411 were parked; zero were in a running
 * state. Saying which population was counted (the tests above) would not have
 * caught it — every one of the 415 genuinely was a member. What was missing is
 * what they were DOING.
 */
describe('liveness composition', () => {
  /** 4 live + 411 parked = the 415 that got reported as active. */
  const fleet415 = [
    ...Array.from({ length: 4 }, (_, i) => ({ id: `live-${i}`, alive: true, state: 'live' as const })),
    ...Array.from({ length: 411 }, (_, i) => ({
      id: `parked-${i}`,
      // THE TRAP, in the data: heartbeat-fresh (so the filter keeps them) while
      // the oracle says they are not taking turns. `alive` and
      // `sessionState:'live'` are different facts, which is why the filter that
      // produces the count cannot answer what the count gets read for.
      alive: true,
      state: 'parked' as const,
    })),
  ];

  it('splits the counted rows by sessionState instead of publishing one total', () => {
    const { census } = selectFleetPopulation(fleet415, (r) => r.alive, META, (r) => r.state);
    expect(census.counted).toBe(415);
    expect(census.withheld).toBe(0); // the P-010 census alone reports a clean 415
    expect(census.liveness?.byState).toEqual({ live: 4, parked: 411 });
    expect(census.liveness?.live).toBe(4);
    expect(census.liveness?.overstatesActivity).toBe(true);
  });

  /**
   * The DELIVERY property. renderPopulationCensus has no callers — the census
   * ships to agents as JSON on `summary.population` — so a caveat that exists
   * only in the rendered sentence reaches nobody, and `overstatesActivity: true`
   * alone still assumes the reader knows what it means. If this fails, the fix
   * is decorative.
   */
  it('carries the caveat IN THE PAYLOAD, not only in the unrendered sentence', () => {
    const { census } = selectFleetPopulation(fleet415, (r) => r.alive, META, (r) => r.state);
    expect(census.liveness?.note).toBeDefined();
    expect(census.liveness?.note).toContain('only 4 of 415 are live');
    expect(census.liveness?.note).toContain('not an activity measure');
    // It must survive JSON serialization — that is the only form agents see.
    const roundTripped = JSON.parse(JSON.stringify(census)) as typeof census;
    expect(roundTripped.liveness?.note).toContain('not an activity measure');
  });

  it('omits the note when the population really is live — the caveat is not boilerplate', () => {
    const { census } = selectFleetPopulation(
      [
        { alive: true, state: 'live' as const },
        { alive: true, state: 'live' as const },
        { alive: true, state: 'parked' as const },
      ],
      (r) => r.alive,
      META,
      (r) => r.state,
    );
    expect(census.liveness?.note).toBeUndefined();
  });

  it('states in the rendered line that the count is NOT an activity measure', () => {
    const line = renderPopulationCensus(
      selectFleetPopulation(fleet415, (r) => r.alive, META, (r) => r.state).census,
    );
    expect(line).toContain('411 parked');
    expect(line).toContain('NOT measure activity');
    expect(line).toContain('1%');
  });

  /**
   * CONTROL (falsifiability): the assertions above must fail on the PRE-FIX
   * behaviour, not merely pass on the new one. A census built without a
   * resolver is exactly what both call sites published before this change.
   */
  it('CONTROL: the pre-fix census renders 415 with nothing contradicting "active"', () => {
    const preFix = selectFleetPopulation(fleet415, (r) => r.alive, META).census;
    expect(preFix.counted).toBe(415);
    expect(preFix.liveness).toBeUndefined();
    const line = renderPopulationCensus(preFix);
    expect(line).not.toContain('411 parked');
    // ...and the absence is now stated rather than reading as a clean bill of
    // health, which is the only honest thing to say when nobody asked.
    expect(line).toContain('liveness composition not resolved');
  });

  it('counts an unresolved verdict as unknown rather than assuming it is live', () => {
    const { census } = selectFleetPopulation(
      [
        { id: 'a', alive: true, state: 'live' as const },
        { id: 'b', alive: true, state: null },
      ],
      (r) => r.alive,
      META,
      (r) => r.state,
    );
    expect(census.liveness?.unknown).toBe(1);
    expect(census.liveness?.live).toBe(1);
    // 1 of 2 live is not a majority-live population, so the caveat stands: an
    // unknown row must never be silently credited to the live column.
    expect(census.liveness?.overstatesActivity).toBe(true);
  });

  /**
   * Pins the boundary decision. `live * 2 < counted` would leave a
   * half-parked population uncaveated even though the total overstates activity
   * twofold — so the rule is "live is not a MAJORITY", and this case is the one
   * that discriminates the two formulas.
   */
  it('flags a population that is exactly half live — half still overstates twofold', () => {
    const half = [
      { alive: true, state: 'live' as const },
      { alive: true, state: 'live' as const },
      { alive: true, state: 'parked' as const },
      { alive: true, state: 'parked' as const },
    ];
    const { census } = selectFleetPopulation(half, (r) => r.alive, META, (r) => r.state);
    expect(census.liveness?.liveShare).toBe(0.5);
    expect(census.liveness?.overstatesActivity).toBe(true);
    expect(renderPopulationCensus(census)).toContain('NOT measure activity');
  });

  it('stays quiet when the population really is live — the caveat must not be boilerplate', () => {
    const allLive = [
      { id: 'a', alive: true, state: 'live' as const },
      { id: 'b', alive: true, state: 'live' as const },
      { id: 'c', alive: true, state: 'parked' as const },
    ];
    const { census } = selectFleetPopulation(allLive, (r) => r.alive, META, (r) => r.state);
    expect(census.liveness?.overstatesActivity).toBe(false);
    const line = renderPopulationCensus(census);
    expect(line).toContain('2 live, 1 parked');
    expect(line).not.toContain('NOT measure activity');
  });

  it('reports no composition for an empty population rather than a 0% caveat', () => {
    const { census } = selectFleetPopulation(
      [] as { alive: boolean; state: 'live' }[],
      (r) => r.alive,
      META,
      (r) => r.state,
    );
    expect(census.liveness?.overstatesActivity).toBe(false);
    expect(census.liveness?.liveShare).toBe(0);
    expect(renderPopulationCensus(census)).not.toContain('NOT measure activity');
  });
});

describe('withLivenessComposition', () => {
  it('attaches the composition when rows learn their verdict AFTER the filter ran', () => {
    // The fleet:assignments path: `sessionState` is stamped by
    // decorateMemberVerdicts, which runs after selectFleetPopulation.
    const base = selectFleetPopulation(rows, (r) => r.live, META).census;
    expect(base.liveness).toBeUndefined();
    const decorated = [
      { id: 'a', sessionState: 'live' as const },
      { id: 'b', sessionState: 'ended' as const },
    ];
    const out = withLivenessComposition(base, decorated, (r) => r.sessionState);
    expect(out.liveness?.byState).toEqual({ live: 1, ended: 1 });
    // The filter's verdict is untouched, exactly as withShownCount leaves it.
    expect(out.counted).toBe(base.counted);
    expect(out.withheld).toBe(base.withheld);
    expect(base.liveness).toBeUndefined();
  });

  it('composes cleanly with withShownCount in either order', () => {
    const base = selectFleetPopulation(rows, () => true, META).census;
    const decorated = rows.map((r) => ({ sessionState: r.live ? ('live' as const) : ('parked' as const) }));
    const a = withShownCount(withLivenessComposition(base, decorated, (r) => r.sessionState), 1, 'budget');
    const b = withLivenessComposition(withShownCount(base, 1, 'budget'), decorated, (r) => r.sessionState);
    expect(a).toEqual(b);
    expect(a.shown).toBe(1);
    expect(a.liveness?.byState).toEqual({ live: 2, parked: 2 });
  });
});
