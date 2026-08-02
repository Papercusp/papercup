/**
 * cadence-runner-capability.test.ts — the capability bit the per-Hive RUNNER
 * election filters peers by (EI-18761517980514694).
 *
 * What makes this worth pinning: the predicate had to be BOTH legs, and the
 * measured evidence is what rules out the simpler ones. The wrongly-elected peer on
 * the papercusp pot IS a routine host (`PAPERCUSP_DBOS_ENABLE=1`, background workers
 * on) and DOES have active routines — it logged 12,080 `[git-sync]` lines — it just
 * never fires `gym-cycle`. So "is a routine host" and "has any active routine" both
 * mark it capable and ship a no-op fix. Only "has an active CADENCE-RUNNER routine
 * for this harness" discriminates, and that is what these tests hold in place.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  CADENCE_RUNNER_ROUTINES,
  nodeActiveRoutines,
  nodeRunsCadenceLoops,
  _resetCadenceRunnerCapabilityCache,
} from './cadence-runner-capability';

const WS = 'ws-1';
const HARNESS = 'papercusp';

beforeEach(() => _resetCadenceRunnerCapabilityCache());

describe('nodeRunsCadenceLoops — both legs are required', () => {
  it('TRUE only when the routine host launches AND a cadence routine is armed here', async () => {
    expect(
      await nodeRunsCadenceLoops(WS, HARNESS, {
        dbosLaunches: () => true,
        hasActiveCadenceRoutine: async () => true,
        ttlMs: 0,
      }),
    ).toBe(true);
  });

  it('FALSE on a node that is a routine host but has no cadence routine for this harness', async () => {
    // The measured live case: the elected peer runs routines (git-sync) but never
    // fires this pot's cadence loop. A `dbosLaunchesHere()`-only marker would have
    // returned true here and left the loop dark.
    expect(
      await nodeRunsCadenceLoops(WS, HARNESS, {
        dbosLaunches: () => true,
        hasActiveCadenceRoutine: async () => false,
        ttlMs: 0,
      }),
    ).toBe(false);
  });

  it('FALSE on a request-only host, even with the routine armed (it would never fire)', async () => {
    expect(
      await nodeRunsCadenceLoops(WS, HARNESS, {
        dbosLaunches: () => false,
        hasActiveCadenceRoutine: async () => true,
        ttlMs: 0,
      }),
    ).toBe(false);
  });

  it('does not even ask about routines when the routine host does not launch', async () => {
    let asked = false;
    await nodeRunsCadenceLoops(WS, HARNESS, {
      dbosLaunches: () => false,
      hasActiveCadenceRoutine: async () => {
        asked = true;
        return true;
      },
      ttlMs: 0,
    });
    expect(asked).toBe(false);
  });

  it('never throws — a failed lookup resolves to "not a runner" (the safe direction)', async () => {
    // Under-reporting only makes PEERS skip us; every selector adds SELF
    // unconditionally, so we still run our own loop. Over-reporting would let a
    // node that cannot do the work win the election — the bug itself.
    expect(
      await nodeRunsCadenceLoops(WS, HARNESS, {
        dbosLaunches: () => true,
        hasActiveCadenceRoutine: async () => {
          throw new Error('presence DB unreachable');
        },
        ttlMs: 0,
      }),
    ).toBe(false);
  });
});

describe('nodeRunsCadenceLoops — the TTL cache', () => {
  it('reuses an answer inside the window, then re-reads after it', async () => {
    let calls = 0;
    let now = 1_000_000;
    const deps = {
      now: () => now,
      dbosLaunches: () => true,
      hasActiveCadenceRoutine: async () => {
        calls++;
        return true;
      },
      ttlMs: 60_000,
    };
    expect(await nodeRunsCadenceLoops(WS, HARNESS, deps)).toBe(true);
    expect(await nodeRunsCadenceLoops(WS, HARNESS, deps)).toBe(true);
    expect(calls).toBe(1); // the announcer calls this on every announce, per harness

    now += 60_001;
    expect(await nodeRunsCadenceLoops(WS, HARNESS, deps)).toBe(true);
    expect(calls).toBe(2);
  });

  it('SELF-HEALS: a node that disarms its cadence routine stops advertising itself', async () => {
    // This is why the publisher re-resolves per announce instead of pinning the bit
    // at wire time (the way pot_slug is). A stale `true` would keep the node winning
    // the argmin after it stopped running the loop — re-creating the starvation.
    let armed = true;
    let now = 1_000_000;
    const deps = {
      now: () => now,
      dbosLaunches: () => true,
      hasActiveCadenceRoutine: async () => armed,
      ttlMs: 60_000,
    };
    expect(await nodeRunsCadenceLoops(WS, HARNESS, deps)).toBe(true);
    armed = false;
    now += 60_001; // well inside the 90s authority staleness window
    expect(await nodeRunsCadenceLoops(WS, HARNESS, deps)).toBe(false);
  });

  it('caches per (workspace, harness) — one harness cannot answer for another', async () => {
    const seen: string[] = [];
    const deps = {
      dbosLaunches: () => true,
      hasActiveCadenceRoutine: async (ws: string, h: string) => {
        seen.push(`${ws}::${h}`);
        return h === HARNESS;
      },
    };
    expect(await nodeRunsCadenceLoops(WS, HARNESS, deps)).toBe(true);
    expect(await nodeRunsCadenceLoops(WS, 'other-harness', deps)).toBe(false);
    expect(seen).toEqual([`${WS}::${HARNESS}`, `${WS}::other-harness`]);
  });
});

/**
 * nodeActiveRoutines — the published routine SET (EI-19330771435294981, mig 724).
 *
 * Why a set rather than a second boolean: WI-6996 pointed the git-sync INTEGRATOR
 * election at `runs_routines`, a bit about a DIFFERENT loop. Measured on papercusp
 * 2026-08-02 that bit was null on every live presence row (gym-cycle inactive,
 * scout-cycle nonexistent), so the narrowing resolved to ∅ and integrator peer
 * arbitration was turned OFF rather than tightened. Publishing the facts lets each
 * election ask its own question instead of sharing one coarse bit.
 */
