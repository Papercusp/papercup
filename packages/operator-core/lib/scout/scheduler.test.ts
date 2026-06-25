/**
 * scheduler.test.ts — Scout P-008 runScoutTick composition.
 * Pins: cadence-gating, fire-gate short-circuit, budgeted-cycle run, provenance
 * persistence, outcome refresh, fire-state recording, tick observability
 * (P-034 — one scout_ticks record per tick, gated/ran/error, best-effort), and
 * the prompt-free autonomy (the cycle is driven purely by injected deps — no
 * human in the loop).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runScoutTick,
  buildScoutTickDeps,
  type ScoutTickDeps,
  type ScoutCycleLike,
  type QueenFeedbackItem,
} from './scheduler';
import type { ScoutTickRecord } from './tick-ledger';
import type { ScoutCadenceState } from './cadence';

const NOW = Date.parse('2026-06-08T12:00:00Z');

function fakeCycle(provenance: ScoutCycleLike['provenance'] = []): ScoutCycleLike {
  return { provenance, costUsd: 0.1 };
}

function makeDeps(over: Partial<ScoutTickDeps> & { state?: Partial<ScoutCadenceState> } = {}): {
  deps: ScoutTickDeps;
  calls: { fire: string[]; persisted: number; refreshed: number; ranBudget?: number; ticks: ScoutTickRecord[] };
} {
  const calls = {
    fire: [] as string[],
    persisted: 0,
    refreshed: 0,
    ranBudget: undefined as number | undefined,
    ticks: [] as ScoutTickRecord[],
  };
  const deps: ScoutTickDeps = {
    readCadenceState: async () => ({ idleRatio: 1, frictionSignals: 0, lastRunAtMs: null, nowMs: NOW, ...over.state }),
    runCycle: over.runCycle ?? (async ({ budget }) => {
      calls.ranBudget = budget.maxCostUsd;
      return fakeCycle([{ ideaId: 'i1', lens: 'analogical', rail: 'gym', routedRef: 'gym:1' }]);
    }),
    persistRouted: over.persistRouted ?? (async () => { calls.persisted += 1; }),
    recordFire: over.recordFire ?? (async (o) => { calls.fire.push(o); }),
    refreshOutcomes: over.refreshOutcomes ?? (async () => { calls.refreshed += 1; }),
    recordTick: over.recordTick ?? (async (rec) => { calls.ticks.push(rec); }),
    ...(over.fireGate ? { fireGate: over.fireGate } : {}),
    newCycleId: over.newCycleId ?? (() => 'cyc-1'),
  };
  return { deps, calls };
}

describe('runScoutTick (P-008)', () => {
  it('withholds when the cadence gate says no-fire (no cycle, no fire-record)', async () => {
    const { deps, calls } = makeDeps({ state: { idleRatio: 0, frictionSignals: 0, lastRunAtMs: NOW - 60_000 } });
    const r = await runScoutTick(deps, { cadence: { minIntervalSec: 3600 } });
    expect(r.fired).toBe(false);
    expect(r.reason).toBe('min-interval');
    expect(calls.fire).toEqual([]); // didn't even attempt
    expect(calls.persisted).toBe(0);
  });

  it('fires on idle capacity: runs the budgeted cycle, persists routed, refreshes outcomes, records attempt+ok', async () => {
    const { deps, calls } = makeDeps();
    const r = await runScoutTick(deps, { budget: { maxCostUsd: 2.5 } });
    expect(r.fired).toBe(true);
    expect(r.reason).toBe('idle-capacity');
    expect(r.cycleId).toBe('cyc-1');
    expect(r.routedCount).toBe(1);
    expect(calls.ranBudget).toBe(2.5); // resolved budget threaded into the cycle
    expect(calls.persisted).toBe(1);
    expect(calls.refreshed).toBe(1);
    expect(calls.fire).toEqual(['attempt', 'ok']);
  });

  it('short-circuits when the autoloop fire-gate denies (circuit open)', async () => {
    const { deps, calls } = makeDeps({ fireGate: async () => ({ allow: false, reason: 'circuit-open', retryAfterSec: 3600 }) });
    const r = await runScoutTick(deps);
    expect(r.fired).toBe(false);
    expect(r.reason).toBe('circuit');
    expect(r.retryAfterSec).toBe(3600);
    expect(calls.fire).toEqual([]); // gated before attempt
    expect(calls.persisted).toBe(0);
  });

  it('records attempt+error and reports cycle-error when the cycle throws', async () => {
    const { deps, calls } = makeDeps({ runCycle: async () => { throw new Error('llm exploded'); } });
    const r = await runScoutTick(deps);
    expect(r.fired).toBe(false);
    expect(r.reason).toBe('cycle-error');
    expect(r.error).toContain('llm exploded');
    expect(calls.fire).toEqual(['attempt', 'error']);
    expect(calls.persisted).toBe(0);
  });

  it('does not persist when the cycle routes nothing', async () => {
    const { deps, calls } = makeDeps({ runCycle: async () => fakeCycle([]) });
    const r = await runScoutTick(deps);
    expect(r.fired).toBe(true);
    expect(r.routedCount).toBe(0);
    expect(calls.persisted).toBe(0); // nothing to persist
    expect(calls.refreshed).toBe(1); // still refreshes outcomes
  });

  it('fires friction-triggered even under load (idle below threshold)', async () => {
    const { deps } = makeDeps({ state: { idleRatio: 0, frictionSignals: 5, lastRunAtMs: null } });
    const r = await runScoutTick(deps);
    expect(r.fired).toBe(true);
    expect(r.reason).toBe('friction-triggered');
  });

  it('is prompt-free: the whole tick runs from injected deps with no human/ask seam', () => {
    // Structural guarantee: ScoutTickDeps exposes no askUser/human gate — the only
    // inputs are readers + the injected cycle. (Compile-time + this assertion.)
    const { deps } = makeDeps();
    expect(Object.keys(deps)).not.toContain('askUser');
    expect(Object.keys(deps)).not.toContain('promptHuman');
  });
});

describe('runScoutTick — tick observability (P-034)', () => {
  it('records a gated tick naming the cadence gate that withheld it', async () => {
    const { deps, calls } = makeDeps({ state: { idleRatio: 0, frictionSignals: 0, lastRunAtMs: NOW - 60_000 } });
    await runScoutTick(deps, { cadence: { minIntervalSec: 3600 } });
    expect(calls.ticks).toHaveLength(1);
    expect(calls.ticks[0].status).toBe('gated');
    expect(calls.ticks[0].gate).toBe('min-interval');
    expect(calls.ticks[0].detail?.retryAfterSec).toBeGreaterThan(0);
  });

  it('records a gated tick with gate=no-trigger when nothing fires', async () => {
    const { deps, calls } = makeDeps({ state: { idleRatio: 0, frictionSignals: 0, lastRunAtMs: NOW - 7200_000 } });
    await runScoutTick(deps, { cadence: { minIntervalSec: 3600, maxIntervalSec: 86400 } });
    expect(calls.ticks).toEqual([{ status: 'gated', gate: 'no-trigger' }]);
  });

  it('records a gated tick with gate=circuit when the autoloop fire-gate denies', async () => {
    const { deps, calls } = makeDeps({
      fireGate: async () => ({ allow: false, reason: 'circuit-open', retryAfterSec: 3600 }),
    });
    await runScoutTick(deps);
    expect(calls.ticks).toHaveLength(1);
    expect(calls.ticks[0]).toMatchObject({
      status: 'gated',
      gate: 'circuit',
      detail: { reason: 'circuit-open', retryAfterSec: 3600 },
    });
  });

  it('records a ran tick with generated/routed/deduped counts + spend on a full cycle', async () => {
    const { deps, calls } = makeDeps({
      runCycle: async () => ({
        provenance: [
          { ideaId: 'i1', lens: 'analogical', rail: 'gym', routedRef: 'gym:1' },
          { ideaId: 'i2', lens: 'reframing', rail: 'plan', routedRef: 'plan:x' },
        ],
        costUsd: 0.42,
        ideas: ['a', 'b', 'c', 'd', 'e'],
        scored: ['a', 'b', 'c', 'd', 'e'],
        survivors: ['a', 'b'],
        stop: 'completed',
      }),
    });
    const r = await runScoutTick(deps);
    expect(r.fired).toBe(true);
    expect(calls.ticks).toHaveLength(1);
    expect(calls.ticks[0]).toMatchObject({
      status: 'ran',
      ideasGenerated: 5,
      ideasRouted: 2,
      ideasDeduped: 3, // scored − survivors (the critics' prune)
      budgetUsedUsd: 0.42,
      detail: { cycleId: 'cyc-1', reason: 'idle-capacity', stop: 'completed' },
    });
    expect(calls.ticks[0].gate).toBeUndefined();
  });

  it('records zero counts on a ran tick whose cycle reports no stage arrays (minimal ScoutCycleLike)', async () => {
    const { deps, calls } = makeDeps({ runCycle: async () => fakeCycle([]) });
    await runScoutTick(deps);
    expect(calls.ticks[0]).toMatchObject({ status: 'ran', ideasGenerated: 0, ideasRouted: 0, ideasDeduped: 0 });
  });

  it('records an error tick (with the message) when the cycle throws', async () => {
    const { deps, calls } = makeDeps({ runCycle: async () => { throw new Error('llm exploded'); } });
    await runScoutTick(deps);
    expect(calls.ticks).toHaveLength(1);
    expect(calls.ticks[0].status).toBe('error');
    expect(calls.ticks[0].detail).toMatchObject({ cycleId: 'cyc-1', error: 'llm exploded' });
  });

  it('records an error tick, aborts the cycle, and releases the fire as error when the cycle times out', async () => {
    let cycleSignal: AbortSignal | undefined;
    const { deps, calls } = makeDeps({
      runCycle: ({ signal }) => {
        cycleSignal = signal;
        return new Promise(() => undefined);
      },
    });
    const r = await runScoutTick(deps, { cycleTimeoutMs: 5 });
    expect(r.fired).toBe(false);
    expect(r.reason).toBe('cycle-error');
    expect(r.error).toContain('Scout cycle timed out after 5ms');
    expect(cycleSignal?.aborted).toBe(true);
    expect(calls.fire).toEqual(['attempt', 'error']);
    expect(calls.ticks).toHaveLength(1);
    expect(calls.ticks[0].status).toBe('error');
    expect(calls.ticks[0].detail).toMatchObject({ cycleId: 'cyc-1', error: 'Scout cycle timed out after 5ms' });
  });

  it('is best-effort: a throwing recorder never fails the tick (gated and ran paths)', async () => {
    const boom = vi.fn(async () => { throw new Error('pg down'); });
    const ran = await runScoutTick(makeDeps({ recordTick: boom }).deps);
    expect(ran.fired).toBe(true);
    const gated = await runScoutTick(
      makeDeps({ recordTick: boom, state: { idleRatio: 0, lastRunAtMs: NOW - 1000 } }).deps,
    );
    expect(gated.fired).toBe(false);
    expect(gated.reason).toBe('min-interval');
    expect(boom).toHaveBeenCalledTimes(2);
  });

  it('runs fine with no recorder dep at all (recordTick is optional)', async () => {
    const { deps } = makeDeps();
    delete (deps as Partial<ScoutTickDeps>).recordTick;
    const r = await runScoutTick(deps);
    expect(r.fired).toBe(true);
  });
});

describe('runScoutTick — gate ordering + uncovered exits (scout-loop-test-plan P-005)', () => {
  it('checks the cadence gate BEFORE the fire-gate: a withheld tick never consults the circuit', async () => {
    const fireGate = vi.fn(async () => ({ allow: false as const }));
    const { deps } = makeDeps({ fireGate, state: { idleRatio: 0, frictionSignals: 0, lastRunAtMs: NOW - 1000 } });
    const r = await runScoutTick(deps);
    expect(r.reason).toBe('min-interval');
    expect(fireGate).not.toHaveBeenCalled();
  });

  it('mints the default cycle id from the cadence-state clock (scout-<nowMs>)', async () => {
    const { deps } = makeDeps();
    delete (deps as Partial<ScoutTickDeps>).newCycleId;
    const r = await runScoutTick(deps);
    expect(r.cycleId).toBe(`scout-${NOW}`);
  });

  it('reports cycle-error (attempt+error) when provenance persistence fails after a good cycle', async () => {
    const { deps, calls } = makeDeps({ persistRouted: async () => { throw new Error('pg down'); } });
    const r = await runScoutTick(deps);
    expect(r.fired).toBe(false);
    expect(r.reason).toBe('cycle-error');
    expect(r.error).toContain('pg down');
    expect(calls.fire).toEqual(['attempt', 'error']);
    expect(calls.ticks[0].status).toBe('error');
  });

  it('invalid budget overrides resolve to the defaults before reaching the cycle', async () => {
    const { deps, calls } = makeDeps();
    await runScoutTick(deps, { budget: { maxCostUsd: -3, maxIdeators: 0 } });
    expect(calls.ranBudget).toBe(1.0); // DEFAULT_SCOUT_BUDGET.maxCostUsd, not -3
  });

  it('tolerates a cycle result with no provenance field (defensive ?? [])', async () => {
    const { deps, calls } = makeDeps({ runCycle: async () => ({} as ScoutCycleLike) });
    const r = await runScoutTick(deps);
    expect(r.fired).toBe(true);
    expect(r.routedCount).toBe(0);
    expect(calls.persisted).toBe(0);
  });
});

describe('runScoutTick — double-fire / overlapping ticks (scout-loop-test-plan P-005)', () => {
  /**
   * Shared-state deps mirroring the PRODUCTION clock seam: autoloop recordFire
   * sets last_fired_at = now() on EVERY outcome (attempt/ok/error), and
   * readCadenceState reads it back as lastRunAtMs on the next tick. The only
   * re-fire protection runScoutTick has is that read-back through the cadence
   * min-interval floor.
   */
  function sharedClockDeps() {
    const shared = { lastRunAtMs: null as number | null };
    const calls = { cycles: 0, fire: [] as string[], ticks: [] as ScoutTickRecord[] };
    const deps: ScoutTickDeps = {
      readCadenceState: async () => ({
        idleRatio: 1,
        frictionSignals: 0,
        lastRunAtMs: shared.lastRunAtMs,
        nowMs: NOW,
      }),
      runCycle: async () => {
        calls.cycles += 1;
        return { provenance: [] };
      },
      persistRouted: async () => {},
      // Mirrors autoloop.claimFire's CAS: win only while the shared slot still
      // matches what this tick read; the winner stamps it (last_fired_at=now()).
      claimFire: async (expected) => {
        if (shared.lastRunAtMs !== expected) return false;
        shared.lastRunAtMs = NOW;
        return true;
      },
      recordFire: async (o) => {
        calls.fire.push(o);
        shared.lastRunAtMs = NOW; // autoloop: last_fired_at = now()
      },
      recordTick: async (rec) => {
        calls.ticks.push(rec);
      },
      newCycleId: () => 'cyc-dbl',
    };
    return { deps, calls };
  }

  it('SEQUENTIAL ticks are idempotent: the second tick is gated by the min-interval floor', async () => {
    const { deps, calls } = sharedClockDeps();
    const first = await runScoutTick(deps);
    const second = await runScoutTick(deps);
    expect(first.fired).toBe(true);
    expect(second.fired).toBe(false);
    expect(second.reason).toBe('min-interval');
    expect(calls.cycles).toBe(1); // exactly one cycle across both ticks
  });

  it('EI-304 FIXED: two OVERLAPPING ticks collapse to ONE cycle via the single-flight claim', async () => {
    // The historical defect (pinned here until 2026-06-11): runScoutTick was
    // check-then-act — both overlapping ticks snapshotted stale lastRunAtMs,
    // both passed the min-interval floor, both ran a full budgeted cycle.
    // The fix is the claimFire CAS step between the gates and the cycle:
    // exactly one tick wins the claim; the loser exits as a gated no-op with
    // reason 'claim-lost'. (Production wiring: autoloop.claimFire — a CAS
    // UPDATE on autoloop_state.last_fired_at, cross-process correct.)
    const { deps, calls } = sharedClockDeps();
    const [a, b] = await Promise.all([runScoutTick(deps), runScoutTick(deps)]);
    const winner = a.fired ? a : b;
    const loser = a.fired ? b : a;
    expect(winner.fired).toBe(true);
    expect(loser.fired).toBe(false);
    expect(loser.reason).toBe('claim-lost');
    expect(calls.cycles).toBe(1); // exactly one cycle across overlapping ticks
    expect(calls.fire.filter((o) => o === 'attempt')).toHaveLength(1);
    expect(calls.ticks.filter((t) => t.status === 'ran')).toHaveLength(1);
    expect(calls.ticks.filter((t) => t.status === 'gated' && t.gate === 'claim-lost')).toHaveLength(1);
  });

  it('EI-1600: a RECENT fire-slot clock does NOT gate a real cycle — the floor measures the last RUN', async () => {
    // The dormancy bug: lastRunAtMs was sourced from the autoloop fire-ATTEMPT clock
    // (advanced by a hung/errored fire that never ran a cycle), so the min-interval
    // floor gated every real cycle as 'min-interval' (~24h dark). Now the cadence
    // floor measures the last RUN (lastRunAtMs = last scout_ticks 'ran') and the
    // single-flight claim CAS's against the SEPARATE fire-slot clock (fireSlotLastMs).
    const claimExpected: Array<number | null> = [];
    const calls = { cycles: 0 };
    const deps: ScoutTickDeps = {
      // last RUN is long ago (3h), but the fire-slot was just stamped (1 min ago).
      readCadenceState: async () => ({
        idleRatio: 0,
        frictionSignals: 0,
        lastRunAtMs: NOW - 3 * 3600_000,
        fireSlotLastMs: NOW - 60_000,
        nowMs: NOW,
      }),
      runCycle: async () => {
        calls.cycles += 1;
        return { provenance: [] };
      },
      persistRouted: async () => {},
      claimFire: async (expected) => {
        claimExpected.push(expected);
        return true;
      },
      recordFire: async () => {},
      recordTick: async () => {},
      newCycleId: () => 'cyc-1600',
    };
    const r = await runScoutTick(deps, { cadence: { minIntervalSec: 3600, maxIntervalSec: 3600 } });
    // Floor is measured from the last RUN (3h ago) → fires (heartbeat), NOT gated.
    expect(r.fired).toBe(true);
    expect(r.reason).toBe('heartbeat');
    expect(calls.cycles).toBe(1);
    // The single-flight claim CAS'd against the FIRE-SLOT clock, not the cadence clock.
    expect(claimExpected).toEqual([NOW - 60_000]);
  });

  it('EI-1600: claimFire falls back to lastRunAtMs when fireSlotLastMs is absent (unit-test fakes)', async () => {
    const claimExpected: Array<number | null> = [];
    const deps: ScoutTickDeps = {
      readCadenceState: async () => ({ idleRatio: 1, frictionSignals: 0, lastRunAtMs: NOW - 3600_000, nowMs: NOW }),
      runCycle: async () => ({ provenance: [] }),
      persistRouted: async () => {},
      claimFire: async (expected) => {
        claimExpected.push(expected);
        return true;
      },
      recordFire: async () => {},
      recordTick: async () => {},
      newCycleId: () => 'cyc-fallback',
    };
    const r = await runScoutTick(deps);
    expect(r.fired).toBe(true);
    expect(claimExpected).toEqual([NOW - 3600_000]); // fell back to lastRunAtMs (no fireSlotLastMs)
  });

  it('production wiring includes the single-flight claim (buildScoutTickDeps)', async () => {
    const deps = buildScoutTickDeps({
      harnessSlug: 'papercup',
      runCycle: async () => ({ provenance: [] }),
      readIdleRatio: async () => 1,
      readFrictionSignals: async () => 0,
    });
    expect(typeof deps.claimFire).toBe('function');
  });

  it('production wiring includes the queen-feedback channel (buildScoutTickDeps)', async () => {
    const deps = buildScoutTickDeps({
      harnessSlug: 'papercusp',
      runCycle: async () => ({ provenance: [] }),
      readIdleRatio: async () => 1,
      readFrictionSignals: async () => 0,
    });
    expect(typeof deps.readQueenFeedback).toBe('function');
    expect(typeof deps.ackQueenFeedback).toBe('function');
  });
});

