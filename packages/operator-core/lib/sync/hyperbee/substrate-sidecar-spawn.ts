/**
 * Substrate sidecar spawner (P-009).
 *
 * Spawns the substrate sidecar process (apps/operator/bin/substrate-sidecar.ts)
 * as a child process when the SUBSTRATE_SIDECAR flag is ON.
 *
 * Option B (replication-offload, WI-604): the spawn enables the Node child IPC
 * channel (`stdio: [..., 'ipc']`) so the swarm connection handler can transfer a
 * raw peer socket to the sidecar out-of-band via `subprocess.send(msg, socket)`
 * (the sidecar's `registerHandleListener` correlates the handle to a prepared
 * handoff token). `getSubstrateSidecarProcess()` exposes the live child for that
 * transfer. ALL of this is dark — gated by the OFF-by-default SUBSTRATE_SIDECAR
 * flag; the OFF path never spawns, so the IPC channel is byte-irrelevant there.
 */

import { spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveSubstrateSocketPath, SUBSTRATE_SOCKET_ENV } from './substrate-socket-path';
import { buildIsolatedScopeArgv, SCOPE_LAUNCH_FAILURE_RE } from '../../systemd-scope';

// EI-1612 (infra round-3/4): this package is ESM (type:module), where `__dirname`
// is undefined. The previous `path.join(__dirname, …)` threw "__dirname is not
// defined", so the sidecar spawn failed and the substrate fell back to IN-PROCESS
// — running hyperbee on the host's main event loop (the EI-79 saturation class
// that starves routinesTick / git-sync on the bg-host). Derive it from import.meta.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

let sidecarProcess: ChildProcess | null = null;
let sidecarReady = false;
const readyWaiters: (() => void)[] = [];

// --- WI-1504 (substrate-sidecar-memory-isolation-2026-07-02): scope isolation +
// crash-respawn state ---------------------------------------------------------
// `deliberateStop` distinguishes a deliberate stopSubstrateSidecar() call from an
// unexpected crash/OOM-kill in the 'exit' handler — only the latter triggers
// auto-respawn. Reset to false at the top of every (re)spawn attempt.
let deliberateStop = false;
// Sliding-window circuit breaker: MAX_RESPAWN_ATTEMPTS unexpected deaths inside
// RESPAWN_WINDOW_MS gives up auto-respawning, so a persistently-crashing sidecar
// (e.g. a leak that re-triggers immediately after every restart) can't loop
// forever burning CPU + log spam. An explicit spawnSubstrateSidecar() call (e.g.
// from substrate-boot-wrapper on the next boot) starts a fresh window.
export const MAX_RESPAWN_ATTEMPTS = 5;
export const RESPAWN_WINDOW_MS = 5 * 60_000;
let respawnAttempts: number[] = []; // timestamps (ms) of recent auto-respawn schedules
let respawnTimer: ReturnType<typeof setTimeout> | null = null;

/** Per-sidecar memory cap (GiB) for the isolated spawn scope (systemd-run --user
 *  --scope). WI-1504: the sidecar leaks under peer-sync load (27GB bursts observed
 *  in the wild) — scoping it means a balloon OOM-kills ONLY the sidecar's own
 *  cgroup, never the bg-host's (which would otherwise drag every in-flight agent
 *  down with it), and the exit handler below auto-respawns it. Override:
 *  PAPERCUSP_SUBSTRATE_SIDECAR_MEMORY_MAX_G. */
export function substrateSidecarScopeMemoryMaxG(): number {
  const raw = Number(process.env.PAPERCUSP_SUBSTRATE_SIDECAR_MEMORY_MAX_G);
  return Number.isFinite(raw) && raw > 0 ? raw : 8;
}

/** Isolation kill-switch (peer of orchestrator-runner.ts's PAPERCUSP_AGENT_SPAWN_SCOPE
 *  / release-actions.ts's PAPERCUSP_CHECKPOINT_SCOPE): PAPERCUSP_SUBSTRATE_SIDECAR_SCOPE=0
 *  forces the pre-hardening same-cgroup spawn (ops escape hatch). Linux-only —
 *  systemd-run has no analog elsewhere, and every deployment target for this
 *  operator is a Linux host (dev box + prod). */
