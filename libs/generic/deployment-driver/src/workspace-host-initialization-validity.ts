import type { WorkspaceHostLifecycleAction } from "./workspace-host-types";

/**
 * The lifecycle actions that REPLACE A HOST'S BOOT DISK, and therefore discard everything
 * the initialization leg installed on it.
 *
 * This exists because the lifecycle runner's completion branch is generic across every
 * action: it reports `succeeded` when the PROVIDER steps finish, which describes the cloud
 * mutation and says nothing about whether the host can serve. For most actions those two
 * things coincide — a `stop` is complete when the instance is stopped. For these two they
 * do not:
 *
 *   - `upgrade` deletes and recreates the instance from the new image, retaining only the
 *     data disk. The boot disk — and every file initialization wrote to it — is gone.
 *   - `restore` plans through the same path as `provision` (it must create a DISTINCT
 *     target host), so the recovered host has never been initialized at all.
 *
 * Initialization is a SEPARATE operation (`runWorkspaceHostInitialization`), and it is
 * sequenced by the caller rather than chained by the provider — deliberately, because it
 * needs credential delivery and a concrete capability-declaring host adapter that a
 * provider-generic lifecycle runner does not have. That design is fine; what was missing
 * is that nothing TOLD the caller a second operation had become mandatory. An operator
 * reading `succeeded | 100 | "Workspace-host upgrade completed"` has no way to know the
 * host cannot serve yet.
 *
 * Keep this list here, beside the action vocabulary it is derived from, rather than
 * re-deciding it at each call site. It is one fact about what these actions do to a disk,
 * and every provider and route must read the same copy of it.
 */
export const WORKSPACE_HOST_INITIALIZATION_INVALIDATING_ACTIONS = [
  "upgrade",
  "restore",
] as const satisfies readonly WorkspaceHostLifecycleAction[];

export type WorkspaceHostInitializationInvalidatingAction =
  (typeof WORKSPACE_HOST_INITIALIZATION_INVALIDATING_ACTIONS)[number];

/**
 * Does completing `action` leave the host unable to serve until initialization runs again?
 *
 * ⛔ Do NOT answer this by asking the provider for health instead. `attestHealth` cannot
 * stand in for it: on the GCP path `agentOnline` has no producer, so a healthy host attests
 * `unknown` (WI-2143924 made that honest; it did not give the field a producer). Gating a
 * lifecycle completion on `healthy` would convert a premature success into a permanent
 * hang — strictly worse than the bug being fixed. This predicate answers from what the
 * action DID, which is knowable without probing the host at all.
 */
export function workspaceHostActionInvalidatesInitialization(
  action: string,
): action is WorkspaceHostInitializationInvalidatingAction {
  return (WORKSPACE_HOST_INITIALIZATION_INVALIDATING_ACTIONS as readonly string[]).includes(action);
}