describe('runScoutTick — Queen→Scout feedback (P-001)', () => {
  const item = (planSlug: string): QueenFeedbackItem => ({
    planSlug,
    body: 'tighten the Now block',
    fromOwnerId: 'q-1',
    msgId: `m-${planSlug}`,
    ts: '2026-06-08T11:00:00Z',
  });

  function depsWithFeedback(opts: {
    feedback: QueenFeedbackItem[];
    idleRatio?: number;
    lastRunAtMs?: number | null;
    runCycle?: ScoutTickDeps['runCycle'];
    readThrows?: boolean;
  }): {
    deps: ScoutTickDeps;
    seen: { threaded?: QueenFeedbackItem[]; acked: QueenFeedbackItem[][]; cycleRan: boolean };
  } {
    const seen = {
      threaded: undefined as QueenFeedbackItem[] | undefined,
      acked: [] as QueenFeedbackItem[][],
      cycleRan: false,
    };
    const deps: ScoutTickDeps = {
      readCadenceState: async () => ({
        idleRatio: opts.idleRatio ?? 0,
        frictionSignals: 0,
        // honor an EXPLICIT null (never-run); default 1m-ago so the normal floor would gate
        lastRunAtMs: 'lastRunAtMs' in opts ? opts.lastRunAtMs ?? null : NOW - 60_000,
        nowMs: NOW,
      }),
      readQueenFeedback: async () => {
        if (opts.readThrows) throw new Error('coord down');
        return opts.feedback;
      },
      ackQueenFeedback: async (items) => {
        seen.acked.push(items);
      },
      runCycle:
        opts.runCycle ??
        (async ({ queenFeedback }) => {
          seen.cycleRan = true;
          seen.threaded = queenFeedback;
          return { provenance: [], costUsd: 0.2 };
        }),
      persistRouted: async () => {},
      recordFire: async () => {},
      newCycleId: () => 'cyc-qf',
    };
    return { deps, seen };
  }

  it('fires out-of-cadence past the floor, threads feedback into runCycle, acks on success', async () => {
    const fb = [item('scout-a-2026-06-20')];
    const { deps, seen } = depsWithFeedback({ feedback: fb, lastRunAtMs: NOW - 60_000 });
    const r = await runScoutTick(deps, { cadence: { minIntervalSec: 3600 } });
    expect(r.fired).toBe(true);
    expect(r.reason).toBe('queen-feedback');
    expect(seen.cycleRan).toBe(true);
    expect(seen.threaded).toEqual(fb);
    expect(seen.acked).toEqual([fb]); // acked exactly once, on success
  });

  it('does NOT ack when the revision cycle throws (feedback re-fires next tick)', async () => {
    const fb = [item('scout-b-2026-06-20')];
    const { deps, seen } = depsWithFeedback({
      feedback: fb,
      runCycle: async () => {
        throw new Error('llm down');
      },
    });
    const r = await runScoutTick(deps);
    expect(r.fired).toBe(false);
    expect(r.reason).toBe('cycle-error');
    expect(seen.acked).toEqual([]); // NOT acked → retried next tick
  });

  it('no feedback → normal cadence; nothing threaded, nothing acked', async () => {
    const { deps, seen } = depsWithFeedback({ feedback: [], idleRatio: 1, lastRunAtMs: null });
    const r = await runScoutTick(deps);
    expect(r.fired).toBe(true);
    expect(r.reason).toBe('idle-capacity'); // NOT queen-feedback
    expect(seen.threaded).toBeUndefined(); // ctx.queenFeedback not passed when empty
    expect(seen.acked).toEqual([]);
  });

  it('a throwing readQueenFeedback is swallowed — falls back to normal cadence', async () => {
    const { deps } = depsWithFeedback({ feedback: [item('x-2026-06-20')], readThrows: true, lastRunAtMs: NOW - 60_000 });
    const r = await runScoutTick(deps, { cadence: { minIntervalSec: 3600 } });
    // the read threw → no feedback → the 1m-ago run is gated by the floor
    expect(r.fired).toBe(false);
    expect(r.reason).toBe('min-interval');
  });

  it('records queen-feedback in the tick observability row', async () => {
    const fb = [item('scout-c-2026-06-20')];
    const ticks: import('./tick-ledger').ScoutTickRecord[] = [];
    const { deps } = depsWithFeedback({ feedback: fb });
    deps.recordTick = async (rec) => {
      ticks.push(rec);
    };
    await runScoutTick(deps, { cadence: { minIntervalSec: 3600 } });
    const ran = ticks.find((t) => t.status === 'ran');
    expect(ran?.detail?.reason).toBe('queen-feedback');
    expect(ran?.detail?.queenFeedbackCount).toBe(1);
  });
});
