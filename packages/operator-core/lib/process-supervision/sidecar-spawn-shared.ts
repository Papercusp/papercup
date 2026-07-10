/**
 * Shared managed-child-process primitives (WI-3079, plan
 * clear-papercusp-backlog-2026-07-02).
 *
 * Extracted from the THIRD near-identical clone of the sidecar spawn +
 * respawn-with-backoff + graceful-stop shape:
 *   - sync/hyperbee/substrate-sidecar-spawn.ts   (scope-isolated, IPC handle transfer)
 *   - fleet/spawner-sidecar-spawn.ts             (simplest — no respawn/circuit-breaker)
 *   - inference-gateway/gateway-sidecar-spawn.ts (port-probe adoption, no scope isolation)
 *
 * WHY these live here rather than being fully merged into one "ManagedSidecar"
 * orchestrator class: the three spawners genuinely differ in ways that are not
 * accidental duplication — substrate needs systemd-scope isolation + a raw-socket
 * IPC handle-transfer channel + a self-recursive scope-failure fallback; gateway
 * needs a TCP-listening ADOPTION probe (don't double-bind an externally-owned
 * port) + a continuous exit-driven respawn loop with re-probe-before-respawn;
 * spawner has no respawn/circuit-breaker at all. Forcing all of that into one
 * mega-config would trade three readable, independently-testable modules for one
 * harder-to-verify one, for a subsystem where a regression means a fleet-wide
 * agent-spawn / sync / inference outage. So this module extracts exactly the
 * pieces that ARE byte-identical (or identical-up-to-a-label) across all three —
 * the bundled-vs-dev spawn-plan resolution, the backoff + sliding-window
 * circuit-breaker bookkeeping, the SIGTERM→timeout→SIGKILL graceful-stop
 * sequence, and SIGTERM/SIGINT(+uncaughtException) shutdown-hook registration —
 * and leaves the top-level spawn/readiness/respawn orchestration local to each
 * file, where the genuine behavioral differences live. A further full-merge
 * remains a possible (riskier) follow-up if duplication resurfaces.
 */

// ── bundled-vs-dev-tsx spawn-plan resolution ────────────────────────────────
// esbuild bundles EVERY module into one serve.mjs; in a PACKAGED build
// `import.meta.url` for the spawn module IS the bundle (no tsx, no .ts on
// disk), so we re-exec that same artifact under the bundled node with a
// divert env var the entrypoint checks for. In DEV (tsx, real source tree)
// we run the sibling .ts entry via `npx tsx`. Identical across all three
// spawners modulo the divert env var name and the dev entry path.

export interface SidecarSpawnPlan {
  cmd: string;
  args: string[];
  /** Extra env entries to layer over process.env for the child. */
  env: Record<string, string>;
  mode: 'bundled-reexec' | 'dev-tsx';
}

export interface ResolveSidecarSpawnPlanOpts {
  /** This spawn module's own resolved file — `fileURLToPath(import.meta.url)`
   *  of the CALLER, not of this shared module. Bundled iff it does NOT end in
   *  `.ts`/`.tsx` (esbuild emits `.mjs`/`.js`). */
  selfPath: string;
  /** Absolute path to the dev-mode `.ts` entry point (the sidecar script). */
  devScriptPath: string;
  /** Env var name the bundled re-exec sets to '1' so the entrypoint diverts
   *  into sidecar-server mode instead of the normal operator boot path. */
  bundledModeEnvVar: string;
  /** `process.execPath` (the running node binary) — injectable for tests. */
  execPath: string;
}

/** Pure: decide HOW to spawn a sidecar child (bundled re-exec-self vs dev
 *  `npx tsx <entry>`). Exported for unit tests. Identical decision across all
 *  three sidecar spawners, modulo the divert env var name + dev entry path. */
export function resolveSidecarSpawnPlan(opts: ResolveSidecarSpawnPlanOpts): SidecarSpawnPlan {
  const isBundled = !opts.selfPath.endsWith('.ts') && !opts.selfPath.endsWith('.tsx');
  if (isBundled) {
    return {
      cmd: opts.execPath, // the bundled node (e.g. ./bin/node), re-exec'ing selfPath
      args: [opts.selfPath],
      env: { [opts.bundledModeEnvVar]: '1' },
      mode: 'bundled-reexec',
    };
  }
  const isTs = opts.devScriptPath.endsWith('.ts');
  return {
    cmd: isTs ? 'npx' : opts.execPath,
    args: isTs ? ['tsx', opts.devScriptPath] : [opts.devScriptPath],
    env: {},
    mode: 'dev-tsx',
  };
}

