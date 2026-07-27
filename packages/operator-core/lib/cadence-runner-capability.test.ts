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

describe('CADENCE_RUNNER_ROUTINES', () => {
  it('names the cadence loops that arbitrate through the single-runner gate', () => {
    // Kept in sync by hand with the gate's consumers (gym-actions.ts →
    // isHiveRunner, scout/run.ts, blueprint-steps/ops/scout-cycle.ts). A miss here
    // makes a node look incapable to peers; a stale extra marks it capable of a
    // loop it does not run.
    expect([...CADENCE_RUNNER_ROUTINES]).toEqual(['gym-cycle', 'scout-cycle']);
  });
});
