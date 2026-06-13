/**
 * `runScoutCycleTick` — the SHARED Scout autonomous-tick orchestration, the single
 * source of truth both the `system:scout-cycle` routine action AND the `scout:cycle`
 * deterministic blueprint step (deterministic-blueprints-migration-2026-06-13 P-121 /
 * D-004) run. Extracting it is what makes the migration provably behavior-neutral:
 * the blueprint path and the routine path build the SAME tick deps, run the SAME
 * self-gated `runScoutTick`, and mirror the SAME governor sub-budget.
 *
 * Scout is NOT a flag+governor-preflight loop (negative-space / regret / transfer /
 * ablation are). Its gate is STRUCTURAL and lives INSIDE the tick (`runScoutTick`):
 * cadence (idle-capacity OR friction) → the autoloop fire-gate (backoff/circuit) →
 * single-flight claim → budget. Most ticks no-op cheaply; a real (budgeted) cycle
 * fires only when the cadence gate says so. The cron heartbeat is the trigger, NOT
 * the cadence. The learning-governor here is a best-effort POST-tick MIRROR of the
 * per-cycle cap + reported spend (`recordScoutTickToGovernor`), never a preflight
 * refusal — so wrapping is behavior-neutral only when ALL of those gates carry over,
 * which they do because the op builds the SAME production deps the action does.
 *
 * IMPORTANT (D-009): Scout's ideator/critic legs run via the operator `llmCall`
 * client (register-scout-action wires the real llm-testing/llm-client into the cycle
 * deps), NOT fleet agent spawns via spawnInvokeOnce — there is NO spawnInvokeOnce
 * path anywhere in lib/scout. So Scout as a blueprint is a DETERMINISTIC pipeline (a
 * single step whose op runs the self-gated tick), not a `spawn-roles` hybrid, and
 * this migration is behavior-neutral — see D-009.
 *
 * Deps are injectable PARAMETERS — the action passes its own seams (the test pins a
 * fake runCycle + buildDeps; boot wires the production runner + governor recorder),
 * the op defaults to the SAME production runner + deps builder + governor recorder.
 */
import {
  buildScoutTickDeps,
  runScoutTick,
  type ScoutCycleLike,
  type ScoutTickDeps,
  type ScoutTickResult,
} from './scheduler';
import { readHiveIdleRatio, readFrictionSignalCount } from './cadence-signals';
import type { ScoutCadenceOptions } from './cadence';
import { resolveScoutBudget, type ScoutBudget } from './budget';
import type { recordScoutTickToGovernor } from '../learning-governor/registrants';

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

/** The normalized routine ctx the orchestration needs (action + op both supply it). */
export interface ScoutCycleInput {
  workspaceId: string;
  installSlug: string;
  payloadTemplate: Record<string, unknown> | null;
}

/**
 * Build the production {@link ScoutTickDeps} from the routine ctx + a cycle runner:
 * cadence signals (idle ratio + friction) + ledger persistence via
 * {@link buildScoutTickDeps}. Swapped for a fake in unit tests.
 */
export type ScoutTickDepsBuilder = (input: ScoutCycleInput, runCycle: ScoutCycleRunner) => ScoutTickDeps;

export const productionDepsBuilder: ScoutTickDepsBuilder = (input, runCycle) =>
  buildScoutTickDeps({
    harnessSlug: input.installSlug,
    workspaceId: input.workspaceId,
    runCycle: ({ budget, cycleId }) =>
      runCycle({ harnessSlug: input.installSlug, workspaceId: input.workspaceId, budget, cycleId }),
    readIdleRatio: () => readHiveIdleRatio({ workspaceId: input.workspaceId }),
    readFrictionSignals: () => readFrictionSignalCount({ harnessSlug: input.installSlug }),
  });

/**
 * Parse a routine's payload_template into cadence + budget overrides. Unknown keys
 * are ignored; bad shapes fall back to the gate/budget defaults.
 */
export function parseScoutCycleConfig(payload: Record<string, unknown> | null): ScoutCycleActionConfig {
  if (!payload || typeof payload !== 'object') return {};
  const cadence = isObj(payload.cadence) ? (payload.cadence as ScoutCadenceOptions) : undefined;
  const budget = isObj(payload.budget) ? (payload.budget as ScoutBudget) : undefined;
  return { ...(cadence ? { cadence } : {}), ...(budget ? { budget } : {}) };
}

export interface ScoutCycleDeps {
  /** The per-harness cycle runner (built from cb4b9's runScoutCycle + ports). Required. */
  runCycle: ScoutCycleRunner;
  /** Tick-deps builder (default = the production wiring). */
  buildDeps?: ScoutTickDepsBuilder;
  /** Best-effort governor sub-budget mirror (boot wires recordScoutTickToGovernor). */
  recordGovernor?: typeof recordScoutTickToGovernor;
}

/**
 * One autonomous Scout tick behind its structural self-gates (cadence → fire-gate →
 * claim → budget, all inside {@link runScoutTick}), then a best-effort governor
 * sub-budget mirror. Returns the tick result so the caller can log. Never depends on
 * a flag or a governor preflight — Scout's gate is the cadence (D-009).
 */
export async function runScoutCycleTick(
  input: ScoutCycleInput,
  deps: ScoutCycleDeps,
): Promise<ScoutTickResult> {
  const cfg = parseScoutCycleConfig(input.payloadTemplate);
  const tickDeps = (deps.buildDeps ?? productionDepsBuilder)(input, deps.runCycle);

  const result = await runScoutTick(tickDeps, {
    ...(cfg.cadence ? { cadence: cfg.cadence } : {}),
    ...(cfg.budget ? { budget: cfg.budget } : {}),
  });

  // FB-01 (self-learning-frontier P-003): mirror scout's per-cycle cap onto the
  // shared learning-governor ledger as its sub-budget + accumulate a fired cycle's
  // reported spend. Flag-gated (papercusp-learning-governor — the kill-switch) and
  // best-effort by contract — it never throws, so governor bookkeeping can never
  // fail (or replay) the tick. No recorder wired ⇒ hermetic (no governor IO).
  if (deps.recordGovernor) {
    await deps.recordGovernor({
      workspaceId: input.workspaceId,
      harnessSlug: input.installSlug,
      perCycleBudgetUsd: resolveScoutBudget(cfg.budget).maxCostUsd,
      fired:
        result.fired && result.costUsd != null
          ? { costUsd: result.costUsd, ...(result.cycleId ? { cycleId: result.cycleId } : {}) }
          : null,
    });
  }

  return result;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
