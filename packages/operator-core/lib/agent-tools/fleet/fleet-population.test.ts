import { describe, expect, it } from 'vitest';
import {
  buildFleetPopulationLifecycle,
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
  reveal:
    'coord:presence { owner: "<agentId>" } (targeted stale-row lookup; broad stale-roster reads are unsupported)',
};

const rows = [
  { id: 'a', live: true },
  { id: 'b', live: true },
  { id: 'c', live: false },
  { id: 'd', live: false },
];

describe('buildFleetPopulationLifecycle', () => {
  it('binds runnable, relevant, ever-member, target, and lifecycle counts to named populations', () => {
    const { currentRunnableRows, relevantRows, snapshot } = buildFleetPopulationLifecycle({
      fleet: 'fleet-a',
      candidates: [
        { agentId: 'live', alive: true, sessionState: 'live' as const, claims: [{}] },
        { agentId: 'parked', alive: true, sessionState: 'parked' as const, claims: [] },
        { agentId: 'dead', alive: false, sessionState: 'ended' as const, claims: [{}] },
        { agentId: 'stale', alive: false, sessionState: null, claims: [] },
      ],
      everMemberIds: ['historical', 'dead', 'live', 'live'],
      fleetStartedAtMs: Date.parse('2026-08-21T00:00:00.000Z'),
      observedAtMs: Date.parse('2026-08-21T01:00:00.000Z'),
      target: {
        enabled: true,
        target: 3,
        current: 2,
        shortfall: 1,
        underStrength: true,
        verdict: 'under-strength',
        basis: {
          kind: 'agent-origin-execution-attested',
          liveRosterMembers: 4,
          executingMembers: 2,
          transactionWorkerReadyMembers: 2,
        },
      },
    });

    expect(currentRunnableRows.map((row) => row.agentId)).toEqual(['live', 'parked']);
    expect(relevantRows.map((row) => row.agentId)).toEqual(['live', 'parked', 'dead']);
    expect(snapshot).toMatchObject({
      schemaVersion: 'fleet-population-lifecycle-v1',
      fleet: 'fleet-a',
      currentRunnableRoster: {
        census: { population: 'current-runnable-roster', candidates: 4, counted: 2, withheld: 2 },
        ownerIds: ['live', 'parked'],
      },
      relevantRoster: {
        census: { population: 'relevant-roster', candidates: 4, counted: 3, withheld: 1 },
        ownerIds: ['live', 'parked', 'dead'],
      },
      everMembers: { counted: 3, ownerIds: ['dead', 'historical', 'live'] },
      // P-019: `historical` was a member and has NO roster row at all — the loss no
      // present-state read can return. `dead` is NOT counted: it is still on the
      // roster carrying an ended verdict, so `liveness.dead` already reports it.
      membersLost: { available: true, count: 1, ownerIds: ['historical'] },
      target: {
        current: 2,
        verdict: 'under-strength',
        basis: {
          kind: 'agent-origin-execution-attested',
          liveRosterMembers: 4,
          executingMembers: 2,
          transactionWorkerReadyMembers: 2,
        },
      },
      liveness: { live: 1, parked: 1, dead: 1, unknown: 1 },
      claimFlow: { status: 'unknown', values: null, reason: 'claim-flow-unread' },
    });
  });
});

/**
 * P-019 (`silent-wrong-answers-2026-08-01`) — WI-7130. A fleet that lost 10 members read
 * as a healthy 1-member fleet: `summary.dead: 0` was literally true and completely
 * misleading, because a departed member drops off the roster and is then counted as
 * nothing at all. The measured harm was not the hidden loss but the phantom event —
 * batched DISCOVERY of absence was read as a batched death, which sent two successive
 * hypotheses after a simultaneous killer that never existed (D-003).
 */
