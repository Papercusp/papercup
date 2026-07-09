/**
 * Spawner sidecar spawner (WI-344 ③, plan spawner-sidecar-offload-2026-06-30).
 *
 * Cloned from sync/hyperbee/substrate-sidecar-spawn.ts. Spawns the SPAWNER sidecar
 * process (apps/operator/bin/spawner-sidecar.ts) as a child when the OFF-by-default
 * SPAWNER_SIDECAR flag is ON. The sidecar owns the agent-spawn fork/exec +
 * buildInvokeOnce (the ~24.5% main-loop CPU that freezes routinesTick), moved off
 * the bg-host main event loop; the main process talks to it over a Unix-domain
 * JSON-RPC socket (spawner-ipc-client.ts).
 *
 * Everything here is dark — gated by the OFF-by-default flag; the OFF path never
 * spawns, so this module is byte-irrelevant there.
 */

import { spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveSpawnerSocketPath, SPAWNER_SOCKET_ENV } from './spawner-socket-path';
import {
  resolveSidecarSpawnPlan,
  gracefulStopChild,
  registerSidecarShutdownHooks as registerSharedSidecarShutdownHooks,
} from '../process-supervision/sidecar-spawn-shared';
import { isBenignHostError } from '../host-benign-errors';

// This package is ESM (type:module), where `__dirname` is undefined. Derive the
// module dir from import.meta (the substrate EI-1612 fix) so the sidecar script
// path resolves instead of throwing "__dirname is not defined" and silently
// falling back to in-process spawning on the host's main loop.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

let sidecarProcess: ChildProcess | null = null;
let sidecarReady = false;
const readyWaiters: (() => void)[] = [];

/**
 * Spawn the spawner sidecar process.
 * Waits for the PAPERCUSP_SPAWNER_READY handshake line.
 */
