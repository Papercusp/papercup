import { describe, it, expect } from 'vitest';
import {
  buildCoordHealthPatterns,
  aggregatePremiseStamps,
  type CoordHealthInput,
  type CoordAuthoredAdoption,
  type CoordDispatchAdoption,
} from './coord-health-lane';
import {
  DISPATCH_ADOPTION_FLOOR,
  evaluateDispatchAdoption,
} from '../agent-tools/coordination/dispatch-adoption-falsifier';
import { buildEnforcementTierCensus } from './enforcement-tier-census';
import type { PremiseRefKind } from '../agent-tools/coordination/message-fields';
import type { PremiseStatus } from '../agent-tools/coordination/premise-resolve';

/**
 * blender-self-learning-2026-07-12 P-008 / WI-4453: the coord-health lane feeds
 * coordination breakdown (re-mounting escalation storms, unanswered directed mail,
 * inbox/wake floods, claim conflicts) from coord_event_log into the corpus digest,
 * so ideation targets the coordination fabric's chronic pain directly. These pin the
 * PURE builder; the PG edge (own-SQL aggregate + fetchUnansweredDirected reuse) is
 * fail-soft and exercised by the cycle integration tests.
 */

/** A clean, all-quiet baseline; each test overrides only the fields it exercises. */
function base(over: Partial<CoordHealthInput> = {}): CoordHealthInput {
  return {
    escalationStorms: [],
    wakeStorms: [],
    unansweredTargets: [],
    claimConflicts: 0,
    ...over,
  };
}

