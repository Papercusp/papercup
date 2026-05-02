/**
 * Server-side wrapper around node-pty for embedded terminal panes.
 *
 * Spawns child processes with a pseudo-terminal so interactive TUIs (pi/omp,
 * shells, REPLs, etc.) work end-to-end inside the harness UI's xterm.js pane.
 * The Hono pty router (`_hono/pty.ts`) mediates the HTTP/SSE transport
 * between the browser and these handles.
 *
 * Process lifecycle:
 *   - Each call to `spawnPty` produces a new IPty handle keyed by uuid.
 *   - Handles register an onData listener to fan bytes out to subscribers.
 *   - The router calls `kill()` on disconnect; idle handles auto-kill via
 *     `markActive()` not having been called for `IDLE_TIMEOUT_MS`.
 *   - A process-wide cap (`MAX_CONCURRENT_PTYS`) prevents fork-bombs from
 *     bugged UIs.
 *
 * This module is server-only — it imports `node-pty`, which loads a native
 * binding. Don't import it from a client component.
 */
import { spawn, type IPty } from '@lydell/node-pty';
import { randomUUID } from 'node:crypto';

export interface SpawnPtyOpts {
  /** Binary to launch (e.g. 'omp', 'bash', '/usr/local/bin/omp'). */
  command: string;
  /** Arguments to pass. */
  args: readonly string[];
  /** Working directory. */
  cwd: string;
  /** Environment to pass; merged with sidecar env. */
  env?: Record<string, string | undefined>;
  /** Initial terminal size. xterm.js sends a resize on its first frame too. */
  cols: number;
  rows: number;
}

export interface PtyHandle {
  id: string;
  pty: IPty;
  command: string;
  args: readonly string[];
  cwd: string;
  startedAtMs: number;
  /** Track activity so the idle reaper can drop ghost handles. */
  lastActivityMs: number;
  /** Has this handle been killed (by user, idle reaper, or process exit)? */
  killed: boolean;
  /** Exit code, set after the underlying process exits. */
  exitCode: number | null;
  /** Subscribers for stdout bytes — Hono SSE handlers register here. */
  onData: Set<(chunk: Buffer) => void>;
  /** Fired once the underlying process exits. */
  onExit: Set<(code: number, signal: number) => void>;
  /**
   * Bytes received before any SSE subscriber connected. Used by the
   * prewarm path: a handle is spawned eagerly, runs for a few hundred
   * ms producing the omp banner + initial prompt, and only later does
   * the UI's SSE consumer attach. Without replay, that early output is
   * dropped and the user sees an empty pane.
   *
   * Capped at REPLAY_CAP_BYTES — once exceeded we drop the oldest
   * chunk. Cleared after first subscribe.
   */
  replayBuffer: Buffer[];
  replayBytes: number;
  replayClosed: boolean;
}

const REPLAY_CAP_BYTES = 256 * 1024;

const MAX_CONCURRENT_PTYS = 16;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const REAPER_INTERVAL_MS = 30 * 1000;

const handles = new Map<string, PtyHandle>();
let reaperStarted = false;

function startReaper(): void {
  if (reaperStarted) return;
  reaperStarted = true;
  setInterval(() => {
    const now = Date.now();
    for (const handle of handles.values()) {
      if (handle.killed) continue;
      if (now - handle.lastActivityMs > IDLE_TIMEOUT_MS) {
        killPty(handle.id);
      }
    }
  }, REAPER_INTERVAL_MS).unref?.();
}

export class PtyError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'PtyError';
  }
}

/** Create a new pty-backed subprocess. Throws on cap or spawn failure. */
export function spawnPty(opts: SpawnPtyOpts): PtyHandle {
  startReaper();

  const live = Array.from(handles.values()).filter((h) => !h.killed).length;
  if (live >= MAX_CONCURRENT_PTYS) {
    throw new PtyError(
      `pty cap reached (${live}/${MAX_CONCURRENT_PTYS})`,
      'PTY_CAP_REACHED',
    );
  }

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }

  let pty: IPty;
  try {
    pty = spawn(opts.command, [...opts.args], {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env,
    });
  } catch (err) {
    throw new PtyError(
      `failed to spawn ${opts.command}: ${(err as Error).message}`,
      'SPAWN_FAILED',
    );
  }

  const id = randomUUID();
  const handle: PtyHandle = {
    id,
    pty,
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    startedAtMs: Date.now(),
    lastActivityMs: Date.now(),
    killed: false,
    exitCode: null,
    onData: new Set(),
    onExit: new Set(),
    replayBuffer: [],
    replayBytes: 0,
    replayClosed: false,
  };
  handles.set(id, handle);

  pty.onData((chunk) => {
    handle.lastActivityMs = Date.now();
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    if (!handle.replayClosed) {
      handle.replayBuffer.push(buf);
      handle.replayBytes += buf.length;
      while (handle.replayBytes > REPLAY_CAP_BYTES && handle.replayBuffer.length > 1) {
        const dropped = handle.replayBuffer.shift()!;
        handle.replayBytes -= dropped.length;
      }
    }
    for (const sub of handle.onData) {
      try { sub(buf); } catch { /* subscriber threw — drop it next loop */ }
    }
  });

  pty.onExit(({ exitCode, signal }) => {
    handle.killed = true;
    handle.exitCode = exitCode;
    for (const sub of handle.onExit) {
      try { sub(exitCode, signal ?? 0); } catch { /* ignore */ }
    }
    handle.onData.clear();
    handle.onExit.clear();
  });

  return handle;
}

export function getPty(id: string): PtyHandle | undefined {
  return handles.get(id);
}

/** Write user keystrokes to the pty stdin. No-op if killed. */
export function writePty(id: string, data: Buffer): boolean {
  const handle = handles.get(id);
  if (!handle || handle.killed) return false;
  handle.lastActivityMs = Date.now();
  handle.pty.write(data.toString('utf8'));
  return true;
}

/** Resize the underlying pty. No-op if killed. */
export function resizePty(id: string, cols: number, rows: number): boolean {
  const handle = handles.get(id);
  if (!handle || handle.killed) return false;
  handle.lastActivityMs = Date.now();
  try {
    handle.pty.resize(cols, rows);
    return true;
  } catch {
    return false;
  }
}

/** Kill the pty process. Idempotent. */
export function killPty(id: string): boolean {
  const handle = handles.get(id);
  if (!handle) return false;
  if (!handle.killed) {
    try { handle.pty.kill(); } catch { /* already dying */ }
    handle.killed = true;
  }
  return true;
}

/** Mark this pty as actively consumed by a subscriber so the reaper spares it. */
export function markActive(id: string): void {
  const handle = handles.get(id);
  if (handle) handle.lastActivityMs = Date.now();
}

/**
 * Drain the replay buffer (bytes produced before any SSE subscriber
 * connected) and stop further buffering. Returns the merged Buffer or
 * null if there's nothing buffered. Idempotent — second call returns
 * null.
 */
export function consumeReplay(id: string): Buffer | null {
  const handle = handles.get(id);
  if (!handle || handle.replayClosed) return null;
  handle.replayClosed = true;
  if (handle.replayBuffer.length === 0) return null;
  const merged = Buffer.concat(handle.replayBuffer);
  handle.replayBuffer = [];
  handle.replayBytes = 0;
  return merged;
}

/** Stats for an `/api/desktop/pty/stats` debug endpoint or similar. */
export function ptyStats(): { live: number; cap: number; total: number } {
  let live = 0;
  for (const h of handles.values()) if (!h.killed) live++;
  return { live, cap: MAX_CONCURRENT_PTYS, total: handles.size };
}
