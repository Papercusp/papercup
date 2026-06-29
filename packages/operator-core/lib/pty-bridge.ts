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
 *   - A process-wide cap (`maxConcurrentPtys()`, host-scaled) prevents
 *     fork-bombs from bugged UIs.
 *
 * This module is server-only — it imports `node-pty`, which loads a native
 * binding. Don't import it from a client component.
 */
import { spawn, type IPty } from '@lydell/node-pty';
import { randomUUID } from 'node:crypto';
import * as xtermHeadless from '@xterm/headless';
import * as xtermAddonSerialize from '@xterm/addon-serialize';
import { getCachedRateLimitConfig } from './rate-limit-config';
import { getResourceProfile } from './resource-profile';
import { managedSetInterval } from '@papercusp/scheduled-registry';

// @xterm/headless + @xterm/addon-serialize are CJS; their named exports aren't
// statically visible to ESM named-import LINKING (cjs-module-lexer) under tsx now
// that operator-core is `"type": "module"`, so `import { Terminal } from …` fails
// to link. A namespace import resolves the constructor at runtime instead — and,
// unlike a renamed `createRequire`, stays statically inlinable by the desktop
// sidecar's esbuild bundle (a createRequire'd literal would not inline → "cannot
// find module" in the shipped sidecar).
// Lazy-resolve at call time (not module load) to work around CJS interop timing
// race on first spawnPty call in wake-resume flow.
const getHeadlessTerminal = () => xtermHeadless.Terminal ?? (xtermHeadless as any).default?.Terminal;
const getSerializeAddon = () => xtermAddonSerialize.SerializeAddon ?? (xtermAddonSerialize as any).default?.SerializeAddon;

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
  /**
   * The coord owner (PAPERCUSP_SID) this pty was spawned for, captured from the
   * spawn env. null when the spawn carried no SID (a shell/REPL pane, a legacy
   * untagged spawn). The wake executor matches on it to prevent a recycled pid
   * from routing one agent's wake turn into another agent's session (EI-151).
   */
  ownerSid: string | null;
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
   * Persistent ring buffer of bytes the pty has emitted, capped at
   * HISTORY_CAP_BYTES. Kept as a fallback for clients that don't want
   * a full screen-state replay (notably the SSE path, which streams
   * raw bytes anyway and benefits from the same byte representation).
   */
  history: Buffer[];
  historyBytes: number;
  /**
   * P4: server-side xterm-headless instance fed every byte the pty
   * emits. Lets us replay bounded screen state on reconnect (a few KB
   * of ANSI escapes) instead of the full byte history. Geometry-
   * correct for vim/htop because the headless Terminal resizes
   * alongside the pty.
   */
  headless: InstanceType<ReturnType<typeof getHeadlessTerminal>>;
  serializer: InstanceType<ReturnType<typeof getSerializeAddon>>;
}

const HISTORY_CAP_BYTES = 1024 * 1024;
const HEADLESS_SCROLLBACK = 1000;

// Absolute backstop; the LIVE cap is min(this, the user's maxSimultaneousAgents) — the
// rate-limit-layer-v2 D-004 fleet knob also bounds interactive panes. F-E2 of
// app-wide-load-traps: the backstop SCALES to the host (resource-profile's cores-derived
// agent budget, 2× buffer over it, capped at the original 16) instead of a fixed big-box
// literal — so a 4-core laptop's fork-bomb backstop is ~2-4, not 16. Pure, exported for tests.
const MAX_CONCURRENT_PTYS_CEILING = 16;
export function deriveMaxConcurrentPtys(maxSimultaneousAgents: number): number {
  const agents =
    Number.isFinite(maxSimultaneousAgents) && maxSimultaneousAgents > 0 ? maxSimultaneousAgents : 1;
  return Math.min(Math.ceil(agents * 2), MAX_CONCURRENT_PTYS_CEILING);
}

/** The host-scaled absolute pty backstop (F-E2): 2× the resource-profile agent budget,
    capped at the legacy 16. Memoized via getResourceProfile(). */
function maxConcurrentPtys(): number {
  return deriveMaxConcurrentPtys(getResourceProfile().maxSimultaneousAgents);
}

/** The live pty cap: the user's fleet-wide maxSimultaneousAgents (live-editable, D-004)
    clamped by the host-scaled maxConcurrentPtys() backstop. */
function livePtyCap(): number {
  const fleet = getCachedRateLimitConfig().maxSimultaneousAgents;
  const backstop = maxConcurrentPtys();
  return Number.isFinite(fleet) && fleet > 0 ? Math.min(backstop, fleet) : backstop;
}
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const REAPER_INTERVAL_MS = 30 * 1000;

