/**
 * desktop-health — P-019 of fleet-coordination-painpoints (Phase 3b).
 *
 * The Tauri DESKTOP shell has no HTTP health endpoint (CLAUDE.md: it's a desktop
 * app, not a webapp), so the endpoint poller in `service-health.ts` can't reach
 * it. This probes it from three signals the desktop exposes locally:
 *
 *   (a) the tauri-agent-tools DEV BRIDGE — a `/eval` round-trip proves the
 *       webview is up AND executes JS (not white-screened / wedged). The bridge
 *       runs ONLY inside the Tauri shell (papercusp-desktop `dev_bridge.rs`), so
 *       a live bridge token (`/tmp/tauri-dev-bridge-<pid>.token` with a live pid)
 *       is also our "is the desktop even running" signal.
 *   (b) the Tauri↔operator IPC unix socket — connectable = the `ipcFetch` channel
 *       the webview's `/api/*` calls ride is alive. A dead one is the Plans-tab
 *       "loading forever" bug, so a present desktop with a dead IPC socket is
 *       genuinely unhealthy. Resolved via `resolveDesktopIpcDiscovery()` (below) —
 *       NOT the raw `~/.papercusp/endpoint-ipc.json` singleton, which is
 *       last-writer-wins across every operator on the box and can point at a
 *       different (possibly dead) operator than the one this desktop targets
 *       (EI-7760).
 *   (c) toastLog.recent — recent ERROR toasts = the app is running but unhappy.
 *       Surfaced as detail (`recentErrors` + the note); it does NOT by itself
 *       flip up/down, so a single transient error toast can't turn into a DOWN
 *       broadcast (Phase 1 just killed the notify firehose — don't recreate it).
 *
 * CRUCIAL non-noise rule: when NO desktop is running (no live bridge token — the
 * common case on the systemd dev box, where the operator runs WITHOUT the
 * desktop), the probe reports `present: false`. `diffHealth` skips absent
 * services, so the 1-min tick never broadcasts a phantom "desktop DOWN". We only
 * transition to DOWN when the desktop IS present but a liveness signal fails.
 *
 * The signal-gatherers are injected (`DesktopSignals`) so the decision logic is
 * unit-tested without a live desktop / bridge / kopia.
 */
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import type { ProbeResult } from './service-health';
import { readEndpointIpcDiscovery, readEndpointIpcDiscoveryForPort, type EndpointIpcDiscovery } from './endpoint-ipc-discovery';
import { listToasts } from './toast-log-data';

/** Error-toast look-back window — matches the 1-min service-health tick. */
export const DESKTOP_ERROR_WINDOW_MS = 60_000;

const BRIDGE_TOKEN_DIR = '/tmp';
const BRIDGE_TOKEN_PREFIX = 'tauri-dev-bridge-';
const BRIDGE_TOKEN_SUFFIX = '.token';

export interface LiveBridge {
  port: number;
  token: string;
  pid: number;
}

/** Injectable signal-gatherers — real impls below; tests pass stubs. */
export interface DesktopSignals {
  /** A live tauri dev-bridge if the desktop is running, else null. */
  liveBridge(): Promise<LiveBridge | null>;
  /** A `/eval` round-trip through the webview succeeds (webview up + JS works). */
  bridgeEval(bridge: LiveBridge): Promise<boolean>;
  /** The operator IPC unix socket is connectable. */
  ipcConnectable(): Promise<boolean>;
  /** Count of ERROR toasts in the last `windowMs`. */
  recentErrorCount(windowMs: number): Promise<number>;
}

function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process (dead); EPERM = alive but not ours (still alive).
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** Scan /tmp for a dev-bridge token whose owning pid is alive (stale = ignored). */
async function realLiveBridge(): Promise<LiveBridge | null> {
  let files: string[];
  try {
    files = await readdir(BRIDGE_TOKEN_DIR);
  } catch {
    return null;
  }
  for (const f of files) {
    if (!f.startsWith(BRIDGE_TOKEN_PREFIX) || !f.endsWith(BRIDGE_TOKEN_SUFFIX)) continue;
    try {
      const j = JSON.parse(await readFile(`${BRIDGE_TOKEN_DIR}/${f}`, 'utf8')) as Partial<LiveBridge>;
      const port = Number(j?.port);
      const token = typeof j?.token === 'string' ? j.token : '';
      const pid = Number(j?.pid);
      if (!port || !token || !pidAlive(pid)) continue;
      return { port, token, pid };
    } catch {
      // unreadable / corrupt token → try the next
    }
  }
  return null;
}

/** POST /eval { js:'1' } to the bridge; a 200 means the webview executed JS. */
async function realBridgeEval(bridge: LiveBridge, timeoutMs = 4000): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${bridge.port}/eval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ js: '1', token: bridge.token }),
      signal: ctl.signal,
    });
    if (!res.ok) return false; // 504 = webview wedged, 401 = bad token
    const j = (await res.json().catch(() => null)) as { result?: unknown; error?: unknown } | null;
    // A round-tripped eval returns a `result`; an `error` field means JS threw.
    return j != null && 'result' in j && j.error == null;
  } catch {
    return false; // bridge process unreachable
  } finally {
    clearTimeout(timer);
  }
}

/** desktop-build-target.json's known content ports → API port (EI-190's api_port_for_target,
 *  mirrored from env_switch.rs): :3055 (bare Vite SPA, no operator of its own) proxies /api
 *  to the :3070 release operator; every other target IS its own API port. Exported for
 *  direct unit testing (mirrors the Rust-side mapping — kept in lockstep by inspection). */