// ── per-host sidecar enable-check (WI-3793) ─────────────────────────────────
// Every node-child sidecar (substrate/spawner/gateway/embed) is switched on by
// a PER-HOST env opt-in the operator sets on the bg-host systemd unit (e.g.
// PAPERCUSP_SPAWNER_SIDECAR=1) — distinct from the bundled-reexec DIVERT var
// above (PAPERCUSP_SPAWNER_SIDECAR_MODE) that only the parent's OWN spawn code
// sets on the re-exec'd child, telling its entrypoint "boot as the sidecar
// server, not the normal host". Before this, each caller of the enable-check
// (run-git-sync.ts's gitSyncSidecarEnabled, host-bootstrap.ts's pre-warm
// gate, orchestrator-runner.ts's spawnInvokeOnceWithFallback gate) hand-rolled
// its own `process.env.PAPERCUSP_SPAWNER_SIDECAR === '1'` inline — 3
// near-duplicated checks, and only git-sync's ALSO guarded against the enable
// var being inherited into the sidecar's own re-exec'd child (which spreads
// `...process.env` for the child, per spawnSpawnerSidecar above) and
// mis-firing there. Today that's masked in practice (every sidecar spawn
// explicitly clears PAPERCUSP_BACKGROUND_WORKERS for the child, and none of
// the 2 unguarded call sites currently run inside a sidecar child) — but it's
// a latent footgun, not a designed invariant. One shared, defensively-guarded
// implementation now backs every call site instead of 3 divergent ones; see
// isSidecarEnabledFromEnv below.

export interface SidecarEnabledOpts {
  /** Per-host opt-in enable var, e.g. 'PAPERCUSP_SPAWNER_SIDECAR'. */
  enableVar: string;
  /** Bundled-reexec divert var (see SidecarSpawnPlan), e.g.
   *  'PAPERCUSP_SPAWNER_SIDECAR_MODE'. Reading '1' here means THIS process IS
   *  the re-exec'd sidecar child — always resolves disabled, regardless of
   *  what the (possibly-inherited) enable var reads, so the enable-check can
   *  never fire recursively inside the sidecar it gates. */
  modeVar: string;
  /** Optional explicit per-caller override var (e.g.
   *  'PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR') checked BEFORE `enableVar` when
   *  present (non-null) — '1'/'true' forces ON, anything else forces OFF,
   *  either way short-circuiting `enableVar`. Absent/unset falls through to
   *  the plain enable-var check. */
  explicitVar?: string;
}

/** Pure: is a per-host-gated sidecar enabled for the CURRENT process? Exported
 *  for unit tests; `env` defaults to `process.env` for callers. */
export function isSidecarEnabledFromEnv(
  opts: SidecarEnabledOpts,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env[opts.modeVar] === '1') return false;
  if (opts.explicitVar) {
    const explicit = env[opts.explicitVar];
    if (explicit != null) return explicit === '1' || explicit === 'true';
  }
  return env[opts.enableVar] === '1';
}

// ── respawn backoff + sliding-window circuit breaker ────────────────────────

/** Backoff before respawn attempt N (1-based) within the window: 1s·2^(N−1),
 *  capped at `capMs` (default 30s). Identical formula across all three
 *  respawn-capable spawners (spawner-sidecar-spawn.ts has no respawn at all). */
export function respawnBackoffMs(attemptInWindow: number, capMs = 30_000): number {
  return Math.min(1000 * 2 ** Math.max(0, attemptInWindow - 1), capMs);
}

/** Drop timestamps older than `windowMs` from a sliding respawn-attempt window. */
export function pruneRespawnWindow(attempts: number[], now: number, windowMs: number): number[] {
  return attempts.filter((t) => now - t < windowMs);
}

/** Has the circuit breaker tripped (>= maxAttempts within the current window)? */
export function respawnBudgetExhausted(attempts: number[], maxAttempts: number): boolean {
  return attempts.length >= maxAttempts;
}

// ── graceful SIGTERM→timeout→SIGKILL stop sequence ──────────────────────────

export interface KillableChild {
  once(event: 'exit', listener: () => void): void;
}

