/**
 * native-console.ts — renderer-side wrapper for the Tauri
 * `console_launch` command.
 *
 * Resolves the spawn envelope from the operator's
 * /api/agent-mcp/console/resolve endpoint, then hands it to the
 * Rust side. The Rust side writes the .mcp.json into the cwd and
 * spawns the user's OS-native terminal in a new window.
 */

import { isTauriNative } from './pty-tauri';

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
 * True iff we're running in the Tauri desktop bridge. The button hides
 * itself when this returns false — there's no point showing the user
 * a control that can't do anything in a plain browser session.
 */
export function isConsoleLauncherSupported(): boolean {
  return isTauriNative();
}

export async function launchNativeConsole(opts: LaunchOpts): Promise<void> {
  if (!isTauriNative()) {
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
