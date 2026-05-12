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
 * True iff we have *any* path to spawn a native terminal.
 *
 * Two paths, tried in order at click time:
 *   1. Server-side spawn via /api/agent-mcp/console/launch — the
 *      operator process is running as the user with their DISPLAY
 *      and PATH. Works in browser dev (:3055), Tauri dev, and prod.
 *      Linux only for now.
 *   2. Tauri IPC via commands.consoleLaunch — only when in a Tauri
 *      webview AND the IPC bridge is wired. Original design; left
 *      as a fallback for completeness.
 *
 * Both paths fall back to throwing if neither works, and the renderer
 * shows a clear toast with the reason.
 *
 * Returns true in dev browser too — because the server-side path
 * actually works there. That's a design shift from "desktop only" but
 * a correct one: if the operator can launch a terminal, why hide it?
 */
export function isConsoleLauncherSupported(): boolean {
  // Loopback operator can always serve the server-side spawn endpoint
  // when running on Linux. We don't actually feature-detect the OS at
  // load-time because we don't know the operator's OS from JS; we
  // assume it's available and let the click surface a clear error if
  // it isn't.
  return true;
}

function hasTauriInvoke(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: unknown } };
  return typeof w.__TAURI_INTERNALS__?.invoke === 'function';
}

export async function launchNativeConsole(opts: LaunchOpts): Promise<void> {
  console.info('[console-launcher] click', { opts, hasTauri: hasTauriInvoke() });

  // Path 1: server-side spawn via the operator. This is the
  // most-resilient path — bypasses Tauri IPC entirely.
  try {
    console.info('[console-launcher] trying server-side spawn');
    const r = await fetch('/api/agent-mcp/console/launch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: opts.slug }),
    });
    const data = await r.json().catch(() => ({ status: 'error', error: 'invalid JSON' }));
    console.info('[console-launcher] server-side result', data);
    if (r.ok && data?.status === 'ok') return;
    // 501 = "not implemented for this OS" — fall through to Tauri.
    // Other errors (loopback, terminal not found) — surface.
    if (r.status !== 501) {
      throw new Error(data?.error ?? `console/launch HTTP ${r.status}`);
    }
    console.info('[console-launcher] server-side returned 501; falling through to Tauri');
  } catch (e: any) {
    if (!hasTauriInvoke()) {
      throw e;
    }
    console.info('[console-launcher] server-side failed; trying Tauri', e?.message);
  }

  // Path 2: Tauri IPC. Same wire we had before; kept for completeness
  // and to give us a non-Linux story when the time comes.
  const resolveR = await fetch('/api/agent-mcp/console/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: opts.slug }),
  });
  if (!resolveR.ok) {
    const detail = await resolveR.json().catch(() => null);
    throw new Error(detail?.error ?? `console/resolve HTTP ${resolveR.status}`);
  }
  const envelope = (await resolveR.json()) as ConsoleEnvelope;
  const { commands } = await import('./tauri-bindings');
  const launchFn = (commands as { consoleLaunch?: (e: ConsoleEnvelope) => Promise<unknown> })
    .consoleLaunch;
  if (typeof launchFn !== 'function') {
    throw new Error(
      'No spawn path available — operator endpoint not Linux and Tauri bindings missing console_launch',
    );
  }
  const result = await launchFn(envelope) as
    | { status: 'ok'; pid?: number | null }
    | { status: 'err'; error: string }
    | null;
  console.info('[console-launcher] tauri result', result);
  if (result && 'status' in result && (result.status === 'err' || (result as any).Err)) {
    const err = (result as any).error ?? (result as any).Err?.error ?? 'console_launch failed';
    throw new Error(err);
  }
}
