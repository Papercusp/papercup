/**
 * Embedding sidecar spawner (P-002, plan
 * shared-embedding-sidecar-and-enrichment-2026-07-10).
 *
 * Cloned from fleet/spawner-sidecar-spawn.ts (which cloned the substrate one) —
 * the third node-child sidecar, same supervision mechanics so all three behave
 * identically: ready-line handshake, crash auto-respawn with backoff + a
 * sliding-window circuit breaker, graceful-stop shutdown hooks, and a pure
 * supervision-status snapshot for dev:service_health.
 *
 * Spawns apps/operator/bin/embed-sidecar.ts (dev) or re-execs the bundle with
 * PAPERCUSP_EMBED_SIDECAR_MODE=1 (packaged). Rollout control is a PER-HOST env
 * opt-in — PAPERCUSP_EMBED_SIDECAR=1 — mirroring the spawner sidecar's v1
 * (orchestrator-runner.ts): embedding hosts differ (bg-host embeds constantly,
 * a desktop install rarely), so a fleet-wide flag flip is the wrong shape.
 *
 * Everything here is dark — the OFF path never spawns, and the client seam
 * (@papercusp/memory sidecar-embedder.ts, D-003) falls back to in-process
 * embedding whenever no sidecar answers, so a spawn failure degrades to
 * exactly today's behavior.
 */

import { spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveSidecarSpawnPlan,
  gracefulStopChild,
  respawnBackoffMs,
  pruneRespawnWindow,
  respawnBudgetExhausted,
  registerSidecarShutdownHooks as registerSharedSidecarShutdownHooks,
} from '../process-supervision/sidecar-spawn-shared';
import { isBenignHostError } from '../host-benign-errors';
import {
  EMBED_SIDECAR_DEFAULT_PORT,
  EMBED_SIDECAR_PORT_ENV,
  EMBED_SIDECAR_READY_LINE,
} from './embed-sidecar-server';

/** Per-host opt-in switch (v1 rollout control, like PAPERCUSP_SPAWNER_SIDECAR). */
export const EMBED_SIDECAR_ENABLE_ENV = 'PAPERCUSP_EMBED_SIDECAR';

// ESM (type:module) — derive the module dir from import.meta (EI-1612 shape).
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

let sidecarProcess: ChildProcess | null = null;
let sidecarReady = false;
const readyWaiters: (() => void)[] = [];

let deliberateStop = false;
export const MAX_RESPAWN_ATTEMPTS = 5;
export const RESPAWN_WINDOW_MS = 5 * 60_000;
let respawnAttempts: number[] = []; // timestamps (ms) of recent auto-respawn schedules
let respawnTimer: ReturnType<typeof setTimeout> | null = null;
let gaveUp = false;

/** Is the embed sidecar enabled on THIS host? (env opt-in, evaluated per call
 *  so tests / late exports can flip it). */
export function embedSidecarEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // Never inside a sidecar process itself (any *_SIDECAR_MODE) — a sidecar
  // spawning sidecars is the recursion the mode-divert exists to prevent.
  if (env.PAPERCUSP_EMBED_SIDECAR_MODE === '1') return false;
  return env[EMBED_SIDECAR_ENABLE_ENV] === '1';
}

/** The loopback base URL of the host-local sidecar (port env-overridable). */
export function embedSidecarLocalUrl(env: NodeJS.ProcessEnv = process.env): string {
  const port = Number(env[EMBED_SIDECAR_PORT_ENV] ?? EMBED_SIDECAR_DEFAULT_PORT);
  return `http://127.0.0.1:${port}`;
}

/** Does anything answer /healthz at `url`? Cheap loopback probe used for the
 *  shared-fixed-port adoption logic (ensure + respawn): the sidecar port is
 *  ONE per host, so "already served" means a sibling process owns it — adopt
 *  it, never spawn a doomed EADDRINUSE child into a crash-respawn loop. */