export function substrateSidecarScopeEnabled(): boolean {
  return process.platform === 'linux' && process.env.PAPERCUSP_SUBSTRATE_SIDECAR_SCOPE !== '0';
}

/** Group-kill the sidecar's whole process tree. Under `detached: true` the wrapper
 *  (systemd-run, when scoped) and the wrapped payload share the child's pgid, so a
 *  single `process.kill(-pid)` reaps both; falls back to a single-pid kill if the
 *  group signal fails (e.g. already exited / no such group). */
function killSidecarTree(sig: NodeJS.Signals): void {
  const proc = sidecarProcess;
  if (!proc) return;
  const pid = proc.pid;
  if (pid) {
    try {
      process.kill(-pid, sig);
      return;
    } catch {
      /* fall through to single-pid kill */
    }
  }
  try {
    proc.kill(sig);
  } catch {
    /* ignore */
  }
}

/** Auto-respawn-on-crash (WI-1504 AC: "synthetic 10G allocation → sidecar
 *  killed+respawned, bg-host main + agents untouched"). Applies a short exponential
 *  backoff (capped at 30s) so a fast crash loop doesn't hammer systemd-run, and the
 *  sliding-window circuit breaker above so a persistently-crashing sidecar gives up
 *  rather than looping forever. */
function scheduleRespawn(socketPath: string): void {
  if (deliberateStop) return;
  if (respawnTimer) return; // a respawn is already pending
  const now = Date.now();
  respawnAttempts = respawnAttempts.filter((t) => now - t < RESPAWN_WINDOW_MS);
  if (respawnAttempts.length >= MAX_RESPAWN_ATTEMPTS) {
    console.error(
      `[substrate-sidecar] ${MAX_RESPAWN_ATTEMPTS} crashes within ${Math.round(RESPAWN_WINDOW_MS / 1000)}s — giving up auto-respawn. ` +
        'Substrate stays on its in-process fallback (see substrate-boot-wrapper) until an explicit spawnSubstrateSidecar() call.',
    );
    return;
  }
  respawnAttempts.push(now);
  const backoffMs = Math.min(1000 * 2 ** (respawnAttempts.length - 1), 30_000);
  console.warn(
    `[substrate-sidecar] auto-respawning in ${backoffMs}ms (attempt ${respawnAttempts.length}/${MAX_RESPAWN_ATTEMPTS} in window)`,
  );
  respawnTimer = setTimeout(() => {
    respawnTimer = null;
    spawnSubstrateSidecar(socketPath).catch((err) => {
      console.error('[substrate-sidecar] auto-respawn failed:', err);
    });
  }, backoffMs);
}

/**
 * Spawn the substrate sidecar process.
 * Waits for the PAPERCUSP_SUBSTRATE_READY handshake line.
 */
