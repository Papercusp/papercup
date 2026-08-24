import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/**
 * Keep the CLI's `--collect` spelling, but pin the failure half of its contract
 * explicitly as a unit property. `--collect` is documented as a shortcut for
 * this property on current systemd, while the live user manager has still
 * observed failed transient services with `CollectMode=inactive`; emitting both
 * makes the intended cleanup policy visible and testable at the D-Bus boundary.
 */
export const SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS = [
  '--collect',
  '--property=CollectMode=inactive-or-failed',
] as const;

/** Static, dependency-free runner used after systemd has accepted a payload. */
export const SYSTEMD_ENV_RUNNER_PATH = fileURLToPath(new URL('./systemd-scope-env-runner.mjs', import.meta.url));
/** Credential id is deliberately boring: it is visible to systemd, never a secret. */
export const SYSTEMD_ENV_CREDENTIAL_NAME = 'papercusp-env';

export interface SecretEnvironmentTransport {
  /** `/proc/<operator-pid>/fd/<fd>`; the backing file is unlinked immediately. */
  sourcePath: string;
  /** Close the operator-side reference after the consumer has started. */
  release: () => void;
}

/** Encode the exact replacement environment as NUL-delimited NAME=value records. */
export function encodeSecretEnvironment(env: NodeJS.ProcessEnv): Buffer {
  const records: string[] = [];
  for (const [name, value] of Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (value === undefined) continue;
    if (name.length === 0 || name.includes('=') || name.includes('\0')) continue;
    if (value.includes('\0')) throw new TypeError(`environment value for ${name} contains NUL`);
    records.push(`${name}=${value}`);
  }
  return Buffer.from(records.length ? `${records.join('\0')}\0` : '', 'utf8');
}

/**
 * Create an anonymous, unlinked environment payload. `/dev/shm` is the normal
 * path (tmpfs); the unlinked tmpdir fallback keeps payload data out of argv and
 * journald even on hosts without a usable shared-memory mount.
 */
export function createSecretEnvironmentTransport(env: NodeJS.ProcessEnv): SecretEnvironmentTransport {
  const bytes = encodeSecretEnvironment(env);
  const roots = process.platform === 'linux' && existsSync('/dev/shm') ? ['/dev/shm', tmpdir()] : [tmpdir()];
  let fd: number | null = null;
  let lastError: unknown = null;
  for (const root of roots) {
    const pathname = join(root, `papercusp-env-${process.pid}-${randomUUID()}`);
    try {
      fd = openSync(pathname, 'wx', 0o600);
      unlinkSync(pathname);
      break;
    } catch (error) {
      lastError = error;
      if (fd != null) {
        try { closeSync(fd); } catch { /* best effort */ }
        fd = null;
      }
      try { unlinkSync(pathname); } catch { /* best effort */ }
    }
  }
  if (fd == null) {
    throw lastError instanceof Error ? lastError : new Error('unable to create anonymous environment fd');
  }
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error('anonymous environment fd write made no progress');
      offset += written;
    }
  } catch (error) {
    try { closeSync(fd); } catch { /* best effort */ }
    throw error;
  }
  let released = false;
  return {
    sourcePath: `/proc/${process.pid}/fd/${fd}`,
    release: () => {
      if (released) return;
      released = true;
      try { closeSync(fd!); } catch { /* already closed */ }
    },
  };
}

function environmentRunnerPayload(base: readonly string[], source: string, mode: 'fd-path' | 'credential'): string[] {
  return [
    process.execPath,
    SYSTEMD_ENV_RUNNER_PATH,
    mode === 'fd-path' ? '--env-fd-path' : '--credential',
    source,
    '--',
    ...base,
  ];
}

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
    ...SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS,
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

/**
 * `env` is absolute on purpose. systemd-run resolves the payload binary with the
 * CLIENT's PATH, and the whole point of this wrapper is that the client's env and
 * the payload's env are no longer the same thing — so resolving `env` itself
 * through either one would reintroduce the coupling in the one place it is
 * hardest to see.
 */
const ENV_BIN = '/usr/bin/env';

/**
 * Wrap a payload so it runs under EXACTLY `env`, independently of the environment
 * the `systemd-run` client itself needs (WI-40906).
 *
 * ── WHY THIS EXISTS (measured 2026-08-23) ───────────────────────────────────
 *
 * A `--scope` payload is forked from the systemd-run client, so it inherits the
 * client's environment. That made `spawn(systemd-run …, { env })` look like it
 * set the payload's env — and it does — but it sets the CLIENT's too, and the
 * client needs its own env to work at all: `systemd-run --user` reaches the user
 * manager over `$DBUS_SESSION_BUS_ADDRESS`. Hand it an env that points that
 * variable somewhere else and the launch dies before the payload ever execs:
 *
 *     Failed to start transient scope unit:
 *       The name org.freedesktop.systemd1 was not provided by any .service files
 *
 * That is not a hypothetical. A sandbox desktop publishes its own accessibility
 * bus and hands apps `DBUS_SESSION_BUS_ADDRESS` for it; every GUI app launched
 * into such a desktop therefore failed to start, silently — the caller passes
 * `stdio: 'ignore'`, so the message above went nowhere and `managedSpawn`
 * returned a healthy-looking handle for a process that had never run. It reads as
 * "the app doesn't work on this desktop", which is why it cost a day to find.
 *
 * BE PRECISE ABOUT WHICH ENVS BREAK IT, because the obvious generalisation is wrong
 * and would send the next reader hunting for the wrong thing (all measured here):
 *
 *   DBUS_SESSION_BUS_ADDRESS unset, XDG_RUNTIME_DIR kept  -> WORKS. systemd falls
 *       back to $XDG_RUNTIME_DIR/bus, so merely stripping the variable is safe.
 *       This is why `scrubExecEnv` callers (pty, capability jobs) never hit it.
 *   DBUS_SESSION_BUS_ADDRESS pointed elsewhere            -> FATAL, message above.
 *       A redirect defeats the fallback: the address is present and wrong.
 *   both unset                                            -> FATAL, but a DIFFERENT
 *       message ("Failed to connect to bus: No medium found").
 *
 * So the hazard is a REDIRECTED bus, not a thin env. The fix still belongs here
 * rather than in the one caller that redirects today: run the client with the
 * operator's own environment, and give the payload its exact env through `env -i`.
 * Measured: the payload still lands in its own scope cgroup, so confinement is
 * unaffected.
 *
 * Semantics match `child_process.spawn({ env })` deliberately — total
 * replacement, not a merge, and `undefined` values are dropped — because callers
 * reach this path by passing exactly that option and must not get a second,
 * subtly different env model depending on whether confinement happened to be
 * available.
 */
export function buildExactEnvPayload(base: readonly string[], env: NodeJS.ProcessEnv): string[] {
  const pairs: string[] = [];
  for (const [name, value] of Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    // `undefined` is dropped by node's own spawn; a name carrying `=` or NUL cannot
    // be expressed as an `env` operand at all, and passing it would silently shift
    // every later operand. Dropping it keeps the payload's env a subset of what was
    // asked for, never a different one.
    if (value === undefined) continue;
    if (name.length === 0 || name.includes('=') || name.includes('\0')) continue;
    pairs.push(`${name}=${value}`);
  }
  return [ENV_BIN, '-i', ...pairs, ...base];
}

export function buildTaskScopeArgv(base: string[], props: TaskScopeProperties): string[] {
  const argv = [
    'systemd-run',
    '--user',
    '--scope',
    '--quiet',
    ...SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS,
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
    ...SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS,
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