describe('buildCoordHealthPatterns — the coordination-breakdown lane (WI-4453)', () => {
  it('emits NOTHING for a quiet, cooperating fleet (all clear)', () => {
    expect(buildCoordHealthPatterns(base())).toEqual([]);
  });

  it('surfaces a re-mounting ADVISORY escalation only when it is chronic (≥ threshold), not a blip', () => {
    const chronic = buildCoordHealthPatterns(
      base({
        escalationStorms: [
          { signature: 'overwatch-scorecard-skipped', count: 8, severity: 'advisory', sample: 'scorecard skipped' },
        ],
      }),
    );
    expect(chronic.some((p) => p.ref === 'coord:escalation-storm:overwatch-scorecard-skipped')).toBe(true);

    const blip = buildCoordHealthPatterns(
      base({
        escalationStorms: [
          { signature: 'overwatch-scorecard-skipped', count: 2, severity: 'advisory', sample: 'x' },
        ],
      }),
    );
    expect(blip.some((p) => p.ref.startsWith('coord:escalation-storm:'))).toBe(false);
  });

  it('surfaces a BLOCKER escalation even at a single re-mount, weighted highest, with the EI-9492 dedup hint', () => {
    const out = buildCoordHealthPatterns(
      base({
        escalationStorms: [
          {
            signature: 'papercusp-stalled-claims-5agent-pattern',
            count: 1,
            severity: 'blocker',
            sample: 'Stalled-claims pattern persisted 4 consecutive reads',
          },
        ],
      }),
    );
    const storm = out.find((p) => p.ref === 'coord:escalation-storm:papercusp-stalled-claims-5agent-pattern');
    expect(storm).toBeTruthy();
    expect(storm!.category).toBe('coord-health');
    expect(storm!.weight).toBe(1);
    expect(storm!.summary).toContain('blocker');
    // the leaking-dedup insight (EI-9492) is the actionable payload
    expect(storm!.detail).toContain('EI-9492');
    expect(storm!.detail).toContain('dedup');
  });

  it('orders escalation storms blocker-first, then by re-mount count desc', () => {
    const out = buildCoordHealthPatterns(
      base({
        escalationStorms: [
          { signature: 'advisory-loud', count: 9, severity: 'advisory', sample: 'a' },
          { signature: 'blocker-quiet', count: 1, severity: 'blocker', sample: 'b' },
          { signature: 'advisory-quieter', count: 4, severity: 'advisory', sample: 'c' },
        ],
      }),
    );
    const refs = out.filter((p) => p.ref.startsWith('coord:escalation-storm:')).map((p) => p.ref);
    expect(refs[0]).toBe('coord:escalation-storm:blocker-quiet'); // blocker first despite lowest count
    expect(refs.indexOf('coord:escalation-storm:advisory-loud')).toBeLessThan(
      refs.indexOf('coord:escalation-storm:advisory-quieter'),
    );
  });

  it('slugifies a long free-text signature into a bounded, stable ref suffix', () => {
    const longSig = '[infra-liveness] 1 dead routine(s) overdue >10m: loop-s-1783928151045-a2faf6df — the routine engine is starved.';
    const out = buildCoordHealthPatterns(
      base({ escalationStorms: [{ signature: longSig, count: 7, severity: 'advisory', sample: longSig }] }),
    );
    const ref = out.find((p) => p.ref.startsWith('coord:escalation-storm:'))!.ref;
    const suffix = ref.slice('coord:escalation-storm:'.length);
    expect(suffix.length).toBeLessThanOrEqual(48);
    expect(suffix).toMatch(/^[a-z0-9-]+$/); // slug-safe
    // the full signature still rides the summary for humans
    expect(out[0].summary).toContain('dead routine');
  });

  it('surfaces the fleet-wide unanswered-directed backlog as ONE aggregate, worst-first, excluding below-threshold recipients', () => {
    const out = buildCoordHealthPatterns(
      base({
        unansweredTargets: [
          { recipient: 'su-bf97d32a', count: 39, oldestAgeMs: 36 * 3_600_000 },
          { recipient: 'su-00a9161f', count: 17, oldestAgeMs: 17 * 3_600_000 },
          { recipient: 'su-quiet', count: 2, oldestAgeMs: 60_000 }, // below minUnanswered (5)
        ],
      }),
    );
    const unans = out.find((p) => p.ref === 'coord:unanswered');
    expect(unans).toBeTruthy();
    expect(unans!.summary).toContain('2 agent(s)'); // the below-threshold recipient is excluded
    expect(unans!.summary).toContain('56 total'); // 39 + 17
    expect(unans!.detail).toContain('su-bf97d32a 39');
    expect(unans!.detail).not.toContain('su-quiet');
  });

  it('emits NO unanswered pattern when every backlog is below the per-recipient floor', () => {
    const out = buildCoordHealthPatterns(
      base({ unansweredTargets: [{ recipient: 'su-x', count: 3, oldestAgeMs: 1000 }] }),
    );
    expect(out.some((p) => p.ref === 'coord:unanswered')).toBe(false);
  });

  it('surfaces claim conflicts above the floor and stays silent below it', () => {
    expect(
      buildCoordHealthPatterns(base({ claimConflicts: 5 })).some((p) => p.ref === 'coord:claim-conflict'),
    ).toBe(true);
    expect(
      buildCoordHealthPatterns(base({ claimConflicts: 1 })).some((p) => p.ref === 'coord:claim-conflict'),
    ).toBe(false);
  });

  it('surfaces per-recipient inbox/wake floods above the floor, most-flooded first', () => {
    const out = buildCoordHealthPatterns(
      base({
        wakeStorms: [
          { recipient: 'su-eb9b7', count: 9962 },
          { recipient: 'su-modest', count: 150 }, // below minWakeStorm (200)
          { recipient: 'su-second', count: 800 },
        ],
      }),
    );
    const floodRefs = out.filter((p) => p.ref.startsWith('coord:wake-storm:')).map((p) => p.ref);
    expect(floodRefs).toEqual(['coord:wake-storm:su-eb9b7', 'coord:wake-storm:su-second']);
    // the biggest flood is weight-capped at 0.6
    expect(out.find((p) => p.ref === 'coord:wake-storm:su-eb9b7')!.weight).toBe(0.6);
  });

  it('orders acute (escalation → unanswered → claim-conflict) before chronic wake floods', () => {
    const out = buildCoordHealthPatterns(
      base({
        escalationStorms: [{ signature: 'sig', count: 5, severity: 'blocker', sample: 's' }],
        unansweredTargets: [{ recipient: 'su-a', count: 20, oldestAgeMs: 3_600_000 }],
        claimConflicts: 4,
        wakeStorms: [{ recipient: 'su-b', count: 5000 }],
      }),
    );
    const refs = out.map((p) => p.ref);
    expect(refs.indexOf('coord:escalation-storm:sig')).toBeLessThan(refs.indexOf('coord:unanswered'));
    expect(refs.indexOf('coord:unanswered')).toBeLessThan(refs.indexOf('coord:claim-conflict'));
    expect(refs.indexOf('coord:claim-conflict')).toBeLessThan(refs.indexOf('coord:wake-storm:su-b'));
  });

  it('reproduces the 2026-07-13 live incident (blocker re-mount + multi-agent unanswered + inbox flood)', () => {
    // WI-4453 fixture: the stalled-claims blocker re-mounted while several su inboxes
    // carried tens of unanswered directed messages and ~9k coalesced-duplicate wakes.
    const out = buildCoordHealthPatterns(
      base({
        escalationStorms: [
          {
            signature: 'papercusp-stalled-claims-5agent-pattern',
            count: 4,
            severity: 'blocker',
            sample: 'Stalled-claims pattern now persisted 4 consecutive Kettle reads — escalating advisory→blocker',
          },
        ],
        unansweredTargets: [
          { recipient: 'su-bf97d32a', count: 39, oldestAgeMs: 36 * 3_600_000 },
          { recipient: 'su-00a9161f', count: 17, oldestAgeMs: 17 * 3_600_000 },
          { recipient: 'su-02434335', count: 16, oldestAgeMs: 17 * 3_600_000 },
        ],
        wakeStorms: [{ recipient: 'su-eb9b7ae3', count: 9962 }],
      }),
    );
    expect(out.find((p) => p.ref === 'coord:escalation-storm:papercusp-stalled-claims-5agent-pattern')).toBeTruthy();
    expect(out.find((p) => p.ref === 'coord:unanswered')).toBeTruthy();
    expect(out.find((p) => p.ref === 'coord:wake-storm:su-eb9b7ae3')).toBeTruthy();
    // the acute blocker leads
    expect(out[0].ref).toBe('coord:escalation-storm:papercusp-stalled-claims-5agent-pattern');
  });

  it('respects the pattern cap', () => {
    const out = buildCoordHealthPatterns(
      base({
        escalationStorms: Array.from({ length: 20 }, (_, i) => ({
          signature: `sig-${i}`,
          count: 5 + i,
          severity: 'advisory' as const,
          sample: 's',
        })),
      }),
      { limit: 4 },
    );
    expect(out.length).toBe(4);
  });
});