export async function spawnSubstrateSidecar(
  socketPath?: string,
  useScope: boolean = substrateSidecarScopeEnabled(),
): Promise<void> {
  if (sidecarProcess) {
    // Already running
    if (sidecarReady) return;
    // Wait for ready
    return new Promise((resolve) => {
      readyWaiters.push(resolve);
    });
  }

  // A fresh spawn attempt — clear any pending backoff timer and the deliberate-stop
  // flag so the crash-respawn machinery is armed for this (re)spawn.
  deliberateStop = false;
  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }

  const sidecarScript = path.join(
    // 5 levels up from packages/operator-core/lib/sync/hyperbee/ → repo root,
    // then apps/operator/bin/. (Was 4 — a latent path bug masked by the __dirname
    // crash; with the EI-1612 __dirname fix it surfaced as packages/apps/… ENOENT.)
    moduleDir,
    '../../../../../apps/operator/bin/substrate-sidecar.ts',
  );

  // Resolve the IPC socket ONCE and pin it in process.env so the parent IPC
  // client (getSubstrateIpcClient) and the spawned child resolve the SAME
  // absolute path. NEVER CWD-relative: a relative `.papercusp` mkdir is EACCES
  // from a packaged root-owned CWD (e.g. /usr/lib/Papercusp/sidecar) → the spawn
  // failed and silently fell back to in-process, so the relocation only ever ran
  // off a dev tree (P-006 live 2-machine rig finding, 2026-06-25).
  const resolvedSocket = socketPath ?? resolveSubstrateSocketPath();
  process.env[SUBSTRATE_SOCKET_ENV] = resolvedSocket;
  const socketDir = path.dirname(resolvedSocket);
  if (!fs.existsSync(socketDir)) {
    fs.mkdirSync(socketDir, { recursive: true });
  }

  // Spawn target. esbuild bundles EVERY module into the single serve.mjs, so in a
  // PACKAGED build import.meta.url here IS serve.mjs — re-exec that artifact under
  // the bundled node with PAPERCUSP_SUBSTRATE_SIDECAR_MODE=1 (serve.ts diverts to
  // runSubstrateSidecarServer). In DEV (tsx, real source tree) run the .ts entry
  // via tsx. The old unconditional `npx tsx <.ts>` could not work off a bundle
  // (no tsx, no .ts on disk) — the other half of the P-006 finding.
  const selfPath = fileURLToPath(import.meta.url);
  const isBundled = !selfPath.endsWith('.ts') && !selfPath.endsWith('.tsx');

  return new Promise<void>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      [SUBSTRATE_SOCKET_ENV]: resolvedSocket,
    };

    let cmd: string;
    let args: string[];
    if (isBundled) {
      cmd = process.execPath; // the bundled node (e.g. ./bin/node)
      args = [selfPath]; // re-exec serve.mjs itself in sidecar mode
      env.PAPERCUSP_SUBSTRATE_SIDECAR_MODE = '1';
    } else {
      const isTs = sidecarScript.endsWith('.ts');
      cmd = isTs ? 'npx' : process.execPath;
      args = isTs ? ['tsx', sidecarScript] : [sidecarScript];
    }
    const launchedAt = Date.now();
    const [spawnCommand, ...spawnArgs] = useScope
      ? buildIsolatedScopeArgv([cmd, ...args], substrateSidecarScopeMemoryMaxG())
      : [cmd, ...args];
    let stderr = '';
    let settled = false;

    // 'ipc' as the 4th stdio slot opens the Node child_process IPC channel —
    // the out-of-band Duplex *handle* transport the Option B socket-handoff
    // rides (`subprocess.send(msg, socket)` → sidecar's process.on('message',
    // (msg, handle))). Without it `process.send` is undefined in the child and
    // the handle listener no-ops, so the raw socket can never cross the process
    // boundary. Harmless on the OFF path (the sidecar is never spawned there).
    sidecarProcess = spawn(spawnCommand, spawnArgs, {
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      detached: true,
    });
    const child = sidecarProcess;

    const cleanup = () => {
      clearTimeout(timeout);
    };
    const isScopeLaunchFailure = (code: number | null): boolean =>
      useScope &&
      !sidecarReady &&
      code !== 0 &&
      Date.now() - launchedAt < 5_000 &&
      SCOPE_LAUNCH_FAILURE_RE.test(stderr);

    const timeout = setTimeout(() => {
      if (!sidecarReady && sidecarProcess === child) {
        killSidecarTree('SIGKILL');
        sidecarProcess = null;
      }
      if (settled) return;
      settled = true;
      reject(new Error('Sidecar startup timeout'));
    }, 10000);

    // Listen for ready handshake
    let stdoutBuffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');

      // Keep the last incomplete line
      stdoutBuffer = lines[lines.length - 1] || '';

      for (const line of lines.slice(0, -1)) {
        console.log('[substrate-sidecar]', line);

        if (line.includes('PAPERCUSP_SUBSTRATE_READY')) {
          sidecarReady = true;
          cleanup();
          if (settled) return;
          settled = true;
          resolve();

          // Wake any other waiters
          for (const waiter of readyWaiters) {
            waiter();
          }
          readyWaiters.length = 0;
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      console.warn('[substrate-sidecar-err]', text.trim());
    });

    child.on('error', (err) => {
      cleanup();
      if (sidecarProcess === child) sidecarProcess = null;
      sidecarReady = false;
      if (settled) return;
      if (useScope) {
        settled = true;
        resolve(spawnSubstrateSidecar(resolvedSocket, false));
        return;
      }
      settled = true;
      reject(err);
    });

    child.on('exit', (code) => {
      cleanup();
      const msg = code !== null ? `exit code ${code}` : 'killed';
      console.warn(`[substrate-sidecar] died (${msg})`);
      const launchFailed = isScopeLaunchFailure(code);
      if (sidecarProcess === child) {
        sidecarProcess = null;
      }
      sidecarReady = false;
      if (launchFailed) {
        if (settled) return;
        settled = true;
        resolve(spawnSubstrateSidecar(resolvedSocket, false));
        return;
      }
      if (!settled) {
        settled = true;
        reject(new Error(`Sidecar exited before ready (${msg})`));
        return;
      }
      scheduleRespawn(resolvedSocket);
    });
  });
}

