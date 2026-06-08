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
import { runScoutTick, buildScoutTickDeps, type ScoutCycleLike, type ScoutTickDeps } from './scheduler';
import { readHiveIdleRatio, readFrictionSignalCount } from './cadence-signals';
import type { ScoutCadenceOptions } from './cadence';
import type { ScoutBudget } from './budget';

/** The action name; a routine targets it via `target_role: 'system:scout-cycle'`. */
export const SCOUT_CYCLE_ACTION = 'scout-cycle';

/** Runs ONE budgeted Scout cycle for a harness (wraps cb4b9's runScoutCycle + ports). */
export type ScoutCycleRunner = (ctx: {
  harnessSlug: string;
  workspaceId: string;
  budget: Required<ScoutBudget>;
  cycleId: string;
}) => Promise<ScoutCycleLike>;

export interface ScoutCycleActionConfig {
  cadence?: ScoutCadenceOptions;
  budget?: ScoutBudget;
}

/**
 * Parse a routine's payload_template into cadence + budget overrides. Unknown
 * keys are ignored; bad shapes fall back to the gate/budget defaults.
 */
export function parseScoutCycleConfig(payload: Record<string, unknown> | null): ScoutCycleActionConfig {
  if (!payload || typeof payload !== 'object') return {};
  const cadence = isObj(payload.cadence) ? (payload.cadence as ScoutCadenceOptions) : undefined;
  const budget = isObj(payload.budget) ? (payload.budget as ScoutBudget) : undefined;
  return { ...(cadence ? { cadence } : {}), ...(budget ? { budget } : {}) };
}

/**
 * Build the production {@link ScoutTickDeps} from the routine ctx + a cycle runner:
 * cadence signals (idle ratio + friction) + ledger persistence via
 * {@link buildScoutTickDeps}. Swapped for a fake in unit tests.
 */
export type ScoutTickDepsBuilder = (ctx: SystemActionCtx, runCycle: ScoutCycleRunner) => ScoutTickDeps;

const productionDepsBuilder: ScoutTickDepsBuilder = (ctx, runCycle) =>
  buildScoutTickDeps({
    harnessSlug: ctx.installSlug,
    workspaceId: ctx.workspaceId,
    runCycle: ({ budget, cycleId }) =>
      runCycle({ harnessSlug: ctx.installSlug, workspaceId: ctx.workspaceId, budget, cycleId }),
    readIdleRatio: () => readHiveIdleRatio({ workspaceId: ctx.workspaceId }),
    readFrictionSignals: () => readFrictionSignalCount({ harnessSlug: ctx.installSlug }),
  });

/**
 * Build the `system:scout-cycle` handler from an injected per-harness cycle
 * runner. The handler wires the production cadence signals + the P-013 ledger via
 * {@link buildScoutTickDeps}, then runs one self-gated tick. `buildDeps` is an
 * injection seam for unit tests (default = production wiring).
 */
export function makeScoutCycleAction(
  runCycle: ScoutCycleRunner,
  buildDeps: ScoutTickDepsBuilder = productionDepsBuilder,
) {
  return async function scoutCycleAction(ctx: SystemActionCtx): Promise<void> {
    const cfg = parseScoutCycleConfig(ctx.payloadTemplate);
    const deps = buildDeps(ctx, runCycle);

    const result = await runScoutTick(deps, {
      ...(cfg.cadence ? { cadence: cfg.cadence } : {}),
      ...(cfg.budget ? { budget: cfg.budget } : {}),
    });

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
  registerSystemAction(SCOUT_CYCLE_ACTION, makeScoutCycleAction(runCycle));
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