describe('nodeActiveRoutines — the published capability SET', () => {
  it('publishes the active routine names when the routine host launches here', async () => {
    expect(
      await nodeActiveRoutines(WS, HARNESS, {
        dbosLaunches: () => true,
        activeRoutineNames: async () => ['git-sync', 'gym-cycle'],
        ttlMs: 0,
      }),
    ).toEqual(['git-sync', 'gym-cycle']);
  });

  it('publishes NOTHING on a request-only host, even with routines armed', async () => {
    // Same both-legs rule as the boolean: an armed routine on a host that never
    // launches the routine host NEVER FIRES, so advertising it would claim a
    // capability this node does not have — exactly the WI-6996 failure shape.
    let asked = false;
    expect(
      await nodeActiveRoutines(WS, HARNESS, {
        dbosLaunches: () => false,
        activeRoutineNames: async () => {
          asked = true;
          return ['git-sync'];
        },
        ttlMs: 0,
      }),
    ).toEqual([]);
    expect(asked).toBe(false);
  });

  it('DEDUPES and SORTS, so an unchanged set produces byte-identical signed frames', async () => {
    // The set rides presenceFrameSigningBytes. Were the publisher to pass the
    // reader's raw row order through, an unchanged routine set could re-order
    // between announces and churn the signed bytes for no reason. Normalizing in
    // the resolver makes determinism independent of what the reader returns.
    expect(
      await nodeActiveRoutines(WS, HARNESS, {
        dbosLaunches: () => true,
        activeRoutineNames: async () => ['gym-cycle', 'git-sync', 'gym-cycle'],
        ttlMs: 0,
      }),
    ).toEqual(['git-sync', 'gym-cycle']);
  });

  it('never throws — a failed lookup publishes the EMPTY set (the safe direction)', async () => {
    // Empty can never make an election go dark: both selectors re-add SELF
    // unconditionally after the exclusion filter, so the worst case is a duplicate,
    // never a stall. Over-reporting is what elects a node that cannot do the work.
    expect(
      await nodeActiveRoutines(WS, HARNESS, {
        dbosLaunches: () => true,
        activeRoutineNames: async () => {
          throw new Error('routines table unreachable');
        },
        ttlMs: 0,
      }),
    ).toEqual([]);
  });

  it('returns a FROZEN array, so a caller cannot poison the shared cache entry', async () => {
    const set = await nodeActiveRoutines(WS, HARNESS, {
      dbosLaunches: () => true,
      activeRoutineNames: async () => ['git-sync'],
    });
    expect(Object.isFrozen(set)).toBe(true);
    // Cached by reference and handed to every subsequent announce — a mutation
    // here would silently rewrite what this node advertises to its peers.
    expect(() => (set as string[]).push('gym-cycle')).toThrow();
    expect(
      await nodeActiveRoutines(WS, HARNESS, {
        dbosLaunches: () => true,
        activeRoutineNames: async () => ['git-sync'],
      }),
    ).toEqual(['git-sync']);
  });

  it('SELF-HEALS on disarm, on the same TTL as the boolean', async () => {
    let armed = ['git-sync', 'gym-cycle'];
    let now = 1_000_000;
    let calls = 0;
    const deps = {
      now: () => now,
      dbosLaunches: () => true,
      activeRoutineNames: async () => {
        calls++;
        return [...armed];
      },
      ttlMs: 60_000,
    };
    expect(await nodeActiveRoutines(WS, HARNESS, deps)).toEqual(['git-sync', 'gym-cycle']);
    expect(await nodeActiveRoutines(WS, HARNESS, deps)).toEqual(['git-sync', 'gym-cycle']);
    expect(calls).toBe(1); // one cached read per announce, not one per poll

    armed = ['gym-cycle']; // git-sync disarmed here
    now += 60_001; // still well inside the 90s authority staleness window
    expect(await nodeActiveRoutines(WS, HARNESS, deps)).toEqual(['gym-cycle']);
  });

  it('caches per (workspace, harness) — one harness cannot answer for another', async () => {
    const seen: string[] = [];
    const deps = {
      dbosLaunches: () => true,
      activeRoutineNames: async (ws: string, h: string) => {
        seen.push(`${ws}::${h}`);
        return h === HARNESS ? ['gym-cycle'] : [];
      },
    };
    expect(await nodeActiveRoutines(WS, HARNESS, deps)).toEqual(['gym-cycle']);
    expect(await nodeActiveRoutines(WS, 'other-harness', deps)).toEqual([]);
    expect(seen).toEqual([`${WS}::${HARNESS}`, `${WS}::other-harness`]);
  });
});

