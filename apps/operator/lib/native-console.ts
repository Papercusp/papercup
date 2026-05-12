/**
 * native-console.ts — renderer-side wrapper for the Tauri
 * `console_launch` command.
 *
 * Resolves the spawn envelope from the operator's
 * /api/agent-mcp/console/resolve endpoint, then hands it to the
 * Rust side. The Rust side writes the .mcp.json into the cwd and
 * spawns the user's OS-native terminal in a new window.
 */

export interface LaunchOpts {
  slug: string | null;
}

interface ConsoleEnvelope {
  cwd: string;
  env: Record<string, string>;
  mcpJsonContents: string;
  greetingCmd: string;
  needsSuperuserBootstrap: boolean;
}

/**
 * True iff we're running inside a Tauri webview that can invoke
 * commands.
 *
 * Why not isTauriNative() from pty-tauri.ts: that function gates on
 * window.__PAPERCUSP_TAURI__, a marker the desktop app only sets in
 * production mode (main.rs:1168 lives inside the prod setup branch;
 * dev returns early). In dev Tauri the operator IS running in a Tauri
 * webview — __TAURI_INTERNALS__.invoke is wired — but the marker
 * isn't, so isTauriNative() returns false and the console launcher
 * thinks it's in a plain browser. That's the bug that made the click
 * silently no-op for the user.
 *
 * The console launcher only needs `invoke` (no per-event listen, no
 * pty IPC), so checking __TAURI_INTERNALS__ directly works in both
 * dev and prod.
 */
export function isConsoleLauncherSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: unknown } };
  return typeof w.__TAURI_INTERNALS__?.invoke === 'function';
}

export async function launchNativeConsole(opts: LaunchOpts): Promise<void> {
  if (!isConsoleLauncherSupported()) {
    throw new Error('Native console is only available in the desktop app');
  }

  // 1. Resolve envelope from the operator.
  const r = await fetch('/api/agent-mcp/console/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: opts.slug }),
  });
  if (!r.ok) {
    const detail = await r.json().catch(() => null);
    throw new Error(detail?.error ?? `console/resolve HTTP ${r.status}`);
  }
  const envelope = (await r.json()) as ConsoleEnvelope;

  // 2. Hand to Tauri. Type bindings come from `tauri-bindings.ts`
  //    once `console_launch` is regenerated on the next Tauri build.
  //    Until then we use the raw IPC channel.
  const win = window as unknown as {
    __TAURI_INTERNALS__?: {
      invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
    };
  };
  const invoke = win.__TAURI_INTERNALS__?.invoke;
  if (!invoke) throw new Error('Tauri invoke not available');

  const result = await invoke<{ status: 'ok' | 'err'; error?: string }>('console_launch', {
    envelope,
  });
  if (result?.status === 'err') {
    throw new Error(result.error ?? 'console_launch failed');
  }
}
