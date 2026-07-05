/**
 * Cross-platform inference-gateway supervisor (P-006/P-007,
 * cross-platform-hardening-and-agent-ergonomics-2026-07-05 / WI-3059).
 *
 * WHY: the gateway (:8788 paced OAuth egress for the whole fleet) was supervised ONLY by
 * a systemd --user unit — macOS has no systemd and WSL lacks it by default, so the
 * packaged desktop app simply never had a gateway (the Mac-VM agent found the port
 * unreachable and agonized over it). This module replicates the unit's Restart=always
 * semantics as a MANAGED CHILD of the operator, the same pattern as
 * sync/hyperbee/substrate-sidecar-spawn.ts and fleet/spawner-sidecar-spawn.ts (third
 * instance of the sidecar-spawn shape — extraction to a shared lib is tracked as a
 * follow-up, deliberately not done mid-flight here).
 *
 * KEY DIFFERENCE from its siblings: PORT-PROBE-FIRST ADOPTION. On the Linux dev box the
 * systemd unit already owns :8788; probing before spawning means we ADOPT the external
 * gateway instead of racing it for the bind (EADDRINUSE crash-loop). That probe also
 * self-gates the whole feature — no getFlag() at host-boot (fragile there: resolves
 * false when PostHog is unreachable — see the stall-waker note in host-bootstrap.ts).
 *
 * Spawn target mirrors the substrate P-006 finding: esbuild bundles EVERYTHING into the
 * single serve.mjs, so in a PACKAGED build we re-exec that artifact under the bundled
 * node with PAPERCUSP_GATEWAY_SIDECAR_MODE=1 (serve.ts diverts to runGatewaySidecarMain);
 * in DEV (tsx, real source tree) we `npx tsx` the sibling bin.ts.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_GATEWAY_PORT } from './launch';

// ESM (type:module): derive the module dir from import.meta (the EI-1612 __dirname fix).
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

// ── crash-respawn state (mirrors substrate-sidecar-spawn constants) ────────────
export const GATEWAY_MAX_RESPAWN_ATTEMPTS = 5;
export const GATEWAY_RESPAWN_WINDOW_MS = 5 * 60_000;
/** Backoff before respawn attempt N (1-based) within the window: 1s·2^(N−1), capped 30s.
 *  Exported pure for tests. */
export function gatewayRespawnBackoffMs(attemptInWindow: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attemptInWindow - 1), 30_000);
}

let gatewayProcess: ChildProcess | null = null;
let deliberateStop = false;
let respawnAttempts: number[] = []; // timestamps (ms) of recent auto-respawn schedules
let respawnTimer: ReturnType<typeof setTimeout> | null = null;
let adoptedExternal = false;

/** The port this supervisor manages (env override → default 8788). */
export function gatewaySupervisorPort(): number {
  return Number(process.env.PAPERCUSP_GATEWAY_PORT) || DEFAULT_GATEWAY_PORT;
}

/** TCP-connect probe: is ANYTHING listening on 127.0.0.1:<port>? Deliberately transport-level
 *  (no HTTP): "listening" is exactly the bind-conflict + adoption question, and it works even
 *  if the gateway's HTTP surface changes. Never throws. */
export function isGatewayListening(port: number = gatewaySupervisorPort(), timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (up: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(up);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

export interface GatewaySpawnPlan {
  cmd: string;
  args: string[];
  /** Extra env entries layered over process.env for the child. */
  env: Record<string, string>;
  mode: 'bundled-reexec' | 'dev-tsx';
}

/**
 * Decide HOW to spawn the gateway process — pure, exported for tests.
 * `selfPath` = this module's resolved file (import.meta). In a packaged build esbuild has
 * inlined this module into serve.mjs, so selfPath IS the bundle (not .ts) → re-exec it in
 * gateway mode under the bundled node. In dev it's the real .ts → `npx tsx bin.ts`.
 */
export function buildGatewaySpawnPlan(opts?: {
  selfPath?: string;
  execPath?: string;
  moduleDirOverride?: string;
}): GatewaySpawnPlan {
  const selfPath = opts?.selfPath ?? fileURLToPath(import.meta.url);
  const execPath = opts?.execPath ?? process.execPath;
  const dir = opts?.moduleDirOverride ?? moduleDir;
  const isBundled = !selfPath.endsWith('.ts') && !selfPath.endsWith('.tsx');
  if (isBundled) {
    return {
      cmd: execPath,
      args: [selfPath],
      env: { PAPERCUSP_GATEWAY_SIDECAR_MODE: '1' },
      mode: 'bundled-reexec',
    };
  }
  // Dev: bin.ts is a SIBLING of this module (same dir) — no fragile ../../../ hops.
  return {
    cmd: 'npx',
    args: ['tsx', path.join(dir, 'bin.ts')],
    env: {},
    mode: 'dev-tsx',
  };
}

export type EnsureGatewayOutcome = 'disabled' | 'already-running' | 'adopted-external' | 'spawned';

/**
 * Ensure a gateway is serving on the supervisor port: adopt an already-listening one
 * (systemd on the dev box, or another operator instance), else spawn + supervise a child.
 * Idempotent; safe to call from multiple boot paths.
 */
export async function ensureGatewaySidecar(): Promise<EnsureGatewayOutcome> {
  if (process.env.PAPERCUSP_GATEWAY_SUPERVISE === '0') return 'disabled';
  if (gatewayProcess) return 'already-running';

  const port = gatewaySupervisorPort();
  if (await isGatewayListening(port)) {
    // systemd (Linux dev box) or a sibling operator already owns the port — adopt, never
    // double-bind. If IT dies later, nothing here notices (it has its own Restart=always);
    // the periodic health surfaces (gateway-wedge watchdog) cover that case.
    adoptedExternal = true;
    return 'adopted-external';
  }

  await spawnGatewayChild(port);
  return 'spawned';
}

async function spawnGatewayChild(port: number): Promise<void> {
  deliberateStop = false;
  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }

  const plan = buildGatewaySpawnPlan();
  const child = spawn(plan.cmd, plan.args, {
    env: { ...process.env, ...plan.env, PAPERCUSP_GATEWAY_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false, // dies with the operator by default; shutdown hooks drain it first
  });
  gatewayProcess = child;

  const prefix = '[gateway-sidecar]';
  child.stdout?.on('data', (b: Buffer) => {
    for (const line of b.toString().split('\n')) if (line.trim()) console.log(prefix, line);
  });
  child.stderr?.on('data', (b: Buffer) => {
    for (const line of b.toString().split('\n')) if (line.trim()) console.warn(prefix, line);
  });

  child.on('exit', (code, signal) => {
    if (gatewayProcess === child) gatewayProcess = null;
    if (deliberateStop) return;
    console.warn(`${prefix} exited unexpectedly (code=${code} signal=${signal}) — scheduling respawn`);
    scheduleRespawn(port);
  });

  // Readiness = the port actually accepting connections (the gateway binds synchronously
  // after account resolution; PG hiccups make that seconds, not ms — poll up to 30s).
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await isGatewayListening(port, 750)) {
      console.log(`${prefix} up on 127.0.0.1:${port} (${plan.mode}, pid ${child.pid})`);
      return;
    }
    if (gatewayProcess !== child) throw new Error('gateway child exited during startup');
    await new Promise((r) => setTimeout(r, 500));
  }
  // Startup timeout: kill and let the exit handler's respawn circuit decide what's next.
  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  throw new Error(`gateway child did not start listening on :${port} within 30s`);
}

