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
/** The fd must outlive asynchronous systemd admission, but never forever. */
export const SECRET_ENV_TRANSPORT_RELEASE_GRACE_MS = 60_000;

export interface SecretEnvironmentTransport {
  /** `/proc/<operator-pid>/fd/<fd>`; the backing file is unlinked immediately. */
  sourcePath: string;
  /** Close the operator-side reference after the consumer has started. */
  release: () => void;
}

export interface SecretEnvironmentPayload {
  argv: string[];
  transport: SecretEnvironmentTransport;
  /** The transient-service property that makes the credential available. */
  credentialProperty?: string;
}

/** Encode the exact replacement environment as NUL-delimited NAME=value records. */
export function encodeSecretEnvironment(env: Readonly<Record<string, string | undefined>>): Buffer {
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
export function createSecretEnvironmentTransport(
  env: Readonly<Record<string, string | undefined>>,
): SecretEnvironmentTransport {
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
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;
  const release = (): void => {
    if (released) return;
    released = true;
    if (releaseTimer) clearTimeout(releaseTimer);
    try { closeSync(fd!); } catch { /* already closed */ }
  };
  releaseTimer = setTimeout(release, SECRET_ENV_TRANSPORT_RELEASE_GRACE_MS);
  releaseTimer.unref?.();
  return {
    sourcePath: `/proc/${process.pid}/fd/${fd}`,
    release,
  };
}

export function environmentRunnerPayload(base: readonly string[], source: string, mode: 'fd-path' | 'credential'): string[] {
  return [
    process.execPath,
    SYSTEMD_ENV_RUNNER_PATH,
    mode === 'fd-path' ? '--env-fd-path' : '--credential',
    source,
    '--',
    ...base,
  ];
}

function buildSecretEnvironmentPayload(
  base: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  mode: 'fd-path' | 'credential',
): SecretEnvironmentPayload {
  const transport = createSecretEnvironmentTransport(env);
  return {
    argv: environmentRunnerPayload(
      base,
      mode === 'credential' ? SYSTEMD_ENV_CREDENTIAL_NAME : transport.sourcePath,
      mode,
    ),
    transport,
    ...(mode === 'credential'
      ? { credentialProperty: `--property=LoadCredential=${SYSTEMD_ENV_CREDENTIAL_NAME}:${transport.sourcePath}` }
      : {}),
  };
}

export function buildExactEnvPayloadWithTransport(
  base: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): SecretEnvironmentPayload {
  return buildSecretEnvironmentPayload(base, env, 'fd-path');
}

export function buildServiceEnvPayloadWithTransport(
  base: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): SecretEnvironmentPayload {
  return buildSecretEnvironmentPayload(base, env, 'credential');
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

/**
 * Swap policy for a transient scope. Choose by what the payload IS, not by habit.
 *
 * `'deny'` (MemorySwapMax=0) is correct ONLY for a long-lived process whose event loop the
 * rest of the system waits on. There, swap-thrash IS the freeze: the bg-host incident
 * (WI-1086, 2026-06-30) measured a 68 GB thrash producing ~100s page-in stalls that froze
 * routinesTick/git-sync into an ~11min restart loop, so a clean hard-recycle at MemoryMax
 * genuinely beat paging. That reasoning is about a SHARED ORCHESTRATOR — not about memory.
 *
 * `'allow'` is correct for a WORKER: an agent session, a spawned job. Nothing blocks on its
 * event loop, so if it exceeds its budget the right outcome is that it gets SLOWER, not that
 * it dies. Denying swap on a worker converts ordinary memory pressure into an OOM kill even
 * when the host has terabytes of free swap — measured 2026-08-24 at 1.87 TB free while agent
 * scopes were being killed at a 6 GiB cap, with 7 of 74 scopes sitting at exactly 6.0 GiB
 * (i.e. cap-bounded, not demand). That is the WI-41206 defect: this policy was mirrored from
 * bg-host onto agent scopes, where the analogy does not hold.
 *
 * MemoryMax stays in BOTH cases as the per-payload runaway backstop. This changes only what
 * happens when a payload reaches it: page, or die.
 */
export type ScopeSwapPolicy = 'allow' | 'deny';

/** Build the systemd-run argv that runs `base` in a transient user SCOPE with its own
 *  memory cap. `--scope` (NOT `--unit`): the payload stays OUR CHILD — stdio piped,
 *  process-group kill + full env inheritance intact — but lands in its own cgroup
 *  OUTSIDE the launching service's MemoryMax.
 *
 *  `swap` defaults to 'allow' (WI-41206): the dominant caller here is a worker scope, and a
 *  worker should page rather than be killed. A caller whose payload is a shared orchestrator —
 *  or a known leaker whose thrash would wedge the box — opts into 'deny' EXPLICITLY, so that
 *  choice is visible at the call site instead of silently inherited. */
export function buildIsolatedScopeArgv(
  base: string[],
  memoryMaxG: number,
  swap: ScopeSwapPolicy = 'allow',
): string[] {
  return [
    'systemd-run',
    '--user',
    '--scope',
    '--quiet',
    ...SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS,
    `--property=MemoryMax=${memoryMaxG}G`,
    ...(swap === 'deny' ? ['--property=MemorySwapMax=0'] : []),
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
  /** WI-41206: swap policy for this task's cgroup. Defaults to 'allow' — a task that reaches
   *  its MemoryMax should PAGE, not be OOM-killed. Pass 'deny' only for a payload whose
   *  thrashing would wedge something the whole system waits on. See {@link ScopeSwapPolicy}. */
  swap?: ScopeSwapPolicy;
  /** Extra `--property=K=V` pairs; escape hatch for a one-off, kept last. */
  extraProperties?: readonly string[];
}

function appendTaskProperties(argv: string[], props: TaskScopeProperties): void {
  if (props.memoryMaxBytes && props.memoryMaxBytes > 0) {
    argv.push(`--property=MemoryMax=${Math.floor(props.memoryMaxBytes)}`);
    // WI-41206: defaults to 'allow'. This used to hardcode MemorySwapMax=0 on the reasoning
    // that "swap-thrash IS the event-loop freeze" — true of the bg-host ORCHESTRATOR that
    // reasoning came from (WI-1086), false of a task scope, which nothing waits on. A task at
    // its cap should page and finish slowly, not be OOM-killed on a host with free swap.
    // See {@link ScopeSwapPolicy}; MemoryMax above is still the runaway backstop.
    if ((props.swap ?? 'allow') === 'deny') argv.push('--property=MemorySwapMax=0');
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
 * operator's own environment, and give the payload its exact env through an
 * anonymous fd that never puts values in argv or a journal-visible property.
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
  return buildExactEnvPayloadWithTransport(base, env).argv;
}

export interface BuiltTaskArgv {
  argv: string[];
  transport: SecretEnvironmentTransport | null;
}

function buildTaskArgv(base: string[], props: TaskScopeProperties, kind: 'scope' | 'service'): BuiltTaskArgv {
  const payload = props.env
    ? kind === 'service'
      ? buildServiceEnvPayloadWithTransport(base, props.env)
      : buildExactEnvPayloadWithTransport(base, props.env)
    : null;
  const argv = [
    'systemd-run',
    '--user',
    ...(kind === 'scope' ? ['--scope'] : ['--pipe', '--wait']),
    '--quiet',
    ...SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS,
    `--unit=${props.unit}`,
    `--slice=${props.slice}`,
  ];
  if (kind === 'service') {
    argv.push(
      // EI-21192501620501693: keep the whole transient service cgroup reaped.
      '--property=KillMode=control-group',
      '--property=TimeoutStopSec=10s',
    );
  }
  if (kind === 'service' && props.workingDirectory) {
    argv.push(`--working-directory=${props.workingDirectory}`);
  }
  if (payload?.credentialProperty) argv.push(payload.credentialProperty);
  appendTaskProperties(argv, props);
  argv.push(...(payload?.argv ?? base));
  return { argv, transport: payload?.transport ?? null };
}

export function buildTaskScopeArgvWithTransport(base: string[], props: TaskScopeProperties): BuiltTaskArgv {
  return buildTaskArgv(base, props, 'scope');
}

export function buildTaskScopeArgv(base: string[], props: TaskScopeProperties): string[] {
  return buildTaskScopeArgvWithTransport(base, props).argv;
}

/**
 * Build a named transient SERVICE argv. systemd-run uses service mode by
 * default, so there is intentionally no `--service` flag: on the supported CLI
 * that token is parsed as the `--service-type` abbreviation and makes launch
 * fail. `--pipe --wait` preserves the synchronous seam's stdio/exit contract
 * while the service unit remains owned by the user manager if this client dies.
 */
export function buildTaskServiceArgv(base: string[], props: TaskScopeProperties): string[] {
  return buildTaskServiceArgvWithTransport(base, props).argv;
}

export function buildTaskServiceArgvWithTransport(base: string[], props: TaskScopeProperties): BuiltTaskArgv {
  return buildTaskArgv(base, props, 'service');
}
