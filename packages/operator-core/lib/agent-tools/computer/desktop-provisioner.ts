/**
 * desktop-provisioner.ts — stand up a disposable, ISOLATED sandbox desktop
 * (Xvfb + window manager + optional apps) for a bee to operate through
 * capability:computer. NEVER the host display :0.
 *
 * Two worlds, one shape:
 *   - On a deployed desktop FRAME, the Xvfb displays are pre-stood-up by
 *     `frame-bootstrap` and leased per-agent via `display-allocator`
 *     (`acquireAgentDisplay`), which sets the agent's DISPLAY. This provisioner
 *     is NOT used there.
 *   - On a plain box (local dev / a single-node demo), THIS provisioner starts
 *     its own Xvfb + WM + apps so the capability works without the cloud frame.
 *     It is also the reference for exactly what the frame bootstrap does.
 *
 * The returned `display` is what the capability:computer lease env
 * (`PAPERCUSP_COMPUTER_DISPLAY`) is set to for the operating agent.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { sandboxXEnv } from './desktop-driver';

const DEFAULT_W = 1024;
const DEFAULT_H = 768;
const BASE_DISPLAY = 110; // well clear of :0 (host) and the frame pool default (:99)

export interface SandboxDesktop {
  /** X display string, e.g. ":110". Set this as PAPERCUSP_COMPUTER_DISPLAY for the agent. */
  display: string;
  number: number;
  width: number;
  height: number;
  /** Tear the desktop down — kill apps, WM, Xvfb. Idempotent. */
  release: () => Promise<void>;
}

export interface ProvisionOptions {
  /** Force a display number (must be > 0). Default: lowest free ≥ 110. */
  displayNumber?: number;
  width?: number;
  height?: number;
  /** Launch a window manager (openbox). Default true. */
  windowManager?: boolean;
  /** Apps to launch on the desktop, as argv arrays (e.g. [['xterm'], ['firefox','--no-remote']]). */
  apps?: string[][];
  /** How long to wait for the X server to accept connections. Default 8s. */
  readyTimeoutMs?: number;
}

/**
 * Lowest free display number ≥ base (no `/tmp/.X<n>-lock`), NEVER 0. Pure over
 * an injectable `exists` so it unit-tests without touching the filesystem.
 */
export function findFreeDisplayNumber(base = BASE_DISPLAY, max = 250, exists: (p: string) => boolean = existsSync): number {
  const from = Math.max(1, base); // never :0
  for (let n = from; n <= max; n++) {
    if (!exists(`/tmp/.X${n}-lock`)) return n;
  }
  throw new Error(`desktop-provisioner — no free X display number in [${from}, ${max}]`);
}

/** True once an X server on `display` accepts connections (xdpyinfo succeeds). */
function displayReady(display: string): boolean {
  try {
    return spawnSync('xdpyinfo', ['-display', display], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

async function waitForDisplay(display: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Time is read inside the loop; the helper is only reached on the live path.
  // eslint-disable-next-line no-restricted-syntax
  while (Date.now() < deadline) {
    if (displayReady(display)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`desktop-provisioner — X display ${display} did not come up within ${timeoutMs}ms`);
}

/**
 * Provision a disposable sandbox desktop. Starts Xvfb on a free display (never
 * :0), an openbox WM, and any requested apps; returns a handle whose `release()`
 * tears it all down. Throws if Xvfb never comes up (releasing what it started).
 */
export async function provisionSandboxDesktop(opts: ProvisionOptions = {}): Promise<SandboxDesktop> {
  const number = opts.displayNumber ?? findFreeDisplayNumber();
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`desktop-provisioner — refusing to provision on display :${number} (host :0 / invalid)`);
  }
  const display = `:${number}`;
  const width = opts.width ?? DEFAULT_W;
  const height = opts.height ?? DEFAULT_H;
  const procs: ChildProcess[] = [];

  const release = async (): Promise<void> => {
    for (const p of [...procs].reverse()) {
      try { p.kill('SIGTERM'); } catch { /* already gone */ }
    }
    await new Promise((r) => setTimeout(r, 300));
    for (const p of procs) {
      try { p.kill('SIGKILL'); } catch { /* already gone */ }
    }
  };

  try {
    const xvfb = spawn('Xvfb', [display, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp'], { stdio: 'ignore' });
    procs.push(xvfb);
    await waitForDisplay(display, opts.readyTimeoutMs ?? 8000);

    // ISOLATION: the WM + apps run with a host-stripped env bound to the sandbox
    // display only — never the operator's inherited DISPLAY=:0 / gdm XAUTHORITY.
    const env = sandboxXEnv(display);
    if (opts.windowManager !== false) {
      procs.push(spawn('openbox', [], { env, stdio: 'ignore' }));
    }
    for (const argv of opts.apps ?? []) {
      if (argv.length === 0) continue;
      procs.push(spawn(argv[0]!, argv.slice(1), { env, stdio: 'ignore' }));
    }
    return { display, number, width, height, release };
  } catch (e) {
    await release(); // never leak a half-provisioned Xvfb
    throw e;
  }
}
