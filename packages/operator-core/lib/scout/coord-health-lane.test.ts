import { describe, it, expect } from 'vitest';
import {
  buildCoordHealthPatterns,
  aggregatePremiseStamps,
  type CoordHealthInput,
} from './coord-health-lane';
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
