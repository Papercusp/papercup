/**
 * scout-cycle-action.test.ts — Scout P-008 system:scout-cycle action.
 * Pins: payload-config parsing, the self-gated handler (fires+persists vs no-op),
 * and registration into the routines system-action registry. The deps-builder is
 * faked so the handler runs with no PG (the runScoutTick core is covered in
 * scheduler.test.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  parseScoutCycleConfig,
  makeScoutCycleAction,
  registerScoutCycleAction,
  SCOUT_CYCLE_ACTION,
  type ScoutTickDepsBuilder,
} from './scout-cycle-action';
import { listSystemActions, getSystemAction, type SystemActionCtx } from '../harness/routines/system-actions';
import type { ScoutCadenceState } from './cadence';

const NOW = Date.parse('2026-06-08T12:00:00Z');
const ctx: SystemActionCtx = { installSlug: 'papercup', workspaceId: 'w', triggerConfig: {}, payloadTemplate: null };

describe('parseScoutCycleConfig', () => {
  it('extracts cadence + budget objects', () => {
    expect(parseScoutCycleConfig({ cadence: { minIntervalSec: 100 }, budget: { maxCostUsd: 2 } })).toEqual({
      cadence: { minIntervalSec: 100 },
      budget: { maxCostUsd: 2 },
    });
  });
  it('null / non-object / wrong-typed fields → {}', () => {
    expect(parseScoutCycleConfig(null)).toEqual({});
    expect(parseScoutCycleConfig({ cadence: 'nope', budget: 5 })).toEqual({});
    expect(parseScoutCycleConfig({ cadence: [1, 2] })).toEqual({});
  });
});

describe('makeScoutCycleAction', () => {
  function fakeBuilder(state: Partial<ScoutCadenceState>, calls: { ran: number; persisted: number }): ScoutTickDepsBuilder {
    return (depsCtx, runCycle) => ({
      readCadenceState: async () => ({ idleRatio: 0, frictionSignals: 0, lastRunAtMs: null, nowMs: NOW, ...state }),
      runCycle: async ({ budget, cycleId }) => {
        calls.ran += 1;
        return runCycle({ harnessSlug: depsCtx.installSlug, workspaceId: depsCtx.workspaceId, budget, cycleId });
      },
      persistRouted: async () => { calls.persisted += 1; },
      recordFire: async () => {},
      refreshOutcomes: async () => {},
      newCycleId: () => 'cyc',
    });
  }

  it('fires + persists when the gate says fire (idle)', async () => {
    const calls = { ran: 0, persisted: 0 };
    const runCycle = async () => ({ provenance: [{ ideaId: 'i', lens: 'analogical' as const, rail: 'gym' as const, routedRef: 'gym:1' }], costUsd: 0.1 });
    const handler = makeScoutCycleAction(runCycle, fakeBuilder({ idleRatio: 1 }, calls));
    await handler(ctx);
    expect(calls.ran).toBe(1);
    expect(calls.persisted).toBe(1);
  });

  it('no-ops (no cycle, no persist) when the cadence gate withholds', async () => {
    const calls = { ran: 0, persisted: 0 };
    const handler = makeScoutCycleAction(async () => ({ provenance: [] }), fakeBuilder({ idleRatio: 0, lastRunAtMs: NOW - 60_000 }, calls));
    await handler({ ...ctx, payloadTemplate: { cadence: { minIntervalSec: 3600 } } });
    expect(calls.ran).toBe(0);
    expect(calls.persisted).toBe(0);
  });
});

describe('registerScoutCycleAction', () => {
  it('registers system:scout-cycle in the routines registry', () => {
    registerScoutCycleAction(async () => ({ provenance: [] }));
    expect(listSystemActions()).toContain(SCOUT_CYCLE_ACTION);
    expect(getSystemAction(SCOUT_CYCLE_ACTION)).toBeTypeOf('function');
  });
});