// Pin module state on globalThis so multiple compiled instances of this
// module share the same Map. Next.js 16 bundles instrumentation.ts and
// API routes separately — without this, the WS server (lib/pty-ws.ts,
// imported from instrumentation.ts) sees an empty handles map even
// though the Hono /spawn route just registered a handle.
type Globals = typeof globalThis & {
  __papercuspPtyHandles?: Map<string, PtyHandle>;
  __papercuspPtyReaperStarted?: boolean;
};
const _globals = globalThis as Globals;
const handles: Map<string, PtyHandle> = _globals.__papercuspPtyHandles ?? new Map<string, PtyHandle>();
_globals.__papercuspPtyHandles = handles;

function startReaper(): void {
  if (_globals.__papercuspPtyReaperStarted) return;
  _globals.__papercuspPtyReaperStarted = true;
  managedSetInterval('pty-idle-reaper', REAPER_INTERVAL_MS, () => {
    const now = Date.now();
    for (const handle of handles.values()) {
      if (handle.killed) continue;
      if (now - handle.lastActivityMs > IDLE_TIMEOUT_MS) {
        killPty(handle.id);
      }
    }
  }, { category: 'global-sweep' });
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
  const cap = livePtyCap();
  if (live >= cap) {
    throw new PtyError(
      `pty cap reached (${live}/${cap})`,
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
      // F3: cooperate with node-pty's built-in XON/XOFF handling for
      // children that emit flow-control bytes. omp/pi don't normally
      // emit raw XOFF (they're TUIs that own input directly), but
      // shells in the pty might. Pairs with the F2 watermark in
      // pty-ws.ts: F2 throttles on bytes the *server* hasn't yet
      // ack'd from the client; F3 throttles on the kernel-pty side.
      // PAPERCUSP_PTY_FLOW_CONTROL=0 disables.
      handleFlowControl: process.env.PAPERCUSP_PTY_FLOW_CONTROL !== '0',
    });
  } catch (err) {
    throw new PtyError(
      `failed to spawn ${opts.command}: ${(err as Error).message}`,
      'SPAWN_FAILED',
    );
  }

  const id = randomUUID();
  const T = getHeadlessTerminal();
  const S = getSerializeAddon();
  if (!T) {
    throw new PtyError(
      'HeadlessTerminal constructor not resolved (CJS interop)',
      'TERMINAL_CONSTRUCTOR_FAILED',
    );
  }
  if (!S) {
    throw new PtyError(
      'SerializeAddon constructor not resolved (CJS interop)',
      'SERIALIZE_ADDON_FAILED',
    );
  }
  const headless = new T({
    cols: opts.cols,
    rows: opts.rows,
    scrollback: HEADLESS_SCROLLBACK,
    allowProposedApi: true,
  });
  const serializer = new S();
  headless.loadAddon(serializer);

  const handle: PtyHandle = {
    id,
    pty,
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    ownerSid: opts.env?.PAPERCUSP_SID ?? null,
    startedAtMs: Date.now(),
    lastActivityMs: Date.now(),
    killed: false,
    exitCode: null,
    onData: new Set(),
    onExit: new Set(),
    history: [],
    historyBytes: 0,
    headless,
    serializer,
  };
  handles.set(id, handle);

  pty.onData((chunk) => {
    handle.lastActivityMs = Date.now();
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    // Maintain raw byte ring (SSE fallback path).
    handle.history.push(buf);
    handle.historyBytes += buf.length;
    while (handle.historyBytes > HISTORY_CAP_BYTES && handle.history.length > 1) {
      const dropped = handle.history.shift()!;
      handle.historyBytes -= dropped.length;
    }
    // Mirror into the headless terminal — feeds the SerializeAddon so
    // getScreenSerialization() always reflects the live pty state.
    // xterm-headless accepts strings (already-decoded code points)
    // OR Uint8Array (UTF-8 decode); we have a Buffer so converting
    // to Uint8Array is the cheap correct thing.
    try {
      handle.headless.write(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
    } catch { /* a write in the wrong state — drop, the byte ring is authoritative */ }
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
    // Drop the handle from the map after a grace period so a late-
    // arriving subscriber can still read the final screen state, but
    // we don't accumulate dead entries that count against the cap or
    // grow the map indefinitely. 30 s is well past any realistic
    // reconnect window.
    setTimeout(() => {
      handles.delete(id);
      try { handle.headless.dispose(); } catch { /* */ }
    }, 30_000).unref?.();
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
    // Mirror to the headless terminal so the serialized state matches
    // what curses apps will draw at the new geometry.
    try { handle.headless.resize(cols, rows); } catch { /* */ }
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
  // Free the headless terminal — no consumers can ask for replay once
  // a pty is explicitly killed (vs the soft "client disconnected" path
  // where the handle stays alive for resume).
  try { handle.headless.dispose(); } catch { /* already disposed */ }
  return true;
}

/** Mark this pty as actively consumed by a subscriber so the reaper spares it. */
export function markActive(id: string): void {
  const handle = handles.get(id);
  if (handle) handle.lastActivityMs = Date.now();
}

/**
 * Snapshot the persistent history buffer. Does NOT drain — survives any
 * number of subscriber attach/detach cycles so a tab switch (PiPanel
 * unmount → remount) can replay the full session into a fresh xterm.
 * Returns null if empty. Used by the SSE fallback path; modern WS
 * clients prefer getScreenSerialization which is bounded by screen
 * size rather than session bytes.
 */
export function getHistory(id: string): Buffer | null {
  const handle = handles.get(id);
  if (!handle || handle.history.length === 0) return null;
  return Buffer.concat(handle.history);
}

/**
 * P4 replay: serialize the current xterm-headless screen state to a
 * string of ANSI escapes. Writing this string into a fresh client
 * xterm reproduces the exact on-screen state without replaying every
 * byte the pty has ever emitted.
 *
 * Bounded by terminal size + scrollback (HEADLESS_SCROLLBACK rows),
 * which is typically tens of KB regardless of session length. Uses
 * VS Code's same approach for remote terminal restore.
 *
 * Async: xterm-headless `Terminal.write()` is queued — we MUST flush
 * the queue before serializing or a fast reconnect can race the
 * mirror-write and produce an empty screen. The flush is a no-op
 * write whose callback fires after every prior queued write commits.
 *
 * Returns null if the pty is unknown or the headless terminal has
 * been disposed.
 */
export async function getScreenSerialization(id: string): Promise<string | null> {
  const handle = handles.get(id);
  if (!handle) return null;
  try {
    await new Promise<void>((resolve) => handle.headless.write('', resolve));
    return handle.serializer.serialize({ scrollback: HEADLESS_SCROLLBACK });
  } catch {
    return null;
  }
}

/**
 * Look up a pty by id. Returns metadata if alive, null if missing/dead.
 * Used by /pty/spawn to honor a `resumePtyId` request from a remounting
 * client.
 */
export function getPtyMeta(id: string): { id: string; command: string; args: readonly string[]; cwd: string; pid: number } | null {
  const handle = handles.get(id);
  if (!handle || handle.killed) return null;
  return {
    id: handle.id,
    command: handle.command,
    args: handle.args,
    cwd: handle.cwd,
    pid: handle.pty.pid,
  };
}

/**
 * Find a live pty whose process (or the process it spawned — same pid for
 * direct spawns) matches `pid`. Used by the await-event wake executor
 * (events/await/wake-executor.ts) to pick the inject channel when the
 * sleeping agent's session is one of OUR managed ptys. Returns null when no
 * live handle matches — most sessions (detached terminal emulators) won't.
 *
 * Cross-agent misroute guard (EI-151): a recorded pid can be RECYCLED by the OS
 * to a DIFFERENT agent's live managed pty after the original session exits
 * uncleanly (its adv_sessions row never marked ended). Matching on pid alone
 * would then route the original subscriber's wake turn into the unrelated
 * agent's session. So when the caller names the owner it expects (`ownerSid`),
 * a handle TAGGED with a different owner is NOT a match. An untagged handle
 * (`ownerSid === null` — a shell pane / legacy spawn) still matches: it carries
 * no contrary evidence, so this is never stricter than the pid-only behavior.
 */
export function findPtyByPid(pid: number, ownerSid?: string | null): PtyHandle | null {
  for (const h of handles.values()) {
    if (h.killed || h.exitCode !== null || h.pty.pid !== pid) continue;
    if (ownerSid && h.ownerSid && h.ownerSid !== ownerSid) continue; // recycled-pid misroute
    return h;
  }
  return null;
}

/** Stats for an `/api/desktop/pty/stats` debug endpoint or similar. */
export function ptyStats(): { live: number; cap: number; total: number } {
  let live = 0;
  for (const h of handles.values()) if (!h.killed) live++;
  return { live, cap: livePtyCap(), total: handles.size };
}