/**
 * P-011 / D-091 — the premise-resolve measurement that REPLACES fill rate
 * (D-104: forced sectioning made fill rate 100% by construction).
 *
 * The load-bearing test in this block is the NO-SENDER-KEY one. Every other
 * property here would fail loudly if broken; that one would keep passing as a
 * green suite while the metric quietly acquired the per-agent attribution D-091
 * forbids — so it is pinned explicitly rather than left to review.
 */
describe('premise-resolve-rate — the P-011 measurement (D-091)', () => {
  const stamp = (
    ref: string,
    kind: PremiseRefKind,
    status: PremiseStatus,
    note?: string,
  ) => ({ ref, kind, status, note });

  it('holds `not-checkable` and `unknown` OUTSIDE the rate — they are not sender failures', () => {
    const agg = aggregatePremiseStamps([
      stamp('WI-1#completion', 'work-item-completion', 'holds'),
      stamp('/internal/docs/x', 'doc', 'not-checkable'),
      stamp('some free prose', 'opaque', 'not-checkable'),
      stamp('owner-turn:abc', 'owner-directive', 'unknown'),
    ]);
    // Only the ONE falsifiable ref may reach the rate: counting doc/opaque would
    // punish honestly citing what no graph holds (D-026); counting `unknown`
    // would charge the sender for OUR probe failing.
    expect(agg.checked).toBe(1);
    expect(agg.holds).toBe(1);
    expect(agg.notCheckable).toBe(2);
    expect(agg.unknown).toBe(1);
    expect(agg.refsSeen).toBe(4);
  });

  it('breaks the tally down by REF KIND, never by sender', () => {
    const agg = aggregatePremiseStamps([
      stamp('WI-1#completion', 'work-item-completion', 'broken', 'WI-1 is open'),
      stamp('WI-2#completion', 'work-item-completion', 'holds'),
      stamp('p#D-001', 'plan-decision', 'holds'),
    ]);
    const wic = agg.byKind.find((k) => k.kind === 'work-item-completion');
    expect(wic).toMatchObject({ checked: 2, holds: 1, broken: 1 });
    expect(agg.byKind.find((k) => k.kind === 'plan-decision')).toMatchObject({
      checked: 1,
      holds: 1,
    });
    // The aggregate has no sender dimension at all — not even an empty one.
    expect(Object.keys(agg)).not.toContain('bySender');
    expect(JSON.stringify(agg)).not.toMatch(/su-[0-9a-f]/);
  });

  it('emits an UNSUFFIXED ref — a sender-keyed metric on an ASSERTED field is forbidden (D-091)', () => {
    const out = buildCoordHealthPatterns(
      base({
        premiseResolve: aggregatePremiseStamps([
          stamp('WI-1#completion', 'work-item-completion', 'broken', 'WI-1 is open'),
          ...Array.from({ length: 6 }, (_, i) =>
            stamp(`p#D-00${i}`, 'plan-decision' as const, 'holds' as const),
          ),
        ]),
      }),
    );
    const p = out.find((x) => x.ref.startsWith('coord:premise-resolve-rate'));
    expect(p).toBeDefined();
    // EXACT equality, not startsWith: `coord:premise-resolve-rate:<sender>` is
    // the shape this decision exists to prevent, and the lane emits keyed refs
    // elsewhere (`coord:wake-storm:<recipient>`) so the mistake is one keystroke
    // away. Attaching a per-agent consequence to being caught with an
    // unresolvable ref makes "cite only what a graph can verify" dominant, and
    // the uncheckable-but-true premises go first — the metric would destroy
    // what it measures.
    expect(p!.ref).toBe('coord:premise-resolve-rate');
  });

  it('reports the resolve RATE, never a fill rate, and never gates', () => {
    const out = buildCoordHealthPatterns(
      base({
        premiseResolve: aggregatePremiseStamps([
          ...Array.from({ length: 3 }, (_, i) =>
            stamp(`WI-${i}#completion`, 'work-item-completion' as const, 'broken' as const),
          ),
          ...Array.from({ length: 7 }, (_, i) =>
            stamp(`p#D-01${i}`, 'plan-decision' as const, 'holds' as const),
          ),
        ]),
      }),
    );
    const p = out.find((x) => x.ref === 'coord:premise-resolve-rate')!;
    expect(p.summary).toContain('70%'); // 7 of 10 checked
    expect(p.summary).not.toMatch(/fill rate/i);
    expect(p.detail).not.toMatch(/fill rate/i);
    // D-088's standing condition: verification is never authorisation.
    expect(p.detail).toMatch(/NOT a gate/);
  });

  it('stays silent below the checked floor — a 1-of-1 window is not a rate', () => {
    const out = buildCoordHealthPatterns(
      base({
        premiseResolve: aggregatePremiseStamps([
          stamp('WI-1#completion', 'work-item-completion', 'broken'),
        ]),
      }),
    );
    expect(out.find((x) => x.ref === 'coord:premise-resolve-rate')).toBeUndefined();
  });

  it('still emits at a PERFECT rate — a reader that only sees failures cannot tell "all held" from "none checkable"', () => {
    const out = buildCoordHealthPatterns(
      base({
        premiseResolve: aggregatePremiseStamps(
          Array.from({ length: 8 }, (_, i) =>
            stamp(`p#D-02${i}`, 'plan-decision' as const, 'holds' as const),
          ),
        ),
      }),
    );
    const p = out.find((x) => x.ref === 'coord:premise-resolve-rate');
    expect(p).toBeDefined();
    expect(p!.summary).toContain('100%');
    // ...but it ranks low, so the cap deprioritises a clean reading naturally.
    expect(p!.weight).toBeLessThan(0.3);
  });

  it('ranks a failing window above a clean one', () => {
    const clean = buildCoordHealthPatterns(
      base({
        premiseResolve: aggregatePremiseStamps(
          Array.from({ length: 8 }, (_, i) =>
            stamp(`p#D-03${i}`, 'plan-decision' as const, 'holds' as const),
          ),
        ),
      }),
    ).find((x) => x.ref === 'coord:premise-resolve-rate')!;
    const failing = buildCoordHealthPatterns(
      base({
        premiseResolve: aggregatePremiseStamps(
          Array.from({ length: 8 }, (_, i) =>
            stamp(`WI-${i}#completion`, 'work-item-completion' as const, 'broken' as const),
          ),
        ),
      }),
    ).find((x) => x.ref === 'coord:premise-resolve-rate')!;
    expect(failing.weight!).toBeGreaterThan(clean.weight!);
  });

  it('survives the pattern cap on a noisy fleet — the corpus reading outranks per-recipient floods', () => {
    const out = buildCoordHealthPatterns(
      base({
        premiseResolve: aggregatePremiseStamps(
          Array.from({ length: 8 }, (_, i) =>
            stamp(`WI-${i}#completion`, 'work-item-completion' as const, 'broken' as const),
          ),
        ),
        wakeStorms: Array.from({ length: 30 }, (_, i) => ({
          recipient: `su-${i}`,
          count: 1000 + i,
        })),
      }),
      { limit: 5 },
    );
    // Wake storms emit one pattern PER RECIPIENT; without the deliberate
    // ordering they would push this single corpus-wide reading past the cap and
    // silently delete the measurement.
    expect(out.find((x) => x.ref === 'coord:premise-resolve-rate')).toBeDefined();
  });

  it('emits the clarify answer-rate UNSUFFIXED, and never a fill rate (P-012 / D-106)', () => {
    const out = buildCoordHealthPatterns(
      base({ clarifyAdoption: { asks: 10, answered: 4, entries: 13 } }),
    );
    const p = out.find((x) => x.ref.startsWith('coord:clarify-answer-rate'));
    expect(p).toBeDefined();
    // EXACT: keying an ASK metric by the asking agent makes asking a thing to
    // avoid being seen doing, which kills the field outright (D-091/D-090 R3).
    expect(p!.ref).toBe('coord:clarify-answer-rate');
    expect(p!.summary).toContain('40%');
    // `assuming` is schema-mandatory, so its fill rate is 100% by construction.
    expect(p!.summary).not.toMatch(/fill rate/i);
    expect(JSON.stringify(p)).not.toMatch(/su-[0-9a-f]/);
  });

  it('reads the rate AGAINST the measured incumbent baseline, in both directions', () => {
    const beating = buildCoordHealthPatterns(
      base({ clarifyAdoption: { asks: 10, answered: 9, entries: 10 } }),
    ).find((x) => x.ref === 'coord:clarify-answer-rate')!;
    const losing = buildCoordHealthPatterns(
      base({ clarifyAdoption: { asks: 10, answered: 1, entries: 10 } }),
    ).find((x) => x.ref === 'coord:clarify-answer-rate')!;
    expect(beating.summary).toMatch(/ABOVE/);
    expect(losing.summary).toMatch(/BELOW/);
    // Ranks by SHORTFALL: beating the incumbent is good news and must not crowd
    // out live coordination breakdowns.
    expect(losing.weight!).toBeGreaterThan(beating.weight!);
  });

  // ── L1/L2/L3 authored-structure adoption (coordination-spec-adoption D-091) ──
  //
  // The whole point of this signal is that it REFUSES to publish one blended
  // number. Every test below is a guard on a way the old single-number reading
  // went wrong in production, not a restatement of the implementation.

  const adoption = (over: Partial<CoordAuthoredAdoption> = {}): CoordAuthoredAdoption => ({
    handAuthored: 100,
    bypassedChokepoint: 0,
    withSections: 80,
    multiSection: 66,
    withAuthoredField: 64,
    openQuestions: 10,
    openQuestionsAnswered: 4,
    plainMessages: 20,
    plainMessagesAnswered: 4,
    structureReads: 20,
    ...over,
  });

  it('reports L1, L2 and L3 SEPARATELY, each with its own denominator inline', () => {
    const p = buildCoordHealthPatterns(base({ authoredAdoption: adoption() })).find(
      (x) => x.ref === 'coord:authored-adoption',
    );
    expect(p).toBeDefined();
    // All three levels present and labelled — never collapsed into one figure.
    // D-095: L1 is an ENFORCEMENT count, not a presence rate — see the guard below.
    expect(p!.summary).toMatch(/L1 enforcement 0 bypassed/);
    expect(p!.summary).toMatch(/L2 substantive 64%/);
    expect(p!.summary).toMatch(/L3 open-questions answered 40%/);
    // The denominator travels WITH the ratio. "0.58% adopted" was published from
    // a numerator that was exactly right and a denominator nobody stated.
    expect(p!.summary).toContain('64/100');
    expect(p!.summary).toContain('64/80');
  });

  it('NEVER reports "carries sections" as a compliance rate (D-095)', () => {
    // THE BUG THIS PINS: `stampMessageFields` writes `sections` only when they
    // carry something (authored || >1 section), so the COMPLIANT minimum
    // body:[{text}] — the exact shape the refusal message teaches — persists no
    // sections key at all. Measured 2026-08-03: 200 of 236 "sectionless"
    // hand-authored messages had passed the schema. Any rate of the form
    // withSections/handAuthored therefore reports compliant traffic as failure,
    // and the old L1 did exactly that (80/100 = "L1 present 80%").
    //
    // A regression here is silent and reads as plausible, which is why it is
    // pinned on the RENDERED text rather than on the field: the field is fine,
    // the claim made about it was not.
    const p = buildCoordHealthPatterns(
      base({ authoredAdoption: adoption({ bypassedChokepoint: 0 }) }),
    ).find((x) => x.ref === 'coord:authored-adoption')!;
    expect(p.summary).not.toMatch(/L1 present/);
    expect(p.detail).not.toMatch(/measures compliance/);
    // And the honest number is stated where the false one used to be.
    expect(p.summary).toMatch(/L1 enforcement/);
    expect(p.detail).toMatch(/100% BY CONSTRUCTION/);
  });

  it('surfaces a live BYPASS above a merely-thin authoring rate (D-095)', () => {
    // A send path that skips enforcement is not the same kind of problem as
    // agents authoring thinly: one is closed by fixing code, the other only by
    // an agent writing differently. The bypass floor must outrank the latter.
    const bypassed = buildCoordHealthPatterns(
      base({ authoredAdoption: adoption({ bypassedChokepoint: 36, withAuthoredField: 90 }) }),
    ).find((x) => x.ref === 'coord:authored-adoption')!;
    const thinButClean = buildCoordHealthPatterns(
      base({ authoredAdoption: adoption({ bypassedChokepoint: 0, withAuthoredField: 90 }) }),
    ).find((x) => x.ref === 'coord:authored-adoption')!;
    expect(bypassed.summary).toMatch(/36 bypassed/);
    expect(bypassed.weight!).toBeGreaterThan(thinButClean.weight!);
  });

  it('flags READ-STARVED when structure is written far more than it is ever opened', () => {
    // The production state that motivated this plan: ~80% written, opened 15
    // times in a week. A blended "adoption %" scored that as a success.
    const starved = buildCoordHealthPatterns(
      base({ authoredAdoption: adoption({ withAuthoredField: 64, structureReads: 2 }) }),
    ).find((x) => x.ref === 'coord:authored-adoption')!;
    expect(starved.summary).toMatch(/READ-STARVED/);

    const healthy = buildCoordHealthPatterns(
      base({ authoredAdoption: adoption({ withAuthoredField: 64, structureReads: 40 }) }),
    ).find((x) => x.ref === 'coord:authored-adoption')!;
    expect(healthy.summary).not.toMatch(/READ-STARVED/);
  });

  it('ranks a HIGH-substance read-starved corpus ABOVE a merely-thin one', () => {
    // The inversion this signal exists to produce. Optimising the write rate is
    // what the original plan would have done; a corpus rich in structure that
    // nobody reads is the WORSE state and must not be outranked by an
    // early-but-healthy thin one. (Stated in L2 terms since D-095 — the old
    // wording said "L1", which now names the bypass count instead.)
    const highL1Starved = buildCoordHealthPatterns(
      base({ authoredAdoption: adoption({ withSections: 95, withAuthoredField: 90, structureReads: 1 }) }),
    ).find((x) => x.ref === 'coord:authored-adoption')!;
    const lowL1Read = buildCoordHealthPatterns(
      base({ authoredAdoption: adoption({ withSections: 30, withAuthoredField: 25, structureReads: 25 }) }),
    ).find((x) => x.ref === 'coord:authored-adoption')!;
    expect(highL1Starved.weight!).toBeGreaterThan(lowL1Read.weight!);
  });

  it('stays SILENT below the message floor rather than publishing a 0/0 ratio', () => {
    expect(
      buildCoordHealthPatterns(base({ authoredAdoption: adoption({ handAuthored: 3 }) })).find(
        (x) => x.ref === 'coord:authored-adoption',
      ),
    ).toBeUndefined();
  });

  it('never carries a per-sender dimension (D-090/D-091 R3)', () => {
    // A per-agent adoption breakdown turns a coordination field into a
    // compliance scoreboard; writing forYouBecause to avoid looking bad is not
    // a theory of mind. Structural guard, same as the clarify metric's.
    const p = buildCoordHealthPatterns(base({ authoredAdoption: adoption() })).find(
      (x) => x.ref === 'coord:authored-adoption',
    )!;
    expect(p.ref).toBe('coord:authored-adoption');
    expect(JSON.stringify(p)).not.toMatch(/su-[0-9a-f]/);
  });

  it('reports L3 as a LIFT against the control arm, never as a floating rate (D-085)', () => {
    const p = buildCoordHealthPatterns(
      base({
        authoredAdoption: adoption({
          openQuestions: 10,
          openQuestionsAnswered: 7, // 70%
          plainMessages: 20,
          plainMessagesAnswered: 4, // 20%
        }),
      }),
    ).find((x) => x.ref === 'coord:authored-adoption')!;
    expect(p.summary).toContain('70%');
    expect(p.summary).toContain('20% plain');
    expect(p.summary).toContain('+50pp');
  });

  it('reports a NEGATIVE lift honestly rather than hiding it', () => {
    // If authored structure makes recipients LESS likely to engage, that is the
    // most important thing this signal could say, so it must not be presentable
    // only in the favourable direction.
    const p = buildCoordHealthPatterns(
      base({
        authoredAdoption: adoption({
          openQuestions: 10,
          openQuestionsAnswered: 1, // 10%
          plainMessages: 20,
          plainMessagesAnswered: 10, // 50%
        }),
      }),
    ).find((x) => x.ref === 'coord:authored-adoption')!;
    expect(p.summary).toContain('-40pp');
  });

  it('says UNINTERPRETABLE when the control arm is empty rather than implying a verdict', () => {
    const p = buildCoordHealthPatterns(
      base({ authoredAdoption: adoption({ plainMessages: 0, plainMessagesAnswered: 0 }) }),
    ).find((x) => x.ref === 'coord:authored-adoption')!;
    expect(p.summary).toMatch(/uninterpretable/i);
  });

  it('does not divide by zero when there are no open questions', () => {
    const p = buildCoordHealthPatterns(
      base({ authoredAdoption: adoption({ openQuestions: 0, openQuestionsAnswered: 0 }) }),
    ).find((x) => x.ref === 'coord:authored-adoption')!;
    // "actionable", not "open questions": the treatment arm covers
    // couldNotDetermine AND youMayNotKnow — both ask the reader to do something.
    expect(p.summary).toContain('no actionable messages');
    expect(p.summary).not.toMatch(/NaN|Infinity/);
  });

  // ── enforcement-tier census (coordination-spec-adoption P-002 / D-016+D-047) ──
  //
  // The sibling of the block above and its structural counterpart: that one
  // measures whether a shipped behaviour is USED, this one whether it is ENFORCED
  // at all. Each test guards a way the reading could become quietly untrue rather
  // than restating the builder.

  const census = (over: { declared?: string[]; called?: Record<string, number> } = {}) =>
    buildEnforcementTierCensus({
      behaviourIds: ['coord:send', 'coord:orient', 'coord:vote', 'coord:walls'],
      adoption: new Map(
        Object.entries(over.called ?? { 'coord:send': 1645, 'coord:orient': 1581 }).map(
          ([k, calls]) => [k, { calls, callers: 10 }],
        ),
      ),
      windowDays: 7,
      declared: new Map(
        (over.declared ?? ['coord:send']).map((id) => [
          id,
          { tier: 'schema-refusal' as const, evidence: 'envelope validated at the tool boundary' },
        ]),
      ),
    });

  it('reports tier DEBT and adoption as separate counts, each with its denominator inline', () => {
    const p = buildCoordHealthPatterns(base({ enforcementCensus: census() })).find(
      (x) => x.ref === 'coord:enforcement-tier-census',
    );
    expect(p).toBeDefined();
    // Three DIFFERENT questions, never blended into one "enforcement %": how many
    // carry no tier, how many carry a real one, how many took no calls.
    expect(p!.summary).toContain('3/4 coordination verbs carry NO declared tier');
    expect(p!.summary).toContain('1/4 carry a real one');
    expect(p!.summary).toContain('2/4 took zero calls');
    expect(p!.summary).not.toMatch(/NaN|Infinity/);
  });

  it('flags a zero-call UNENFORCED verb as a retirement candidate — and names it', () => {
    const p = buildCoordHealthPatterns(base({ enforcementCensus: census() })).find(
      (x) => x.ref === 'coord:enforcement-tier-census',
    )!;
    // Naming them is the point: "2 candidates" is not actionable, the ids are.
    expect(p.detail).toContain('coord:vote');
    expect(p.detail).toContain('coord:walls');
  });

  it('does NOT propose retiring a zero-call verb that carries a real tier', () => {
    // The conflation this guards against would propose retiring working
    // machinery: unused-and-unenforced is a retirement candidate, but
    // unused-yet-enforced is a different finding (built but unreached).
    const p = buildCoordHealthPatterns(
      base({ enforcementCensus: census({ declared: ['coord:send', 'coord:vote'], called: {} }) }),
    ).find((x) => x.ref === 'coord:enforcement-tier-census')!;
    expect(p.summary).toContain('4/4 took zero calls');
    expect(p.summary).toContain('of which 2 are both unused AND unenforced');
    expect(p.detail).not.toContain('coord:vote');
  });

  it('carries D-092 forward as a CANDIDATE, never a retirement verdict', () => {
    // The census must not read as authorisation to delete: D-092 ruled the
    // zero-call verbs are made discoverable and re-measured at +7d first.
    const p = buildCoordHealthPatterns(base({ enforcementCensus: census() })).find(
      (x) => x.ref === 'coord:enforcement-tier-census',
    )!;
    expect(p.detail).toMatch(/CANDIDATE, never a verdict/);
    expect(p.detail).toMatch(/D-092/);
  });

  it('stays SILENT once the tier debt is closed — a solved problem is not a finding', () => {
    expect(
      buildCoordHealthPatterns(
        base({
          enforcementCensus: census({
            declared: ['coord:send', 'coord:orient', 'coord:vote', 'coord:walls'],
          }),
        }),
      ).find((x) => x.ref === 'coord:enforcement-tier-census'),
    ).toBeUndefined();
  });

  it('ranks tier debt BELOW live coordination breakdowns — it is structural, not acute', () => {
    // A slow-moving structural reading must never crowd an escalation storm or an
    // unanswered backlog out of a capped digest.
    const out = buildCoordHealthPatterns(
      base({
        enforcementCensus: census(),
        escalationStorms: [
          { signature: 'sig', count: 9, severity: 'blocker', sample: 's' },
        ],
      }),
    );
    const cen = out.find((x) => x.ref === 'coord:enforcement-tier-census')!;
    const storm = out.find((x) => x.ref.startsWith('coord:escalation-storm'))!;
    expect(cen.weight!).toBeLessThan(storm.weight!);
  });

  it('stays SILENT below the ask floor — the field ships with zero traffic by construction', () => {
    // Not a defect: `clarify` shipped in the same change as this reading, so an
    // emitted 0% would read as a finding about the field rather than an absence
    // of data.
    expect(
      buildCoordHealthPatterns(base({ clarifyAdoption: { asks: 0, answered: 0, entries: 0 } })).find(
        (x) => x.ref === 'coord:clarify-answer-rate',
      ),
    ).toBeUndefined();
    expect(
      buildCoordHealthPatterns(base({ clarifyAdoption: { asks: 2, answered: 0, entries: 2 } })).find(
        (x) => x.ref === 'coord:clarify-answer-rate',
      ),
    ).toBeUndefined();
  });

  it('names the failing REF, with its verdict, so the fix lands in the grammar', () => {
    const out = buildCoordHealthPatterns(
      base({
        premiseResolve: aggregatePremiseStamps([
          stamp('WI-6502#completion', 'work-item-completion', 'broken', 'WI-6502 is open'),
          ...Array.from({ length: 5 }, (_, i) =>
            stamp(`p#D-04${i}`, 'plan-decision' as const, 'holds' as const),
          ),
        ]),
      }),
    );
    const p = out.find((x) => x.ref === 'coord:premise-resolve-rate')!;
    expect(p.detail).toContain('WI-6502#completion');
    expect(p.detail).toContain('broken');
    expect(p.detail).toContain('work-item-completion');
  });
});

