/**
 * Substrate sidecar spawner (P-009).
 *
 * Spawns the substrate sidecar process (apps/operator/bin/substrate-sidecar.ts)
 * as a child process when the SUBSTRATE_SIDECAR flag is ON.
 */

import { spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

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
    __dirname,
    '../../../../apps/operator/bin/substrate-sidecar.ts',
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

    sidecarProcess = spawn(cmd, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
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
