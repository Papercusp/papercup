import { describe, it, expect } from 'vitest';
import {
  buildCoordHealthPatterns,
  type CoordHealthInput,
} from './coord-health-lane';

/**
 * blender-self-learning-2026-07-12 P-011 / WI-4453: the coord-health lane feeds
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
