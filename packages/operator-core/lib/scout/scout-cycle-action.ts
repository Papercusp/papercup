/**
 * scout-cycle-action.ts — Scout P-008: the `system:scout-cycle` routine action —
 * the autonomous cadence PRIMITIVE (resolves b6c3f's invariants-contract Risk A).
 *
 * A `routines` row with `trigger_kind='cron'` + `target_role='system:scout-cycle'`
 * ticks FREQUENTLY (provisioned INACTIVE per-hive at hive:create —
 * lib/hive/provision-learning-loop.ts). On each tick the
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
import { scoutWorkspaceCeilingGate } from '../learning-governor/scout-ceiling';
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
  // The boot path (registerScoutCycleAction) wires recordScoutTickToGovernor +
  // workspaceCeilingGate.
  recordGovernor?: typeof recordScoutTickToGovernor,
  // P-051: the workspace-wide scout spend ceiling preflight. Same PG-free
  // contract — unwired in unit tests, wired at boot.
  workspaceCeilingGate?: typeof scoutWorkspaceCeilingGate,
) {
  return async function scoutCycleAction(ctx: SystemActionCtx): Promise<void> {
    // Owner idle-activity toggle (queen-steering-panel P-006): the owner can gate
    // Scout idea-grading OFF for the home hive. Fail-soft → runs (default ON).
    const { idleActivityAllowed } = await import('../owner-steering');
    if (!(await idleActivityAllowed(ctx.workspaceId, 'scout'))) {
      // eslint-disable-next-line no-console
      console.log(`[scout-cycle] ${ctx.installSlug}: skipped — owner idle-activity toggle (scout) is OFF`);
      return;
    }
    // P-015 (domain-generic-hive-architecture-2026-06-18 / D-005): layer the hive's
    // settings-resident STRUCTURED scout delta (hive_settings.localBlueprint.scout)
    // onto the routine payload's `scout` block, so the per-hive scout tuning the owner
    // sets in /settings/hive-customization reaches the cycle — run.ts reads
    // payload.scout → parseScoutConfigBlock → resolveScoutConfig. The per-hive scout
    // routine ticks under the hive's HOME install_slug (provision-learning-loop.ts), so
    // ctx.installSlug IS the hive home slug (the hive_settings scope). Fail-soft: any
    // read failure (no hive row / PG down) ⇒ the payload is used unchanged — so this is
    // behavior-neutral when no per-hive scout delta is set (the common case) and never
    // breaks a tick. Shallow per-section merge: a hive delta section overrides the
    // payload's (today the payload carries no scout block, so the delta layers over the
    // engine defaults — exactly the D-005 per-hive-over-default intent).
    let payloadTemplate = ctx.payloadTemplate;
    try {
      const { getHiveLocalBlueprintConfig } = await import('../hive-settings-store');
      let delta = await getHiveLocalBlueprintConfig(ctx.workspaceId, ctx.installSlug, 'scout');
      // WORKSPACE-scoped scout (WORKSPACE_COORDINATION ON): ctx.installSlug is the
      // workspace SENTINEL — not a hive, so it has no hive_settings row and a per-hive
      // scout override could NEVER apply (the owner's gpt-5.4 model config sat unread
      // on the home hive while scout ran engine defaults, 2026-07-01). Fall back to
      // the HOME hive's row — the same resolution the Queen's steering uses. Fail-soft
      // like the primary read.
      if (delta == null) {
        try {
          const [{ resolveHiveHomeSlug }, { operatorHomeHarnessSlug }] = await Promise.all([
            import('../hive/wake'),
            import('../harness/operator-home-harness'),
          ]);
          const home = resolveHiveHomeSlug(null, null) ?? operatorHomeHarnessSlug();
          if (home && home !== ctx.installSlug) {
            delta = await getHiveLocalBlueprintConfig(ctx.workspaceId, home, 'scout');
          }
        } catch {
          /* home resolution unavailable → defaults, as before */
        }
      }
      if (delta && typeof delta === 'object' && !Array.isArray(delta)) {
        const base = (payloadTemplate ?? {}) as Record<string, unknown>;
        const baseScout =
          base.scout && typeof base.scout === 'object' && !Array.isArray(base.scout)
            ? (base.scout as Record<string, unknown>)
            : {};
        payloadTemplate = { ...base, scout: { ...baseScout, ...(delta as Record<string, unknown>) } };
      }
    } catch {
      // hive_settings unavailable → use the routine payload as-is (behavior-neutral).
    }

    const result = await runScoutCycleTick(
      { workspaceId: ctx.workspaceId, installSlug: ctx.installSlug, payloadTemplate },
      {
        runCycle,
        buildDeps,
        ...(recordGovernor ? { recordGovernor } : {}),
        ...(workspaceCeilingGate ? { workspaceCeilingGate } : {}),
      },
    );

    if (result.fired) {
      // eslint-disable-next-line no-console
      console.log(
        `[scout-cycle] ${ctx.installSlug}: fired (${result.reason}) cycle=${result.cycleId} routed=${result.routedCount}`,
      );
    } else if (result.reason === 'cycle-error') {
      // eslint-disable-next-line no-console
      console.warn(`[scout-cycle] ${ctx.installSlug}: cycle error — ${result.error}`);
    } else if (result.reason === 'workspace-ceiling') {
      // eslint-disable-next-line no-console
      console.warn(
        `[scout-cycle] ${ctx.installSlug}: refused — workspace-wide scout spend ceiling reached (P-051)`,
      );
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
    // Wire BOTH governor seams at boot: the post-tick spend mirror
    // (recordScoutTickToGovernor) and the P-051 workspace-wide ceiling preflight
    // (scoutWorkspaceCeilingGate). Both flag-gated + best-effort/fail-open.
    makeScoutCycleAction(runCycle, undefined, recordScoutTickToGovernor, scoutWorkspaceCeilingGate),
  );
}
