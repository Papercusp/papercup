/**
 * pty-tauri.ts — renderer-side wrapper for the Tauri native pty path (E).
 *
 * When the operator UI is running inside the Tauri webview, we bypass
 * the operator's HTTP+WS bridge for ptys and route directly through
 * Tauri commands. The pty fork lives in the Rust process, output is
 * delivered via Tauri events (in-process IPC), input via invoke().
 *
 * The harness-aware config (omp args, worktree cwd, env) still comes
 * from the operator — POST /pty/resolve returns what /pty/spawn would
 * have built, without forking. We then hand that to invoke('pty_spawn').
 *
 * Why split control plane from data plane?
 *   - The operator already knows about feature prompts, worktrees, MCP
 *     server registration, the papercusp-pi extension, etc. Re-implementing
 *     all of that in Rust would mean duplicating ~500 lines of resolution
 *     logic that's already battle-tested in pty.ts.
 *   - The data path is what's latency-critical, and that's where Tauri's
 *     in-process IPC beats localhost WebSocket.
 *
 * Public API mirrors what PiPanel needs:
 *   - isTauriNative()           — feature-detect
 *   - openNativeSession(opts)   — POST /resolve + invoke pty_spawn + listen
 *
 * The returned NativeSession object exposes onData/onExit subscriptions,
 * write/resize/kill methods, and a history() helper for resume.
 */

type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type TauriListenFn = <T>(
  event: string,
  handler: (event: { payload: T }) => void,
) => Promise<() => void>;

interface PaperclipTauriBridge {
  invoke: TauriInvoke;
  listen: TauriListenFn;
}

interface WindowWithTauri extends Window {
  __PAPERCUSP_TAURI__?: { kind: 'native'; bridge?: PaperclipTauriBridge };
  __TAURI__?: {
    core?: { invoke: TauriInvoke };
    event?: { listen: TauriListenFn };
  };
  __TAURI_INTERNALS__?: { invoke: TauriInvoke };
}

/**
 * True iff we're running inside the Tauri webview AND the native pty
 * commands are available. PiPanel calls this to choose its transport.
 */
export function isTauriNative(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as WindowWithTauri;
  if (w.__PAPERCUSP_TAURI__?.kind !== 'native') return false;
  // Tauri 2 exposes invoke under __TAURI_INTERNALS__ (preferred) or
  // __TAURI__.core.invoke. Either is fine.
  return Boolean(w.__TAURI_INTERNALS__?.invoke ?? w.__TAURI__?.core?.invoke);
}

function tauriInvoke(): TauriInvoke {
  const w = window as WindowWithTauri;
  const fn = w.__TAURI_INTERNALS__?.invoke ?? w.__TAURI__?.core?.invoke;
  if (!fn) throw new Error('Tauri invoke not available');
  return fn;
}

function tauriListen(): TauriListenFn {
  const w = window as WindowWithTauri;
  const fn = w.__TAURI__?.event?.listen;
  if (!fn) throw new Error('Tauri event.listen not available');
  return fn;
}

interface ResolveResult {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
}

interface OpenNativeOpts {
  slug: string;
  laneId?: string;
  cols: number;
  rows: number;
  /** If passed and the Rust side reports the id alive, reattach instead of spawning. */
  resumePtyId?: string | null;
}

export interface NativeSession {
  id: string;
  pid: number | null;
  resumed: boolean;
  /** Replay buffer (binary). Empty for a fresh spawn. */
  history: Uint8Array;
  /** Subscribe to bytes from the pty. Returns an unsubscribe fn. */
  onData(handler: (chunk: Uint8Array) => void): () => void;
  /** Subscribe to process exit. Returns an unsubscribe fn. */
  onExit(handler: (code: number) => void): () => void;
  /** Send keystroke bytes. */
  write(data: Uint8Array): Promise<void>;
  /** Notify the pty of a new geometry. */
  resize(cols: number, rows: number): Promise<void>;
  /** Hard-kill the pty. Only call on explicit user close. */
  kill(): Promise<void>;
  /** Drop our event listeners without killing the pty. */
  dispose(): void;
}