describe('nodeActiveRoutines ⊃ nodeRunsCadenceLoops — the invariant P-004 rests on', () => {
  // P-004 replaces the separately-published boolean with a derivation:
  //   runs_routines  ⇔  set ∩ CADENCE_RUNNER_ROUTINES ≠ ∅
  // That is only a safe swap if the two agree on EVERY input today, including the
  // dbos leg. Pinned here so P-004 cannot silently widen or narrow the predicate.
  const cases: Array<{ dbos: boolean; routines: string[]; label: string }> = [
    { dbos: true, routines: ['gym-cycle'], label: 'a cadence routine armed' },
    { dbos: true, routines: ['scout-cycle', 'git-sync'], label: 'cadence + unrelated' },
    { dbos: true, routines: ['git-sync'], label: 'ONLY the unrelated routine' },
    { dbos: true, routines: [], label: 'no routines at all' },
    { dbos: false, routines: ['gym-cycle'], label: 'request-only host' },
  ];

  for (const { dbos, routines, label } of cases) {
    it(`agrees for: ${label}`, async () => {
      _resetCadenceRunnerCapabilityCache();
      const derived = (
        await nodeActiveRoutines(WS, HARNESS, {
          dbosLaunches: () => dbos,
          activeRoutineNames: async () => [...routines],
          ttlMs: 0,
        })
      ).some((n) => (CADENCE_RUNNER_ROUTINES as readonly string[]).includes(n));

      const published = await nodeRunsCadenceLoops(WS, HARNESS, {
        dbosLaunches: () => dbos,
        hasActiveCadenceRoutine: async () =>
          routines.some((n) => (CADENCE_RUNNER_ROUTINES as readonly string[]).includes(n)),
        ttlMs: 0,
      });

      expect(derived).toBe(published);
    });
  }
});

describe('CADENCE_RUNNER_ROUTINES', () => {
  it('names the cadence loops that arbitrate through the single-runner gate', () => {
    // Kept in sync by hand with the gate's consumers (gym-actions.ts →
    // isHiveRunner, scout/run.ts, blueprint-steps/ops/scout-cycle.ts). A miss here
    // makes a node look incapable to peers; a stale extra marks it capable of a
    // loop it does not run.
    expect([...CADENCE_RUNNER_ROUTINES]).toEqual(['gym-cycle', 'scout-cycle']);
  });
});