export function apiPortForTarget(targetPort: number): number {
  return targetPort === 3055 ? 3070 : targetPort;
}

/** dev :3270 is "the session's OWN working-tree operator" — the desktop's default target
 *  (env_switch.rs TARGETS[0]) when no persisted choice exists yet. */
export const DEFAULT_DESKTOP_TARGET_PORT = 3270;

/**
 * Resolve which operator's IPC discovery file actually describes THIS desktop's
 * `/api` target — not the shared last-writer-wins singleton (EI-7760).
 *
 * `~/.papercusp/endpoint-ipc.json` (the legacy singleton `readEndpointIpcDiscovery`
 * reads) is overwritten by EVERY operator that boots on this box — and this dev box
 * routinely runs many concurrent harness/fleet dev operators on distinct ports at
 * once. Whichever one wrote LAST wins the singleton, so at any given instant it can
 * point at a completely unrelated (and possibly dead) operator, producing a false
 * "ipc socket unreachable" verdict for a desktop whose OWN configured operator is
 * perfectly healthy (confirmed live 2026-07-05: the singleton pointed at a dead pid
 * while the desktop's actual target — port 3270 per desktop-build-target.json — had
 * a live, connectable socket the whole time).
 *
 * The desktop persists which env it's pointed at in `~/.papercusp/desktop-build-target.json`
 * ({name, port} — the exact file `env_switch.rs`'s Rust side reads/writes), so we read
 * THAT to resolve the per-port discovery file (EI-190) for the operator the desktop
 * actually targets. Falls back to the legacy singleton only if no per-port file exists
 * yet (e.g. a very old operator process pre-dating EI-190) — strictly better than
 * always trusting the racy singleton.
 */
export async function resolveDesktopIpcDiscovery(): Promise<EndpointIpcDiscovery | null> {
  let targetPort = DEFAULT_DESKTOP_TARGET_PORT;
  try {
    const raw = await readFile(join(homedir(), '.papercusp', 'desktop-build-target.json'), 'utf8');
    const j = JSON.parse(raw) as { port?: unknown };
    if (typeof j?.port === 'number' && Number.isFinite(j.port)) targetPort = j.port;
  } catch {
    /* missing/corrupt → use the dev default (:3270), the desktop's own default target */
  }
  const apiPort = apiPortForTarget(targetPort);
  const perPort = await readEndpointIpcDiscoveryForPort(apiPort).catch(() => null);
  if (perPort) return perPort;
  // Fall back to the legacy singleton (better than nothing if no per-port file exists).
  return readEndpointIpcDiscovery();
}

/** Connect to the operator IPC unix socket; success = the channel is alive. */
async function realIpcConnectable(timeoutMs = 2000): Promise<boolean> {
  const disc = await resolveDesktopIpcDiscovery();
  if (!disc?.socketPath) return false;
  return new Promise<boolean>((resolve) => {
    const sock = net.connect(disc.socketPath);
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      done(true);
    });
    sock.once('error', () => {
      clearTimeout(timer);
      done(false);
    });
  });
}

async function realRecentErrorCount(windowMs: number): Promise<number> {
  const since = Date.now() - windowMs;
  const { toasts } = await listToasts({ since, limit: 200 });
  return toasts.filter((t) => t.level === 'error').length;
}

export const realDesktopSignals: DesktopSignals = {
  liveBridge: realLiveBridge,
  bridgeEval: realBridgeEval,
  ipcConnectable: realIpcConnectable,
  recentErrorCount: realRecentErrorCount,
};

/**
 * Probe the desktop. Returns a `ProbeResult` with `present` set:
 *   - present:false → no desktop running (skipped by diffHealth → no DOWN spam).
 *   - present:true, up:true → webview eval + IPC both alive.
 *   - present:true, up:false → desktop is up but a liveness signal failed.
 * `recentErrors` + `note` carry the toastLog signal as informational detail.
 */
export async function probeDesktop(signals: DesktopSignals = realDesktopSignals): Promise<ProbeResult> {
  const start = Date.now();
  const bridge = await signals.liveBridge().catch(() => null);
  if (!bridge) {
    return {
      name: 'desktop',
      up: false,
      present: false,
      status: null,
      latencyMs: Date.now() - start,
      note: 'not running (no live dev-bridge)',
    };
  }

  const [evalOk, ipcOk, recentErrors] = await Promise.all([
    signals.bridgeEval(bridge).catch(() => false),
    signals.ipcConnectable().catch(() => false),
    signals.recentErrorCount(DESKTOP_ERROR_WINDOW_MS).catch(() => 0),
  ]);

  const up = evalOk && ipcOk;
  const errNote = recentErrors > 0 ? `${recentErrors} recent error toast${recentErrors === 1 ? '' : 's'}` : '';
  let note: string;
  if (up) {
    note = errNote ? `up (${errNote})` : 'up';
  } else {
    const fails = [!evalOk && 'webview eval', !ipcOk && 'ipc socket'].filter(Boolean).join(' + ');
    note = `unhealthy: ${fails} unreachable${errNote ? `; ${errNote}` : ''}`;
  }

  return {
    name: 'desktop',
    up,
    present: true,
    status: null,
    latencyMs: Date.now() - start,
    note,
    recentErrors,
  };
}