describe('buildFleetPopulationLifecycle membersLost (P-019)', () => {
  const lifecycle = (
    candidates: { agentId: string; alive?: boolean; sessionState?: 'live' | 'parked' | 'ended' | null }[],
    everMemberIds: string[],
    extra: { everMembersAvailable?: boolean; everMembersReason?: string } = {},
  ) => buildFleetPopulationLifecycle({ fleet: 'f', candidates, everMemberIds, ...extra }).snapshot.membersLost;

  it('counts an ever-member with NO roster row — the loss every present-state read returns as nothing', () => {
    const lost = lifecycle([{ agentId: 'here', alive: true, sessionState: 'live' }], ['here', 'gone-1', 'gone-2']);
    expect(lost.count).toBe(2);
    expect(lost.ownerIds).toEqual(['gone-1', 'gone-2']);
    expect(lost.available).toBe(true);
  });

  it('does NOT count a member still on the roster as ended — that one is already visible', () => {
    // The discriminating case. `liveness.dead` reports roster rows carrying an ended
    // verdict; double-counting them here would make the new field agree with the old
    // one on the population it was added to disagree about.
    const snapshot = buildFleetPopulationLifecycle({
      fleet: 'f',
      candidates: [
        { agentId: 'here', alive: true, sessionState: 'live' as const },
        { agentId: 'ended-but-listed', alive: false, sessionState: 'ended' as const },
      ],
      everMemberIds: ['here', 'ended-but-listed', 'vanished'],
    }).snapshot;
    expect(snapshot.liveness.dead).toBe(1);
    expect(snapshot.membersLost.ownerIds).toEqual(['vanished']);
    expect(snapshot.membersLost.count).toBe(1);
  });

  it('reports count:null — NOT 0 — when ever-members could not be read', () => {
    // The plan's P-014 shape: a failed READ must not render as a real answer. "0 lost"
    // on an unreadable source asserts the fleet is whole on the strength of a failure,
    // and 0 is the value a leader is least likely to question.
    const lost = lifecycle([{ agentId: 'here', alive: true, sessionState: 'live' }], ['here', 'gone'], {
      everMembersAvailable: false,
      everMembersReason: 'membership-events read failed',
    });
    expect(lost.count).toBeNull();
    expect(lost.count).not.toBe(0);
    expect(lost.available).toBe(false);
    expect(lost.ownerIds).toEqual([]);
    expect(lost.reason).toBe('membership-events read failed');
  });

  it('returns count:0 with available:true when the roster genuinely lost nobody', () => {
    // The other half of the previous test: a real zero and an unreadable source must
    // not render identically, or the caveat carries no information.
    const lost = lifecycle([{ agentId: 'here', alive: true, sessionState: 'live' }], ['here']);
    expect(lost.count).toBe(0);
    expect(lost.available).toBe(true);
  });

  it('does not fabricate a departure timestamp from the reaper-written column', () => {
    // D-003: adv_sessions.ended_at is stamped when the idle-session-reaper NOTICES a
    // dead row (9 rows inside 13ms, one dead since 20 July), so it dates the sweep and
    // clusters by construction. A `since` sourced from it would BE the silent wrong
    // answer this item was filed to remove, so timing stays explicitly unmeasured and
    // names the column that can actually answer it.
    const lost = lifecycle([], ['gone']);
    expect(lost.timing.status).toBe('not-measured');
    expect(lost).not.toHaveProperty('since');
    expect(lost.timing.insteadRead).toContain('last_active_at');
    expect(lost.timing.reason).toContain('ended_at');
  });
});

describe('selectFleetPopulation', () => {
  it('derives rows and census from ONE pass, so the numbers cannot disagree with the payload', () => {
    const { rows: kept, census } = selectFleetPopulation(rows, (r) => r.live, META);
    expect(kept.map((r) => r.id)).toEqual(['a', 'b']);
    expect(census.counted).toBe(kept.length);
    expect(census.candidates).toBe(4);
    expect(census.withheld).toBe(2);
    expect(census.withheldReason).toContain('stale-idle');
    expect(census.reveal).toBe(META.reveal);
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
      candidatesStatus: 'measured',
      candidatesAreFloor: false,
      candidatesNote: null,
      measureWith: null,
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
    expect(line).toContain('coord:presence { owner: "<agentId>" }');
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

  it('keeps total liveness unknown when only some verdicts resolved', () => {
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
    expect(census.liveness?.byState).toEqual({ live: 1 });
    expect(census.liveness?.live).toBeNull();
    expect(census.liveness?.liveShare).toBeNull();
    expect(census.liveness?.overstatesActivity).toBeNull();
    expect(census.liveness?.note).toContain('unmeasured');
    expect(renderPopulationCensus(census)).not.toContain('only 1 of 2');
  });

  it('does not turn an entirely unmeasured population into zero live agents', () => {
    const { census } = selectFleetPopulation(
      [{ state: null }, { state: undefined }],
      () => true,
      META,
      (row) => row.state,
    );
    const serialized = JSON.parse(JSON.stringify(census));
    expect(serialized.liveness).toMatchObject({
      byState: {}, unknown: 2, live: null, liveShare: null, overstatesActivity: null,
    });
    expect(serialized.liveness.note).toContain('unmeasured');
    const line = renderPopulationCensus(census);
    expect(line).toContain('unmeasured');
    expect(line).not.toContain('only 0');
    expect(line).not.toContain('0%');
  });

  it('reports a measured zero when every verdict resolved to a non-live state', () => {
    const { census } = selectFleetPopulation(
      [{ state: 'parked' as const }, { state: 'ended' as const }],
      () => true,
      META,
      (row) => row.state,
    );
    expect(census.liveness).toMatchObject({
      unknown: 0, live: 0, liveShare: 0, overstatesActivity: true,
    });
    expect(census.liveness?.note).toContain('only 0 of 2 are live');
    expect(renderPopulationCensus(census)).toContain('0%');
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
