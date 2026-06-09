/**
 * scheduler.test.ts — Scout P-008 runScoutTick composition.
 * Pins: cadence-gating, fire-gate short-circuit, budgeted-cycle run, provenance
 * persistence, outcome refresh, fire-state recording, tick observability
 * (P-034 — one scout_ticks record per tick, gated/ran/error, best-effort), and
 * the prompt-free autonomy (the cycle is driven purely by injected deps — no
 * human in the loop).
 */
import { describe, it, expect, vi } from 'vitest';
import { runScoutTick, type ScoutTickDeps, type ScoutCycleLike } from './scheduler';
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
