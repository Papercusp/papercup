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

// EI-1612 (infra round-3/4): this package is ESM (type:module), where `__dirname`
// is undefined. The previous `path.join(__dirname, …)` threw "__dirname is not
// defined", so the sidecar spawn failed and the substrate fell back to IN-PROCESS
// — running hyperbee on the host's main event loop (the EI-79 saturation class
// that starves routinesTick / git-sync on the bg-host). Derive it from import.meta.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

let sidecarProcess: ChildProcess | null = null;
let sidecarReady = false;
const readyWaiters: (() => void)[] = [];

/**
 * Spawn the substrate sidecar process.
 * Waits for the PAPERCUSP_SUBSTRATE_READY handshake line.
 */
export async function spawnSubstrateSidecar(socketPath?: string): Promise<void> {
  if (sidecarProcess) {
    // Already running
    if (sidecarReady) return;
    // Wait for ready
    return new Promise((resolve) => {
      readyWaiters.push(resolve);
    });
  }

  const sidecarScript = path.join(
    // 5 levels up from packages/operator-core/lib/sync/hyperbee/ → repo root,
    // then apps/operator/bin/. (Was 4 — a latent path bug masked by the __dirname
    // crash; with the EI-1612 __dirname fix it surfaced as packages/apps/… ENOENT.)
    moduleDir,
    '../../../../../apps/operator/bin/substrate-sidecar.ts',
  );

  // Ensure socket directory exists
  const socketDir = socketPath ? path.dirname(socketPath) : '.papercusp';
  if (!fs.existsSync(socketDir)) {
    fs.mkdirSync(socketDir, { recursive: true });
  }

  return new Promise<void>((resolve, reject) => {
    const env = {
      ...process.env,
      PAPERCUSP_SUBSTRATE_IPC_SOCKET: socketPath || path.join('.papercusp', 'substrate.sock'),
    };

    // Spawn with tsx for .ts files or node for .js
    const isTs = sidecarScript.endsWith('.ts');
    const cmd = isTs ? 'npx' : 'node';
    const args = isTs ? ['tsx', sidecarScript] : [sidecarScript];

    // 'ipc' as the 4th stdio slot opens the Node child_process IPC channel —
    // the out-of-band Duplex *handle* transport the Option B socket-handoff
    // rides (`subprocess.send(msg, socket)` → sidecar's process.on('message',
    // (msg, handle))). Without it `process.send` is undefined in the child and
    // the handle listener no-ops, so the raw socket can never cross the process
    // boundary. Harmless on the OFF path (the sidecar is never spawned there).
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
      reject(new Error('Sidecar startup timeout'));
    }, 10000);

    // Listen for ready handshake
    let stdoutBuffer = '';
    sidecarProcess.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');

      // Keep the last incomplete line
      stdoutBuffer = lines[lines.length - 1] || '';

      for (const line of lines.slice(0, -1)) {
        console.log('[substrate-sidecar]', line);

        if (line.includes('PAPERCUSP_SUBSTRATE_READY')) {
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
      console.warn('[substrate-sidecar-err]', chunk.toString().trim());
    });

    sidecarProcess.on('error', (err) => {
      sidecarProcess = null;
      sidecarReady = false;
      reject(err);
    });

    sidecarProcess.on('exit', (code) => {
      const msg = code !== null ? `exit code ${code}` : 'killed';
      console.warn(`[substrate-sidecar] died (${msg})`);
      sidecarProcess = null;
      sidecarReady = false;
    });
  });
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

  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (sidecarProcess && !sidecarProcess.killed) {
        sidecarProcess.kill('SIGKILL');
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

    sidecarProcess!.kill('SIGTERM');
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