async function healthzAnswers(url: string, timeoutMs = 1500): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/healthz`, { signal: ctl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Short exponential backoff + sliding-window circuit breaker — a persistently
 *  crashing sidecar gives up rather than looping; embedding just stays on the
 *  in-process fallback path (D-003) until an explicit respawn. */
function scheduleRespawn(): void {
  if (deliberateStop) return;
  if (respawnTimer) return; // a respawn is already pending
  const now = Date.now();
  respawnAttempts = pruneRespawnWindow(respawnAttempts, now, RESPAWN_WINDOW_MS);
  if (respawnBudgetExhausted(respawnAttempts, MAX_RESPAWN_ATTEMPTS)) {
    gaveUp = true;
    console.error(
      `[embed-sidecar] ${MAX_RESPAWN_ATTEMPTS} crashes within ${Math.round(RESPAWN_WINDOW_MS / 1000)}s — giving up auto-respawn. ` +
        'Embedding stays on the in-process fallback until an explicit spawnEmbedSidecar() call.',
    );
    return;
  }
  respawnAttempts.push(now);
  const backoffMs = respawnBackoffMs(respawnAttempts.length);
  console.warn(
    `[embed-sidecar] auto-respawning in ${backoffMs}ms (attempt ${respawnAttempts.length}/${MAX_RESPAWN_ATTEMPTS} in window)`,
  );
  respawnTimer = setTimeout(() => {
    respawnTimer = null;
    void (async () => {
      // A likely reason OUR child died with the port contested: a sibling
      // process's sidecar owns it. If something healthy answers, adopt it —
      // respawning would just EADDRINUSE-crash into the circuit breaker.
      if (await healthzAnswers(embedSidecarLocalUrl())) {
        console.log('[embed-sidecar] port already served by a sibling process — adopting, not respawning');
        return;
      }
      await spawnEmbedSidecar().catch((err) => {
        console.error('[embed-sidecar] auto-respawn failed:', err);
      });
    })();
  }, backoffMs);
}

/**
 * Spawn the embedding sidecar process.
 * Waits for the PAPERCUSP_EMBED_SIDECAR_READY handshake line (printed at
 * LISTEN — model warm-up continues in the background, so this stays well
 * inside the timeout even on a cold model cache).
 */
export async function spawnEmbedSidecar(): Promise<void> {
  if (sidecarProcess) {
    // Already running
    if (sidecarReady) return;
    // Wait for ready
    return new Promise((resolve) => {
      readyWaiters.push(resolve);
    });
  }

  // A fresh spawn attempt — clear any pending backoff timer and the
  // deliberate-stop flag so the crash-respawn machinery is armed.
  deliberateStop = false;
  gaveUp = false;
  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }

  const sidecarScript = path.join(
    // 4 levels up from packages/operator-core/lib/memory/ → repo root,
    // then apps/operator/bin/.
    moduleDir,
    '../../../../apps/operator/bin/embed-sidecar.ts',
  );

  // Spawn target. esbuild bundles EVERY module into the single serve.mjs, so in
  // a PACKAGED build import.meta.url here IS serve.mjs — re-exec that artifact
  // under the bundled node with PAPERCUSP_EMBED_SIDECAR_MODE=1 (serve.ts /
  // hono-host.ts divert to runEmbedSidecarServer). In DEV (tsx, real source
  // tree) run the .ts entry via tsx.
  const selfPath = fileURLToPath(import.meta.url);
  const plan = resolveSidecarSpawnPlan({
    selfPath,
    devScriptPath: sidecarScript,
    bundledModeEnvVar: 'PAPERCUSP_EMBED_SIDECAR_MODE',
    execPath: process.execPath,
  });

  return new Promise<void>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...plan.env,
      // EI-8810 belt: the sidecar serves its OWN loopback port only — never the
      // parent's HTTP port or the background-worker role. A mode-divert miss in
      // the re-exec'd entry otherwise boots a full host on the PARENT's port
      // (EADDRINUSE crash-respawn loop) and could double-run the single-writer
      // background machinery. Port 0 = ephemeral bind if some entry ever listens.
      PAPERCUSP_HONO_PORT: '0',
      PORT: '0',
      PAPERCUSP_BACKGROUND_WORKERS: '0',
    };

    sidecarProcess = spawn(plan.cmd, plan.args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      detached: false,
    });

    const timeout = setTimeout(() => {
      if (!sidecarReady && sidecarProcess) {
        sidecarProcess.kill();
        sidecarProcess = null;
      }
      reject(new Error('Embed sidecar startup timeout'));
    }, 10000);

    // Listen for ready handshake
    let stdoutBuffer = '';
    sidecarProcess.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');

      // Keep the last incomplete line
      stdoutBuffer = lines[lines.length - 1] || '';

      for (const line of lines.slice(0, -1)) {
        console.log('[embed-sidecar]', line);

        if (line.includes(EMBED_SIDECAR_READY_LINE)) {
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
      console.warn('[embed-sidecar-err]', chunk.toString().trim());
    });

    sidecarProcess.on('error', (err) => {
      sidecarProcess = null;
      sidecarReady = false;
      reject(err);
    });

    sidecarProcess.on('exit', (code) => {
      const msg = code !== null ? `exit code ${code}` : 'killed';
      if (!deliberateStop) {
        console.warn(`[embed-sidecar] died (${msg})`);
      }
      sidecarProcess = null;
      sidecarReady = false;
      scheduleRespawn();
    });
  });
}

/**
 * Ensure the host-local sidecar is up and return its base URL, or null when
 * disabled/unspawnable. The lazy front door consumers call on first embed —
 * mirrors spawnInvokeOnceWithFallback's shape: failure returns null (caller
 * stays on its in-process path), never throws.
 *
 * Shared-fixed-port semantics: the port is ONE per host, so if ANY process
 * already serves it (this one earlier, or a sibling operator process), adopt
 * that instance instead of spawning a second child that would EADDRINUSE-die.
 * First process to need the sidecar spawns it; everyone else rides along.
 */
export async function ensureEmbedSidecar(): Promise<string | null> {
  if (!embedSidecarEnabled()) return null;
  const url = embedSidecarLocalUrl();
  if (isEmbedSidecarRunning()) return url;
  if (await healthzAnswers(url)) return url; // sibling-owned — adopt
  try {
    await spawnEmbedSidecar();
    registerEmbedSidecarShutdownHooks();
    return url;
  } catch (err) {
    console.warn('[embed-sidecar] ensure failed (embedding stays in-process):', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Check if the sidecar is running.
 */
export function isEmbedSidecarRunning(): boolean {
  return !!sidecarProcess && !sidecarProcess.killed;
}

/** Test seam — inject a fake sidecar ChildProcess without spawning a real child. */
export function _setEmbedSidecarProcessForTests(proc: ChildProcess | null): void {
  sidecarProcess = proc;
  sidecarReady = !!proc;
}

/**
 * Kill the sidecar gracefully.
 */
export async function stopEmbedSidecar(): Promise<void> {
  if (!sidecarProcess || sidecarProcess.killed) return;
  deliberateStop = true;
  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }
  const proc = sidecarProcess;
  await gracefulStopChild(proc, { timeoutMs: 5000, kill: (sig) => proc.kill(sig) });
  sidecarProcess = null;
  sidecarReady = false;
}

/**
 * Register graceful shutdown hooks.
 */
export function registerEmbedSidecarShutdownHooks(): void {
  registerSharedSidecarShutdownHooks({
    label: 'embed-sidecar-spawn',
    stop: () => stopEmbedSidecar(),
    // Only tear down for an ACTUALLY-fatal uncaughtException (P-006 lesson:
    // a benign client-disconnect EPIPE must not kill a healthy sidecar into
    // a warm-respawn churn loop).
    isFatalException: (err) => !isBenignHostError(err),
  });
}

/** Test seam — reset the module-global respawn state between unit tests. */
export function _resetEmbedSidecarSpawnStateForTests(): void {
  deliberateStop = false;
  gaveUp = false;
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
 * Node-child supervision status for `dev:service_health`'s additive
 * `supervision` block — mirrors `spawnerSidecarSupervisionStatus()`. PURE
 * given the module's own in-memory state (no I/O).
 */
export interface EmbedSidecarSupervisionStatus {
  running: boolean;
  respawnAttemptsInWindow: number;
  gaveUp: boolean;
  lastRespawnScheduledAt: number | null;
}

export function embedSidecarSupervisionStatus(now: number = Date.now()): EmbedSidecarSupervisionStatus {
  const attempts = pruneRespawnWindow(respawnAttempts, now, RESPAWN_WINDOW_MS);
  return {
    running: !!sidecarProcess && !sidecarProcess.killed,
    respawnAttemptsInWindow: attempts.length,
    gaveUp,
    lastRespawnScheduledAt: attempts.length ? attempts[attempts.length - 1] : null,
  };
}