export async function spawnSpawnerSidecar(socketPath?: string): Promise<void> {
  if (sidecarProcess) {
    // Already running
    if (sidecarReady) return;
    // Wait for ready
    return new Promise((resolve) => {
      readyWaiters.push(resolve);
    });
  }

  const sidecarScript = path.join(
    // 4 levels up from packages/operator-core/lib/fleet/ → repo root,
    // then apps/operator/bin/.
    moduleDir,
    '../../../../apps/operator/bin/spawner-sidecar.ts',
  );

  // Resolve the IPC socket ONCE and pin it in process.env so the parent IPC
  // client (getSpawnerIpcClient) and the spawned child resolve the SAME absolute
  // path. NEVER CWD-relative: a relative `.papercusp` mkdir is EACCES from a
  // packaged root-owned CWD → the spawn would fail and silently fall back to
  // in-process (the P-006 substrate finding).
  const resolvedSocket = socketPath ?? resolveSpawnerSocketPath();
  process.env[SPAWNER_SOCKET_ENV] = resolvedSocket;
  const socketDir = path.dirname(resolvedSocket);
  if (!fs.existsSync(socketDir)) {
    fs.mkdirSync(socketDir, { recursive: true });
  }

  // Spawn target. esbuild bundles EVERY module into the single serve.mjs, so in a
  // PACKAGED build import.meta.url here IS serve.mjs — re-exec that artifact under
  // the bundled node with PAPERCUSP_SPAWNER_SIDECAR_MODE=1 (serve.ts diverts to
  // runSpawnerSidecarServer). In DEV (tsx, real source tree) run the .ts entry via
  // tsx.
  const selfPath = fileURLToPath(import.meta.url);
  const plan = resolveSidecarSpawnPlan({
    selfPath,
    devScriptPath: sidecarScript,
    bundledModeEnvVar: 'PAPERCUSP_SPAWNER_SIDECAR_MODE',
    execPath: process.execPath,
  });

  return new Promise<void>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...plan.env,
      [SPAWNER_SOCKET_ENV]: resolvedSocket,
      // EI-8810 belt: the sidecar serves over the Unix socket ONLY — never hand
      // the child the parent's HTTP port or the background-worker role. A
      // mode-divert miss in the re-exec'd entry (the exact hono-host.mjs bug)
      // otherwise boots a full host on the PARENT's own port (EADDRINUSE
      // crash-respawn loop) and could double-run the single-writer background
      // machinery (EI-126). Port 0 = ephemeral bind if some entry ever listens.
      PAPERCUSP_HONO_PORT: '0',
      PORT: '0',
      PAPERCUSP_BACKGROUND_WORKERS: '0',
    };

    const cmd = plan.cmd;
    const args = plan.args;

    // 'ipc' as the 4th stdio slot opens the Node child_process IPC channel,
    // mirroring the substrate sidecar's spawn shape (harmless here — the spawner
    // sidecar talks over the Unix socket, not the handle channel).
    sidecarProcess = spawn(cmd, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      detached: false,
    });

    const timeout = setTimeout(() => {
      if (!sidecarReady && sidecarProcess) {
        sidecarProcess.kill();
        sidecarProcess = null;
      }
      reject(new Error('Spawner sidecar startup timeout'));
    }, 10000);

    // Listen for ready handshake
    let stdoutBuffer = '';
    sidecarProcess.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');

      // Keep the last incomplete line
      stdoutBuffer = lines[lines.length - 1] || '';

      for (const line of lines.slice(0, -1)) {
        console.log('[spawner-sidecar]', line);

        if (line.includes('PAPERCUSP_SPAWNER_READY')) {
          sidecarReady = true;
          clearTimeout(timeout);
          resolve();

          // Wake any other waiters
          for (const waiter of readyWaiters) {
            waiter();
          }
          readyWaiters.length = 0;
        }
      }
    });

    sidecarProcess.stderr?.on('data', (chunk: Buffer) => {
      console.warn('[spawner-sidecar-err]', chunk.toString().trim());
    });

    sidecarProcess.on('error', (err) => {
      sidecarProcess = null;
      sidecarReady = false;
      reject(err);
    });

    sidecarProcess.on('exit', (code) => {
      const msg = code !== null ? `exit code ${code}` : 'killed';
      console.warn(`[spawner-sidecar] died (${msg})`);
      sidecarProcess = null;
      sidecarReady = false;
    });
  });
}

/**
 * Check if the sidecar is running.
 */
export function isSpawnerSidecarRunning(): boolean {
  return !!sidecarProcess && !sidecarProcess.killed;
}

/**
 * The live sidecar child process, or null when not spawned.
 */
export function getSpawnerSidecarProcess(): ChildProcess | null {
  if (!sidecarProcess || sidecarProcess.killed) return null;
  return sidecarProcess;
}

/** Test seam — inject a fake sidecar ChildProcess without spawning the real
 *  `npx tsx` child. Pass null to reset. */
export function _setSpawnerSidecarProcessForTests(proc: ChildProcess | null): void {
  sidecarProcess = proc;
  sidecarReady = !!proc;
}

/**
 * Kill the sidecar gracefully.
 */
export async function stopSpawnerSidecar(): Promise<void> {
  if (!sidecarProcess || sidecarProcess.killed) return;
  const proc = sidecarProcess;
  await gracefulStopChild(proc, { timeoutMs: 5000, kill: (sig) => proc.kill(sig) });
  sidecarProcess = null;
  sidecarReady = false;
}

/**
 * Register graceful shutdown hooks.
 */
export function registerSpawnerSidecarShutdownHooks(): void {
  registerSharedSidecarShutdownHooks({
    label: 'spawner-sidecar-spawn',
    stop: () => stopSpawnerSidecar(),
    // P-006: only tear down the sidecar for an uncaughtException that is
    // ACTUALLY fatal to the host — one hono-host's own guard does NOT already
    // swallow. Otherwise every benign client-disconnect `write EPIPE` kills a
    // healthy sidecar and the next caller warm-respawns it (the observed
    // ~6min "DHT bootstrap" churn).
    isFatalException: (err) => !isBenignHostError(err),
  });
}
