/**
 * `scout:cycle` — the Scout autonomous-ideation cadence as a DETERMINISTIC blueprint
 * step (deterministic-blueprints-migration-2026-06-13 P-121).
 *
 * Scout proposes → the Queen gates → agents build → the owner gets a report. One
 * tick gates STRUCTURALLY inside `runScoutTick`: cadence (idle-capacity OR friction)
 * → the autoloop fire-gate (backoff/circuit) → single-flight claim → budget; most
 * ticks no-op cheaply, a real (budgeted) cycle fires only when the cadence gate says
 * so. This op WRAPS the shared `runScoutCycleTick` orchestration (the SAME deps the
 * `system:scout-cycle` routine builds — the production cycle runner, signals, P-013
 * ledger, and the best-effort governor sub-budget mirror) so the migration is
 * behavior-neutral (D-004): same cadence gate, same budget, same governor mirror,
 * same tick.
 *
 * The cycle's ideator/critic legs run via the operator `llmCall` client (NOT a fleet
 * spawn via spawnInvokeOnce — there is NO spawnInvokeOnce path in lib/scout — D-009),
 * so Scout is structurally a DETERMINISTIC pipeline (a single step), NOT a
 * `spawn-roles` hybrid. Scout is NOT flag-gated: its arming is the routine `active`
 * bit + the cadence gate, NOT a frontier flag — so there is no flag-off skip path.
 */
import { z } from 'zod';
import type { CoordOp } from '../../coord-ops/types.js';
import { registerCoordOp } from '../../coord-ops/registry.js';
import { runScoutCycleTick, type ScoutCycleDeps } from '../../scout/run.js';

/** Declared input I/O — the cadence + budget overrides (the routine's payload knobs). */
const args = z.object({
  /** Cadence overrides (minIntervalSec / idleThreshold / frictionThreshold). */
  cadence: z
    .object({
      minIntervalSec: z.number().nonnegative().optional(),
      idleThreshold: z.number().optional(),
      frictionThreshold: z.number().optional(),
    })
    .passthrough()
    .optional(),
  /** Per-cycle budget overrides (maxCostUsd / maxIdeators / maxCriticsPerIdea). */
  budget: z
    .object({
      maxCostUsd: z.number().nonnegative().optional(),
      maxIdeators: z.number().int().nonnegative().optional(),
      maxCriticsPerIdea: z.number().int().nonnegative().optional(),
    })
    .passthrough()
    .optional(),
});

/** Declared output I/O — the tick result (a fired cycle or the self-gate that withheld it). */
const result = z.object({
  /** True iff a budgeted cycle fired (all self-gates passed). */
  fired: z.boolean(),
  /** Cadence reason when fired/withheld, or 'circuit'/'claim-lost'/'cycle-error'. */
  reason: z.string(),
  cycleId: z.string().optional(),
  routedCount: z.number().int().optional(),
  costUsd: z.number().optional(),
  retryAfterSec: z.number().optional(),
  error: z.string().optional(),
});

/**
 * Test seam — inject the cycle runner / deps-builder / governor recorder (mirrors the
 * action's seams). `null` ⇒ the production wiring (the same runner the boot path
 * registers + recordScoutTickToGovernor), resolved lazily so a hermetic process that
 * only loads this op never pulls the llm/cycle graph.
 */
let _deps: ScoutCycleDeps | null = null;
export function setScoutCycleDeps(deps: ScoutCycleDeps | null): void {
  _deps = deps;
}

export const scoutCycleOp: CoordOp<z.infer<typeof args>, z.infer<typeof result>> = {
  name: 'scout:cycle',
  description:
    'Deterministic step: run one cadence-gated, budgeted Scout ideation cycle (idle/friction-gated; ideator → critic → route to plans/gym/improvements) — the autonomous-ideation cadence primitive.',
  argsSchema: args,
  resultSchema: result,
  async run(a, ctx) {
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) throw new Error('scout:cycle requires ctx.workspaceId');
    const installSlug = ctx.harnessSlug ?? 'op';

    // Default to the SAME production wiring the boot path registers
    // (register-scout-action.ts): the real llmCall-backed cycle runner + the
    // governor sub-budget mirror — so the blueprint path is byte-for-byte the
    // routine path (behavior-neutral, D-004). Lazy: only when no test deps wired.
    let deps = _deps;
    if (!deps) {
      const [{ productionScoutRunner }, { recordScoutTickToGovernor }] = await Promise.all([
        import('../../scout/register-scout-action.js'),
        import('../../learning-governor/registrants.js'),
      ]);
      deps = { runCycle: productionScoutRunner, recordGovernor: recordScoutTickToGovernor };
    }

    const tick = await runScoutCycleTick(
      { workspaceId, installSlug, payloadTemplate: (a as Record<string, unknown>) ?? null },
      deps,
    );
    ctx.log?.(
      `scout:cycle fired=${tick.fired} reason=${tick.reason}` +
        (tick.cycleId ? ` cycle=${tick.cycleId}` : '') +
        (tick.routedCount != null ? ` routed=${tick.routedCount}` : ''),
    );
    return {
      fired: tick.fired,
      reason: tick.reason,
      cycleId: tick.cycleId,
      routedCount: tick.routedCount,
      costUsd: tick.costUsd,
      retryAfterSec: tick.retryAfterSec,
      error: tick.error,
    };
  },
};

registerCoordOp(scoutCycleOp);
