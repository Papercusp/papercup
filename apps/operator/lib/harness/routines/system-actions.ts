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
 */

export interface SystemActionCtx {
  /** Harness slug (routines.install_slug). */
  installSlug: string;
  /** Owning workspace (routines.workspace_id); the call already runs inside its ALS scope. */
  workspaceId: string;
  /** The routine's trigger_config (e.g. `{ cron, push, push_submodules, merge_strategy }`). */
  triggerConfig: Record<string, unknown>;
  /** The routine's payload_template, if any. */
  payloadTemplate: Record<string, unknown> | null;
}

export type SystemAction = (ctx: SystemActionCtx) => Promise<void>;

/** The reserved `target_role` prefix that routes a routine to a system action. */
export const SYSTEM_TARGET_PREFIX = 'system:';

const REGISTRY = new Map<string, SystemAction>();

/** Register a `system:<name>` action handler. Idempotent (last registration wins). */
export function registerSystemAction(name: string, fn: SystemAction): void {
  REGISTRY.set(name, fn);
}

/** Look up a registered system action by name (the part after `system:`). */
export function getSystemAction(name: string): SystemAction | undefined {
  return REGISTRY.get(name);
}

/** All registered system-action names (diagnostics / tests). */
export function listSystemActions(): string[] {
  return [...REGISTRY.keys()];
}