/** Signal `child`, wait up to `timeoutMs` for its 'exit', force-kill if it
 *  doesn't. Resolves either way — never rejects. Callers own their own state
 *  resets (a `ready` flag, nulling a module-global process handle, a
 *  process-TREE group-kill instead of a single-pid kill, …) since those are
 *  exactly where the three spawners differ; this only sequences the signal +
 *  wait, which was previously copy-pasted three times almost verbatim. */
export function gracefulStopChild(
  child: KillableChild,
  opts: { timeoutMs: number; kill: (sig: NodeJS.Signals) => void },
): Promise<void> {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      try {
        opts.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve();
    }, opts.timeoutMs);
    (timeout as unknown as { unref?: () => void }).unref?.();
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    try {
      opts.kill('SIGTERM');
    } catch {
      clearTimeout(timeout);
      resolve();
    }
  });
}

// ── shutdown-hook registration ───────────────────────────────────────────────

export interface SidecarShutdownHooksOpts {
  /** Log-line prefix, e.g. 'substrate-sidecar-spawn'. Also the idempotency key. */
  label: string;
  /** Called on SIGTERM/SIGINT (async mode also covers uncaughtException). */
  stop: () => void | Promise<void>;
  /**
   * 'async' (default): SIGTERM/SIGINT/uncaughtException each log then `await
   * stop()` — the substrate + spawner shape.
   * 'sync-with-exit': also listens on Node's 'exit' event, whose handlers
   * MUST run synchronously (an async continuation there is silently dropped
   * once the process has already begun exiting) — no logging, fires
   * `void stop()` fire-and-forget. The gateway supervisor's shape (it must
   * catch the "operator exited without a signal" case too).
   */
  mode?: 'async' | 'sync-with-exit';
  /**
   * 'async' mode ONLY: gate the `uncaughtException` reaction on whether this
   * particular exception is genuinely fatal to the HOST process. Node fires
   * `uncaughtException` listeners process-wide for EVERY uncaught exception,
   * not just ones related to this sidecar — so without a filter, an error the
   * host's OWN guard already classifies as benign and swallows (e.g. hono-host's
   * `isBenignHostError` — a client-disconnect `write EPIPE`, a torn-down PG
   * connection, …) ALSO reaches this listener and tears down a perfectly
   * healthy sidecar, which then gets warm-respawned by the next caller (the
   * P-006 "spawner-sidecar respawn churn" — a `[swarm] DHT bootstrap` line and
   * a fresh child every few minutes on ordinary client-disconnect traffic,
   * long after the EI-8810 EADDRINUSE divert was fixed). Default: always fatal
   * (`() => true`) — preserves prior behavior for a caller that doesn't pass one.
   */
  isFatalException?: (err: unknown) => boolean;
}

const hooksRegisteredFor = new Set<string>();

/** Register shutdown hooks exactly once per `label` (idempotent — calling
 *  this twice for the same label is a no-op the second time, closing a latent
 *  double-registration gap the original substrate/spawner versions had). */
export function registerSidecarShutdownHooks(opts: SidecarShutdownHooksOpts): void {
  if (hooksRegisteredFor.has(opts.label)) return;
  hooksRegisteredFor.add(opts.label);

  if (opts.mode === 'sync-with-exit') {
    const sync = () => {
      void opts.stop();
    };
    process.on('exit', sync);
    process.on('SIGTERM', sync);
    process.on('SIGINT', sync);
    return;
  }

  process.on('SIGTERM', async () => {
    console.log(`[${opts.label}] SIGTERM received, shutting down sidecar`);
    await opts.stop();
  });
  process.on('SIGINT', async () => {
    console.log(`[${opts.label}] SIGINT received, shutting down sidecar`);
    await opts.stop();
  });
  const isFatal = opts.isFatalException ?? (() => true);
  process.on('uncaughtException', async (err) => {
    if (!isFatal(err)) {
      // The host's own guard already classified + swallowed this one (kept the
      // host alive) — an exception the host survives is not a reason to tear
      // down an otherwise-healthy sidecar. Silent: hono-host's guard already
      // logs the benign classification for this same error.
      return;
    }
    console.log(`[${opts.label}] uncaught exception, shutting down sidecar`);
    await opts.stop();
  });
}

/** Test seam — forget which labels have registered hooks. */
export function _resetSidecarShutdownHookRegistryForTests(): void {
  hooksRegisteredFor.clear();
}
