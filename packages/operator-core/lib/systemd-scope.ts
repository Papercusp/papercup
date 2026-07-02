/**
 * systemd-scope — the pure `systemd-run --user --scope` argv-builder shared by every
 * spawn seam that isolates a payload into its own memory-capped cgroup instead of
 * running inside the launching process's own cgroup.
 *
 * Extracted from `harness/routines/release-actions.ts` (the original green-checkpoint
 * precedent, release-gate-ready-branch-2026-06-04 / the 2026-07-01 40G OOM crash-loop
 * fix) so a SECOND call-site — the per-agent-turn spawn seam in `dbos/orchestrator-runner.ts`
 * (bg-host-agent-spawn-scope-isolation-2026-07-02, WI-1499) — can reuse the exact same
 * mechanism without importing `release-actions.ts` (which registers a system action as a
 * module-level side effect and would be a backwards dependency for the core spawn
 * chokepoint to carry). `release-actions.ts` re-exports `buildIsolatedScopeArgv` from here
 * for backward compatibility with its existing test import.
 */

/** systemd-run launch failures that mean "the SCOPE could not start" (no bus, no
 *  binary, no permission) — retry the payload DIRECT rather than failing the caller.
 *  A payload failure inside a healthy scope must NOT match (it exits with the
 *  payload's own code/stderr, usually well past the launch window). */
export const SCOPE_LAUNCH_FAILURE_RE =
  /Failed to connect to bus|Failed to start transient scope|Interactive authentication required|No such file or directory/i;

/** Build the systemd-run argv that runs `base` in a transient user SCOPE with its own
 *  memory cap. `--scope` (NOT `--unit`): the payload stays OUR CHILD — stdio piped,
 *  process-group kill + full env inheritance intact — but lands in its own cgroup
 *  OUTSIDE the launching service's MemoryMax. MemorySwapMax=0 mirrors the bg-host
 *  policy (50-cgroup-memory.conf: swap-thrash IS the event-loop freeze). */
export function buildIsolatedScopeArgv(base: string[], memoryMaxG: number): string[] {
  return [
    'systemd-run',
    '--user',
    '--scope',
    '--quiet',
    '--collect',
    `--property=MemoryMax=${memoryMaxG}G`,
    '--property=MemorySwapMax=0',
    ...base,
  ];
}