/**
 * The coord:dispatch retirement falsifier signal (P-013 / D-100–D-102, WI-37443).
 *
 * WI-37443: `evaluateDispatchAdoption()` shipped with ZERO callers, so the
 * pre-committed falsifier could never produce a verdict — indistinguishable from
 * never having committed to one. These pin the emission that makes it real, and
 * the D-003 property that the denominator is always stated.
 */
describe('buildCoordHealthPatterns — the coord:dispatch retirement falsifier (P-013)', () => {
  const reading = (
    over: Partial<CoordDispatchAdoption['sample']> = {},
    coverageOver: Partial<CoordDispatchAdoption['coverage']> = {},
  ): CoordDispatchAdoption => {
    const sample = {
      dispatchCalls: 40,
      dispatchAgents: 8,
      sendCalls: 4_000,
      windowDays: 14,
      // DERIVED from the gate, never pinned: these cases assert KEEP/RETIRE, and
      // a sample dated before `reEvaluateAfter` returns UNDETERMINED instead — so
      // a hardcoded date silently converts them into assertions about the date
      // guard. That is exactly what happened on 2026-09-02 (WI-2142095) when the
      // gate moved 09-08 -> 09-16 and this read '2026-09-10'.
      asOf: new Date(
        new Date(`${DISPATCH_ADOPTION_FLOOR.reEvaluateAfter}T00:00:00Z`).getTime() + 86_400_000,
      )
        .toISOString()
        .slice(0, 10),
      // Default TRUE so these lane tests keep exercising the real keep/retire
      // bar. The production sampler supplies the measured value
      // (DISPATCH_INTERVENTION_REACHABLE, true since the P-011 seeding landed on
      // 2026-09-02); the precondition itself is covered in
      // dispatch-adoption-falsifier.test.ts.
      interventionReachable: true,
      ...over,
    };
    return {
      sample,
      coverage: {
        requestedWindowDays: 14,
        coveredWindowDays: 14,
        shortfall: false,
        oldestRetainedAt: '2026-08-27T12:00:00.000Z',
        ...coverageOver,
      },
      // The REAL pre-committed evaluator — never a stubbed verdict, or the test
      // would pass over a broken bar.
      verdict: evaluateDispatchAdoption(sample),
    };
  };

  const find = (input: CoordDispatchAdoption | undefined) =>
    buildCoordHealthPatterns(base({ dispatchAdoption: input })).find(
      (x) => x.ref === 'coord:dispatch-adoption-verdict',
    );

  it('emits NOTHING when there is no sample — an absent reading is not a verdict', () => {
    expect(find(undefined)).toBeUndefined();
  });

  it('emits the KEEP verdict with its rate, agent count and denominator', () => {
    const p = find(reading())!;
    expect(p).toBeDefined();
    expect(p.summary).toContain('KEEP');
    expect(p.summary).toContain('10.00/1k');
    // D-003: the denominator rides on the ratio, always.
    expect(p.summary).toContain('4000 coord:send calls / 14d');
  });

  it('emits RETIRE — and says it takes coord:handoff with it (D-102)', () => {
    const p = find(reading({ dispatchCalls: 1, dispatchAgents: 1 }))!;
    expect(p.summary).toContain('RETIRE');
    expect(p.detail).toContain('coord:handoff');
  });

  it('reports UNDETERMINED before the agreed re-evaluate date, and ranks it low', () => {
    const p = find(reading({ asOf: '2026-08-20' }))!;
    expect(p.summary).toContain('UNDETERMINED');
    // A dated no-op must never outrank a live coordination breakdown.
    expect(p.weight).toBeLessThan(0.2);
    expect(p.detail).toContain('NEVER UPGRADED TO RETIRE');
  });

  it('states the denominator even when the verdict is UNDETERMINED', () => {
    // The case where an unstated denominator is most tempting: there is no rate
    // to attach it to, so it would silently vanish.
    const p = find(reading({ sendCalls: 12, asOf: '2026-09-10' }))!;
    expect(p.summary).toContain('UNDETERMINED');
    expect(p.summary).toContain('12 coord:send calls / 14d');
  });

  it('SURVIVES a fleet whose keyed storms would otherwise consume the whole cap', () => {
    // MEASURED 2026-08-09: the live lane returned 10 patterns and all 10 were
    // `coord:escalation-storm:*` (7 of them per-agent compaction-watchdog rows),
    // so every corpus-wide measurement was silently deleted by the tail slice.
    // A falsifier that is wired but cut on a busy day is still a falsifier that
    // never produces a verdict — the exact WI-37443 defect, one layer along.
    const out = buildCoordHealthPatterns(
      base({
        dispatchAdoption: reading(),
        escalationStorms: Array.from({ length: 25 }, (_, i) => ({
          signature: `compaction-watchdog-context-death-su-${i}`,
          count: 9,
          severity: 'blocker' as const,
          sample: 'context death',
        })),
      }),
    );
    expect(out.find((x) => x.ref === 'coord:dispatch-adoption-verdict')).toBeDefined();
    // and the cap is still honoured overall
    expect(out.length).toBeLessThanOrEqual(10);
    // the keyed family is what gets truncated, not the measurement
    expect(out.some((x) => x.ref.startsWith('coord:escalation-storm:'))).toBe(true);
  });

  it('surfaces a retention shortfall rather than passing the narrowed window off as the ask', () => {
    const p = find(reading({ windowDays: 7 }, { coveredWindowDays: 7, shortfall: true }))!;
    expect(p.detail).toContain('could only substantiate 7d of the 14d');
    // and the published window is the substantiated one
    expect(p.summary).toContain('/ 7d');
  });
});