/** Auto-respawn with exponential backoff + a sliding-window circuit breaker, mirroring
 *  substrate-sidecar-spawn (WI-1504). Before each respawn we RE-PROBE the port: if some
 *  other supervisor took it meanwhile (systemd unit restarted), adopt instead of racing. */
function scheduleRespawn(port: number): void {
  if (deliberateStop) return;
  if (respawnTimer) return; // a respawn is already pending
  const now = Date.now();
  respawnAttempts = respawnAttempts.filter((t) => now - t < GATEWAY_RESPAWN_WINDOW_MS);
  if (respawnAttempts.length >= GATEWAY_MAX_RESPAWN_ATTEMPTS) {
    console.error(
      `[gateway-sidecar] ${GATEWAY_MAX_RESPAWN_ATTEMPTS} crashes within ${Math.round(GATEWAY_RESPAWN_WINDOW_MS / 1000)}s — giving up auto-respawn. ` +
        'Agents get connection-refused on :' + port + ' (fail-closed) until an explicit ensureGatewaySidecar() call.',
    );
    return;
  }
  respawnAttempts.push(now);
  const backoffMs = gatewayRespawnBackoffMs(respawnAttempts.length);
  console.warn(`[gateway-sidecar] auto-respawning in ${backoffMs}ms (attempt ${respawnAttempts.length}/${GATEWAY_MAX_RESPAWN_ATTEMPTS} in window)`);
  respawnTimer = setTimeout(() => {
    respawnTimer = null;
    void (async () => {
      try {
        if (await isGatewayListening(port)) {
          adoptedExternal = true;
          console.log('[gateway-sidecar] port re-occupied externally during backoff — adopting, not respawning');
          return;
        }
        await spawnGatewayChild(port);
      } catch (err) {
        console.error('[gateway-sidecar] auto-respawn failed:', err instanceof Error ? err.message : err);
        scheduleRespawn(port); // count another attempt against the window
      }
    })();
  }, backoffMs);
  respawnTimer.unref?.();
}

/** Deliberate stop: SIGTERM (the child drains, bounded by its own HARD_STOP_MS), SIGKILL fallback. */
export async function stopGatewaySidecar(): Promise<void> {
  deliberateStop = true;
  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }
  const child = gatewayProcess;
  if (!child) return;
  await new Promise<void>((resolve) => {
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
      resolve();
    }, 15_000);
    killTimer.unref?.();
    child.once('exit', () => {
      clearTimeout(killTimer);
      resolve();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(killTimer);
      resolve();
    }
  });
  gatewayProcess = null;
}

let hooksRegistered = false;
/** Best-effort drain of the child when the OPERATOR exits (mirrors the sibling spawners). */
export function registerGatewaySidecarShutdownHooks(): void {
  if (hooksRegistered) return;
  hooksRegistered = true;
  const sync = () => {
    deliberateStop = true;
    try {
      gatewayProcess?.kill('SIGTERM');
    } catch {
      /* gone */
    }
  };
  process.on('exit', sync);
  process.on('SIGTERM', sync);
  process.on('SIGINT', sync);
}

// ── test seams ────────────────────────────────────────────────────────────────
export function _resetGatewaySidecarStateForTests(): void {
  gatewayProcess = null;
  deliberateStop = false;
  respawnAttempts = [];
  if (respawnTimer) clearTimeout(respawnTimer);
  respawnTimer = null;
  adoptedExternal = false;
}
export function _gatewaySidecarStateForTests(): {
  running: boolean;
  adoptedExternal: boolean;
  pendingRespawn: boolean;
  attemptsInWindow: number;
} {
  return {
    running: gatewayProcess != null,
    adoptedExternal,
    pendingRespawn: respawnTimer != null,
    attemptsInWindow: respawnAttempts.length,
  };
}
