/**
 * System-action registry for the routines engine (git-sync-auto-commit P-002).
 *
 * A routine whose `target_role` is `system:<action>` is NOT spawned as an agent —
 * the `routinesTick` workflow runs the registered handler **inline, as a single
 * durable DBOS step** (git-sync-auto-commit D-006). This is the seam git-sync (the
 * first consumer) registers into via `registerSystemAction('git-sync', …)`; future
 * per-harness system tasks register here too. Role-target routines take the spawn
 * path instead (see `lib/dbos/routines-workflow.ts`).
 *
 * Handlers run as ONE step, so a crash mid-action replays the whole handler on
 * recovery — handlers must therefore be safe to re-run from the top (git-sync is:
 * commit is a no-op when clean, push is a no-op when up-to-date, merge re-fetches).
 *
 * DURABLE CHILD SPAWNS (EI-403-A): a handler that wants to start a durable child
 * workflow (e.g. the auto-implement lane firing its worker) CANNOT do so from
 * inside its step — `DBOS.startWorkflow` is forbidden from within a step. Instead
 * the handler RETURNS the spawn requests as `SystemActionResult.durableSpawns`;
 * the routine workflow drains them AFTER the step returns, at the workflow layer
 * where `startWorkflow` is legal (see `routines-workflow.ts` →
 * `startDurableSpawns`). Recovery-safe: the step's return value is checkpointed,
 * so on replay the same requests are re-drained and the per-request idempotency
 * key dedups the re-fire. A handler returning `void` is unchanged.
 */
import type { DurableSpawnFireInput } from '../../dbos/durable-spawn';

export interface SystemActionCtx {
  /** Harness slug (routines.install_slug). */
  installSlug: string;
  /** Owning workspace (routines.workspace_id); the call already runs inside its ALS scope. */
  workspaceId: string;
  /** The routine's trigger_config (e.g. `{ cron, push, push_submodules }`). */
  triggerConfig: Record<string, unknown>;
  /** The routine's payload_template, if any. */
  payloadTemplate: Record<string, unknown> | null;
}

/**
 * What a system action MAY return so the routine engine starts durable work on
 * its behalf at the workflow layer (EI-403-A). Returning nothing (`void`) is the
 * common case and changes nothing. An interface (not a bare field) so future
 * post-step engine hooks can be added without re-widening every handler.
 */
export interface SystemActionResult {
  /**
   * Durable child-workflow fires the engine starts AFTER this action's step, from
   * the workflow context (the action cannot start them from inside its own step).
   * Each must carry a STABLE idempotencyKey (derived from durable state, not a
   * clock) so a recovery replay dedups rather than double-fires.
   */
  durableSpawns?: DurableSpawnFireInput[];
}

export type SystemAction = (ctx: SystemActionCtx) => Promise<void | SystemActionResult>;

/** Per-action registration options. */
export interface SystemActionOptions {
  /**
   * WI-1416 (bg-host-freeze-eventloop-stall P-006): the handler manages its OWN
   * `DBOS.runStep` checkpoints (a multi-step action — git-sync is the first). The
   * routine engine must then run it at the WORKFLOW layer, NOT wrapped in the
   * engine's single `system:<action>` step: nested inside a step, `DBOS.runStep`
   * silently degrades to a plain call (isInStep() → direct execution, no
   * operation_output), so the executor reaper would still see an opaque no-progress
   * fire. Such handlers MUST make every sub-step replay-safe — the engine no longer
   * provides the one-big-step "re-run from the top" recovery semantics.
   */
  ownSteps?: boolean;
}

export interface SystemActionEntry {
  fn: SystemAction;
  ownSteps: boolean;
}

/** The reserved `target_role` prefix that routes a routine to a system action. */
export const SYSTEM_TARGET_PREFIX = 'system:';

const REGISTRY = new Map<string, SystemActionEntry>();

/** Register a `system:<name>` action handler. Idempotent (last registration wins). */
export function registerSystemAction(name: string, fn: SystemAction, opts: SystemActionOptions = {}): void {
  REGISTRY.set(name, { fn, ownSteps: opts.ownSteps === true });
}

/** Look up a registered system action by name (the part after `system:`). */
export function getSystemAction(name: string): SystemAction | undefined {
  return REGISTRY.get(name)?.fn;
}

/** Look up the full registry entry (handler + dispatch options). */
export function getSystemActionEntry(name: string): SystemActionEntry | undefined {
  return REGISTRY.get(name);
}

/** All registered system-action names (diagnostics / tests). */
export function listSystemActions(): string[] {
  return [...REGISTRY.keys()];
}