/**
 * Open or resume a native pty session for the given slug+laneId. Falls
 * through to a fresh spawn if `resumePtyId` is missing or stale.
 */
export async function openNativeSession(opts: OpenNativeOpts): Promise<NativeSession> {
  const invoke = tauriInvoke();
  const listen = tauriListen();

  // Try resume first.
  let id: string | null = null;
  let pid: number | null = null;
  let resumed = false;
  let history: Uint8Array = new Uint8Array(new ArrayBuffer(0));

  if (opts.resumePtyId) {
    const alive = await invoke<boolean>('pty_is_alive', { id: opts.resumePtyId }).catch(() => false);
    if (alive) {
      id = opts.resumePtyId;
      resumed = true;
      // Pull history.
      const b64 = await invoke<string>('pty_history', { id }).catch(() => '');
      if (b64) history = base64ToBytes(b64);
      // Resize to the new dims now that the renderer is ready.
      try { await invoke<void>('pty_resize', { id, cols: opts.cols, rows: opts.rows }); } catch { /* ignore */ }
    }
  }

  if (!id) {
    // Resolve harness-aware config from the operator (still over HTTP).
    const r = await fetch(`/api/harness/${encodeURIComponent(opts.slug)}/pty/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ laneId: opts.laneId, cols: opts.cols, rows: opts.rows }),
    });
    if (!r.ok) {
      const errBody = await r.json().catch(() => ({} as { error?: string }));
      throw new Error(errBody.error ?? `pty/resolve HTTP ${r.status}`);
    }
    const cfg = (await r.json()) as ResolveResult;
    const result = await invoke<{ id: string; pid: number | null }>('pty_spawn', {
      opts: {
        command: cfg.command,
        args: cfg.args,
        cwd: cfg.cwd,
        env: cfg.env,
        cols: opts.cols,
        rows: opts.rows,
      },
    });
    id = result.id;
    pid = result.pid;
  }

  // Subscribe to pty-data / pty-exit. These are global events keyed by
  // id in the payload, so each session filters.
  const dataHandlers = new Set<(c: Uint8Array) => void>();
  const exitHandlers = new Set<(code: number) => void>();

  const unlistenData = await listen<{ id: string; data: string }>('pty-data', (ev) => {
    if (ev.payload.id !== id) return;
    const bytes = base64ToBytes(ev.payload.data);
    dataHandlers.forEach((h) => { try { h(bytes); } catch { /* ignore */ } });
  });
  const unlistenExit = await listen<{ id: string; code: number }>('pty-exit', (ev) => {
    if (ev.payload.id !== id) return;
    exitHandlers.forEach((h) => { try { h(ev.payload.code); } catch { /* ignore */ } });
  });

  return {
    id: id!,
    pid,
    resumed,
    history,
    onData(handler) { dataHandlers.add(handler); return () => dataHandlers.delete(handler); },
    onExit(handler) { exitHandlers.add(handler); return () => exitHandlers.delete(handler); },
    async write(data) {
      await invoke<void>('pty_write', { id, data: bytesToBase64(data) });
    },
    async resize(cols, rows) {
      await invoke<void>('pty_resize', { id, cols, rows });
    },
    async kill() {
      try { await invoke<void>('pty_kill', { id }); } catch { /* already dead */ }
    },
    dispose() {
      dataHandlers.clear();
      exitHandlers.clear();
      try { unlistenData(); } catch { /* */ }
      try { unlistenExit(); } catch { /* */ }
    },
  };
}

function base64ToBytes(b64: string): Uint8Array {
  if (!b64) return new Uint8Array(new ArrayBuffer(0));
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  // Chunk to avoid call-stack overflow on >64K inputs.
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(s);
}
