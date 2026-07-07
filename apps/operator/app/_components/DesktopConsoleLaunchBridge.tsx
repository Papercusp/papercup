'use client';

/**
 * DesktopConsoleLaunchBridge — the webview half of the Windows agent
 * console-launch bridge (WI-3289; operator half: lib/console-launch-bridge.ts).
 *
 * On a Windows install the operator runs inside the `papercup-runtime` WSL2
 * distro and CANNOT open a visible terminal itself (its spawns land in
 * Session 0 — see native_console.rs D-002). The only Session-1 process that
 * can is the desktop shell, via the Tauri `console_launch` command. The user
 * "+" button already reaches it renderer-side (native-console.ts); this
 * component gives AGENT-invoked launches (capability:terminal,
 * fleet:launch-on-plan) the same reach:
 *
 *   1. the operator emits `console.launch-request` on the sync bus with the
 *      ConsoleEnvelope + requestId and parks the agent's tool call on it;
 *   2. this component CLAIMS the request (POST launch-claim — first claimer
 *      wins, so N open webviews spawn exactly ONE window);
 *   3. invokes the Tauri `console_launch` command with the envelope;
 *   4. POSTs launch-result, resolving the agent's await with ok/error.
 *
 * Mounted once at the app root next to DesktopAttentionNotifier, and rides
 * the sync transport's OWN stream via `onSyncBusEvent` for the same
 * socket-starvation reason documented there (never a second EventSource).
 * Non-Tauri surfaces (plain browser tabs) ignore the event entirely — they
 * cannot invoke Tauri commands, and claiming without spawning would eat the
 * request. All failures are reported back to the operator so the agent gets
 * a real error instead of a timeout.
 */
import { useEffect } from 'react';
import { onSyncBusEvent } from '@papercusp/sync';

const CONSOLE_LAUNCH_REQUEST_EVENT = 'console.launch-request';

interface ConsoleEnvelope {
  cwd: string;
  env: Record<string, string>;
  mcpJsonContents: string;
  greetingCmd: string;
  needsSuperuserBootstrap: boolean;
  sessionId: string;
}

interface LaunchRequestArgs {
  requestId?: string;
  envelope?: ConsoleEnvelope;
  label?: string | null;
  planSlug?: string | null;
}

function hasTauriInvoke(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: unknown } };
  return typeof w.__TAURI_INTERNALS__?.invoke === 'function';
}

async function postJson(path: string, body: unknown): Promise<any> {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json().catch(() => null);
}

async function handleLaunchRequest(args: LaunchRequestArgs): Promise<void> {
  const requestId = args.requestId;
  const envelope = args.envelope;
  if (!requestId || !envelope?.cwd || typeof envelope.greetingCmd !== 'string') return;
  if (!hasTauriInvoke()) return; // browser tab — cannot spawn; leave it for a Tauri webview

  // Single-consumer gate: only the first claimer proceeds.
  const claim = await postJson('/api/agent-mcp/console/launch-claim', { requestId });
  if (!claim || claim.granted !== true) return;

  // From here on WE own the request: every outcome must be reported back, or
  // the agent's call blocks until the operator-side timeout.
  try {
    const { commands } = await import('@papercusp/operator-core/lib/tauri-bindings');
    const launchFn = (commands as {
      consoleLaunch?: (e: ConsoleEnvelope) => Promise<unknown>;
    }).consoleLaunch;
    if (typeof launchFn !== 'function') {
      throw new Error('Tauri bindings missing console_launch');
    }
    const result = (await launchFn(envelope)) as
      | { status: 'ok'; pid?: number | null }
      | { status: 'err'; error: string }
      | null;
    if (result && 'status' in result && result.status === 'ok') {
      await postJson('/api/agent-mcp/console/launch-result', {
        requestId,
        ok: true,
        pid: typeof result.pid === 'number' ? result.pid : null,
      });
    } else {
      const error =
        (result as { error?: string } | null)?.error ?? 'console_launch returned no result';
      await postJson('/api/agent-mcp/console/launch-result', { requestId, ok: false, error });
    }
  } catch (e: any) {
    await postJson('/api/agent-mcp/console/launch-result', {
      requestId,
      ok: false,
      error: e?.message ?? String(e),
    }).catch(() => {
      /* operator unreachable — its timeout is the backstop */
    });
  }
}

export default function DesktopConsoleLaunchBridge() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    return onSyncBusEvent((ev) => {
      if (ev.name !== CONSOLE_LAUNCH_REQUEST_EVENT) return;
      void handleLaunchRequest((ev.args ?? {}) as LaunchRequestArgs);
    });
  }, []);
  return null;
}