/** Test seam — reset the module-global respawn/scope state between unit tests. */
export function _resetSubstrateSidecarSpawnStateForTests(): void {
  deliberateStop = false;
  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }
  respawnAttempts = [];
  sidecarProcess = null;
  sidecarReady = false;
  readyWaiters.length = 0;
}

/**
 * Check if the sidecar is running.
 */
export function isSubstrateSidecarRunning(): boolean {
  return !!sidecarProcess && !sidecarProcess.killed;
}

/**
 * The live sidecar child process, or null when not spawned. Exposed for the
 * Option B socket-handoff: the swarm connection handler calls
 * `proc.send({ kind: 'substrate:socketHandle', handoffToken }, socket)` to
 * transfer a raw peer socket to the sidecar over the child IPC channel. Returns
 * null (and the caller falls back to in-process replication) when the sidecar
 * is absent or its IPC channel is unavailable.
 */
export function getSubstrateSidecarProcess(): ChildProcess | null {
  if (!sidecarProcess || sidecarProcess.killed) return null;
  return sidecarProcess;
}

/** Test seam — inject a fake sidecar ChildProcess (for the handoff unit test)
 *  without spawning the real `npx tsx` child. Pass null to reset. */
export function _setSubstrateSidecarProcessForTests(proc: ChildProcess | null): void {
  sidecarProcess = proc;
  sidecarReady = !!proc;
}

/**
 * Kill the sidecar gracefully.
 */
export async function stopSubstrateSidecar(): Promise<void> {
  if (!sidecarProcess || sidecarProcess.killed) return;
  deliberateStop = true;
  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }

  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (sidecarProcess && !sidecarProcess.killed) {
        killSidecarTree('SIGKILL');
      }
      sidecarProcess = null;
      sidecarReady = false;
      resolve();
    }, 5000);

    sidecarProcess!.once('exit', () => {
      clearTimeout(timeout);
      sidecarProcess = null;
      sidecarReady = false;
      resolve();
    });

    killSidecarTree('SIGTERM');
  });
}

/**
 * Register graceful shutdown hooks.
 */
export function registerSidecarShutdownHooks(): void {
  process.on('SIGTERM', async () => {
    console.log('[substrate-sidecar-spawn] SIGTERM received, shutting down sidecar');
    await stopSubstrateSidecar();
  });

  process.on('SIGINT', async () => {
    console.log('[substrate-sidecar-spawn] SIGINT received, shutting down sidecar');
    await stopSubstrateSidecar();
  });

  // Unhandled exception
  process.on('uncaughtException', async () => {
    console.log('[substrate-sidecar-spawn] uncaught exception, shutting down sidecar');
    await stopSubstrateSidecar();
  });
}
