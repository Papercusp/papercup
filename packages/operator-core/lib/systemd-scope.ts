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

/** Shared per-agent scope budget. Headless fleet members and orchestrated agent
 * turns are the same resource shape, so they must resolve the same override and
 * default instead of drifting into capped vs uncapped launch paths. */
export function agentSpawnScopeMemoryMaxG(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PAPERCUSP_AGENT_SPAWN_MEMORY_MAX_G);
  return Number.isFinite(raw) && raw > 0 ? raw : 6;
}

/** Per-fork vitest heap budget (GiB) — one fork's `--max-old-space-size` worth. */
const CHECKPOINT_FORK_HEAP_G = 4;

/** Fixed scope overhead (GiB): tsx/npm plus the testcontainers helpers, and headroom. */
const CHECKPOINT_SCOPE_OVERHEAD_G = 8;

/** Vitest fork count per capacity mode. MUST track `GREEN_CHECKPOINT_MAX_FORKS` /
 * `GREEN_CHECKPOINT_RESERVED_MAX_FORKS` in apps/operator/lib/release/green-checkpoint.ts.
 * Duplicated rather than imported because operator-core is the LOWER layer; the
 * release-actions-memory-cap test pins these values to the real constants. */
export const CHECKPOINT_FORKS_BY_MODE = { shared: 2, reserved: 8 } as const;

/** Memory cap (GiB) for an isolated green-checkpoint scope.
 *
 * Derive the cap from the fork count so the scheduled gate and detached manual
 * launcher share one policy. The cap keeps a suite's reclaim/OOM inside its own
 * cgroup instead of allowing it to pressure the operator host. */
export function checkpointScopeMemoryMaxG(env: NodeJS.ProcessEnv = process.env): number {
  const mode = env.PAPERCUSP_GREEN_CHECKPOINT_CAPACITY_MODE === 'reserved' ? 'reserved' : 'shared';
  return CHECKPOINT_SCOPE_OVERHEAD_G + CHECKPOINT_FORKS_BY_MODE[mode] * CHECKPOINT_FORK_HEAP_G;
}

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

/**
 * The NAMED variant (task-manager-no-escape-2026-07-27, P-005).
 *
 * Same mechanism as {@link buildIsolatedScopeArgv} — a transient `--scope`, so the
 * payload stays our child with stdio piped — but with the two additions the task
 * manager is built on:
 *
 *   `--unit=<name>`   the scope carries the LEDGER KEY in its own name, which is
 *                     what turns reconciliation into a string join instead of a
 *                     cmdline heuristic, and what makes a subtree kill addressable
 *                     (`systemctl --user kill <unit>`) without ever touching a pid.
 *   `--slice=<name>`  everything we launch lands under one root slice, so the
 *                     scanner can enumerate ALL descendants — including grandchildren
 *                     that double-forked and reparented — by walking one cgroup tree.
 *
 * Budgets are per-scope systemd properties rather than anything we police: a
 * `RuntimeMaxSec` deadline is enforced by systemd even if the operator dies, which
 * a timer of ours could never promise.
 */
export interface TaskScopeProperties {
  unit: string;
  slice: string;
  /** Environment explicitly bound to a transient SERVICE. A service is not a
   * child of the launching process, so it cannot inherit the caller's env. */
  env?: Readonly<Record<string, string | undefined>>;
  memoryMaxBytes?: number | null;
  cpuWeight?: number | null;
  tasksMax?: number | null;
  runtimeMaxSec?: number | null;
  /**
   * EI-21229453838112711 — the directory the PAYLOAD runs in. Only a transient
   * SERVICE needs this. A `--scope` payload is forked from the systemd-run
   * client and inherits its cwd, so the scope path is already correct and
   * deliberately ignores this field; a service is started by the user manager
   * instead, whose WorkingDirectory defaults to $HOME. Spawning with
   * `{ cwd }` sets it for the systemd-run CLIENT and has no effect on a service
   * payload, so without this the job silently runs in the home directory.
   */
  workingDirectory?: string | null;
  /** Extra `--property=K=V` pairs; escape hatch for a one-off, kept last. */
  extraProperties?: readonly string[];
}

