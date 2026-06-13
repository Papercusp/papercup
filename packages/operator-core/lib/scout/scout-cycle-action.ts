/**
 * scout-cycle-action.ts — Scout P-008: the `system:scout-cycle` routine action —
 * the autonomous cadence PRIMITIVE (resolves b6c3f's invariants-contract Risk A).
 *
 * A `routines` row with `trigger_kind='cron'` + `target_role='system:scout-cycle'`
 * ticks FREQUENTLY (seed-scout-routine seeds it inactive). On each tick the
 * routines engine runs THIS handler inline (one durable DBOS step), which calls
 * {@link runScoutTick} — and runScoutTick SELF-GATES on {@link shouldRunScoutCycle}
 * (idle capacity OR friction) + the budget + the autoloop fire-gate. So the
 * effective cadence is idle/friction-triggered even though the trigger is a cron:
 * most ticks no-op cheaply, a real (budgeted) cycle fires only when the gate says
 * so. That is the "system: action that gates on idle capacity" Risk A asked for —
 * a bare cron is NOT the plan's cadence; this gate is.
 *
 * Decoupled from cb4b9's `cycle-deps`: the per-harness cycle runner is INJECTED
 * ({@link ScoutCycleRunner}), so this handler unit-tests with a fake runner and
 * the production registration (wiring cb4b9's runScoutCycle + its ports) is a
 * one-line {@link registerScoutCycleAction} call at boot. Idempotent/re-runnable
 * (the routines engine replays a handler on crash): a no-fire tick is a no-op, and
 * recordRoutedIdea upserts.
 */

import { registerSystemAction, type SystemActionCtx } from '../harness/routines/system-actions';
import { recordScoutTickToGovernor } from '../learning-governor/registrants';
import {
  runScoutCycleTick,
  parseScoutCycleConfig,
  productionDepsBuilder,
  type ScoutCycleRunner,
  type ScoutTickDepsBuilder,
  type ScoutCycleActionConfig,
} from './run';

/**
 * The cadence-gated tick orchestration this action runs is SHARED with the
 * `scout:cycle` deterministic blueprint step via `runScoutCycleTick`
 * (deterministic-blueprints-migration-2026-06-13 P-121 / D-004 — provably
 * behavior-neutral: one self-gated tick, two callers, the SAME production deps).
 * Re-exported here so the action's existing test contract (which imports them from
 * this module) keeps working.
 */
export {
  parseScoutCycleConfig,
  type ScoutCycleRunner,
  type ScoutTickDepsBuilder,
  type ScoutCycleActionConfig,
};

/** The action name; a routine targets it via `target_role: 'system:scout-cycle'`. */
export const SCOUT_CYCLE_ACTION = 'scout-cycle';

/**
 * Build the `system:scout-cycle` handler from an injected per-harness cycle
 * runner. The handler wires the production cadence signals + the P-013 ledger via
 * {@link productionDepsBuilder}, then runs one self-gated tick (via the shared
 * {@link runScoutCycleTick}). `buildDeps` is an injection seam for unit tests
 * (default = production wiring).
 */
export function makeScoutCycleAction(
  runCycle: ScoutCycleRunner,
  buildDeps: ScoutTickDepsBuilder = productionDepsBuilder,
  // No production default ON PURPOSE: this factory's unit-test contract is
  // PG-free (see the header), and the real glue resolves the live admin pool.
  // The boot path (registerScoutCycleAction) wires recordScoutTickToGovernor.
  recordGovernor?: typeof recordScoutTickToGovernor,
) {
  return async function scoutCycleAction(ctx: SystemActionCtx): Promise<void> {
    const result = await runScoutCycleTick(
      { workspaceId: ctx.workspaceId, installSlug: ctx.installSlug, payloadTemplate: ctx.payloadTemplate },
      { runCycle, buildDeps, ...(recordGovernor ? { recordGovernor } : {}) },
    );

    if (result.fired) {
      // eslint-disable-next-line no-console
      console.log(
        `[scout-cycle] ${ctx.installSlug}: fired (${result.reason}) cycle=${result.cycleId} routed=${result.routedCount}`,
      );
    } else if (result.reason === 'cycle-error') {
      // eslint-disable-next-line no-console
      console.warn(`[scout-cycle] ${ctx.installSlug}: cycle error — ${result.error}`);
    }
    // A withheld tick (min-interval / no-trigger / circuit) is the common, silent no-op.
  };
}

/**
 * Register `system:scout-cycle` with the routines engine, wiring the given
 * per-harness cycle runner (built from cb4b9's runScoutCycle + its ports). Call
 * once at boot (alongside the other registerSystemAction calls). Last wins.
 */
export function registerScoutCycleAction(runCycle: ScoutCycleRunner): void {
  registerSystemAction(
    SCOUT_CYCLE_ACTION,
    makeScoutCycleAction(runCycle, undefined, recordScoutTickToGovernor),
  );
}