function appendTaskProperties(argv: string[], props: TaskScopeProperties): void {
  if (props.memoryMaxBytes && props.memoryMaxBytes > 0) {
    argv.push(`--property=MemoryMax=${Math.floor(props.memoryMaxBytes)}`);
    // Swap-thrash IS the event-loop freeze (50-cgroup-memory.conf) — a task allowed
    // to swap does not fail fast, it wedges the whole box while appearing alive.
    argv.push('--property=MemorySwapMax=0');
  }
  if (props.cpuWeight && props.cpuWeight > 0) {
    argv.push(`--property=CPUWeight=${Math.floor(props.cpuWeight)}`);
  }
  if (props.tasksMax && props.tasksMax > 0) {
    argv.push(`--property=TasksMax=${Math.floor(props.tasksMax)}`);
  }
  if (props.runtimeMaxSec && props.runtimeMaxSec > 0) {
    argv.push(`--property=RuntimeMaxSec=${Math.floor(props.runtimeMaxSec)}`);
  }
  for (const p of props.extraProperties ?? []) argv.push(`--property=${p}`);
}

function appendTaskEnvironment(argv: string[], env: TaskScopeProperties['env']): void {
  for (const [name, value] of Object.entries(env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (value !== undefined) argv.push(`--setenv=${name}=${value}`);
  }
}

export function buildTaskScopeArgv(base: string[], props: TaskScopeProperties): string[] {
  const argv = [
    'systemd-run',
    '--user',
    '--scope',
    '--quiet',
    // --collect: a failed transient unit is garbage-collected instead of lingering
    // in `systemctl --user list-units` as a permanent phantom the scanner would
    // then have to special-case.
    '--collect',
    `--unit=${props.unit}`,
    `--slice=${props.slice}`,
  ];
  appendTaskProperties(argv, props);
  argv.push(...base);
  return argv;
}

/**
 * Build a named transient SERVICE argv. systemd-run uses service mode by
 * default, so there is intentionally no `--service` flag: on the supported CLI
 * that token is parsed as the `--service-type` abbreviation and makes launch
 * fail. `--pipe --wait` preserves the synchronous seam's stdio/exit contract
 * while the service unit remains owned by the user manager if this client dies.
 */
export function buildTaskServiceArgv(base: string[], props: TaskScopeProperties): string[] {
  const argv = [
    'systemd-run',
    '--user',
    '--pipe',
    '--wait',
    '--quiet',
    '--collect',
    `--unit=${props.unit}`,
    `--slice=${props.slice}`,
    // EI-21192501620501693: make the subtree cleanup contract explicit instead
    // of inheriting systemd's defaults. A test runner can print its terminal
    // summary and let its main shell exit while leaked workers remain. The
    // transient SERVICE owns that whole control group, terminates every member
    // when the main process exits, and escalates within a bounded window rather
    // than leaving a terminal task consuming the host indefinitely.
    '--property=KillMode=control-group',
    '--property=TimeoutStopSec=10s',
  ];
  // EI-21229453838112711: a transient service is started by the USER MANAGER,
  // not forked from this client, so it does not inherit our cwd — systemd
  // defaults its WorkingDirectory to $HOME. Every `npm run …` backgrounded
  // through capability:bash therefore died with an ENOENT on the repo's
  // package.json while REPORTING the project dir, which reads as a clean pass.
  // Deliberately NOT the `-` (tolerate-missing) form: falling back to $HOME is
  // precisely the silent failure this exists to stop, so an unusable directory
  // must fail the unit loudly instead.
  if (props.workingDirectory) {
    argv.push(`--working-directory=${props.workingDirectory}`);
  }
  appendTaskEnvironment(argv, props.env);
  appendTaskProperties(argv, props);
  argv.push(...base);
  return argv;
}
