/**
 * console-launch-bridge.ts — the Windows desktop-bridge for AGENT-invoked
 * terminal launches (WI-3289).
 *
 * THE GAP THIS CLOSES: on a Windows install the operator runs INSIDE the
 * `papercup-runtime` WSL2 distro. Anything it spawns via WSL interop lands in
 * SESSION 0 — the services window-station — invisible to the interactive
 * desktop (VM-verified 2026-07-02, see native_console.rs D-002 header). The
 * ONLY process that can open a visible terminal is the Session-1
 * `papercusp-desktop.exe` shell, reached through its webview via the Tauri
 * `console_launch` command. The USER path already rides it (native-console.ts
 * falls back to Tauri on a 501); the AGENT path (capability:terminal,
 * fleet:launch-on-plan) had no way there and hard-501'd "Linux/macOS only".
 *
 * THE MECHANISM (same rails as attention.notify, D-007): the operator emits a
 * `console.launch-request` event on the existing sync SSE bus carrying the
 * ConsoleEnvelope + a requestId, and parks the caller on a pending promise.
 * The desktop webview's DesktopConsoleLaunchBridge component consumes the
 * event, CLAIMS the request (POST /agent-mcp/console/launch-claim — single-
 * consumer: multiple open webviews must not each spawn a window), invokes the
 * Tauri `console_launch` command, and reports back (POST
 * /agent-mcp/console/launch-result), which resolves the pending promise.
 * No webview attached / no Tauri / nobody claims → the request times out and
 * the caller gets a loud, actionable error instead of a silent no-window "ok"
 * (the WI-1886 failure class).
 *
 * In-memory by design: a launch request is a live RPC on THIS operator
 * process — an operator restart mid-flight should fail the caller's await,
 * never replay a stale window spawn from persisted state.
 */
import { randomUUID } from 'node:crypto';
import type { ConsoleEnvelope } from './console-launcher';
import { notifySyncInvalidate } from './sync-sse';

/** SSE event name the desktop webview listens for (DesktopConsoleLaunchBridge). */
export const CONSOLE_LAUNCH_REQUEST_EVENT = 'console.launch-request';

/**
 * How long the operator waits for a webview to claim + complete a launch.
 * Generous on purpose: the Rust side may relay fs ops through `wsl.exe`
 * (WI-2149) and cold-start wt.exe; but bounded so a headless/closed desktop
 * fails the agent's call loudly instead of hanging a tool turn.
 */
export const DESKTOP_BRIDGE_TIMEOUT_MS = 30_000;

export interface BridgeLaunchResult {
  ok: boolean;
  /** Windows-namespace pid from Rust's Command::spawn().id() — DISPLAY-ONLY.
   *  Never feed it to WSL-side liveness checks (foreign pid namespace — see
   *  console-record.ts's "deliberately does not accept a pid" header). */
  pid: number | null;
  error: string | null;
}

interface PendingLaunch {
  claimed: boolean;
  timer: NodeJS.Timeout;
  resolve: (r: BridgeLaunchResult) => void;
}

const pending = new Map<string, PendingLaunch>();

/** Test-only visibility: how many requests are currently in flight. */
export function pendingBridgeLaunchCount(): number {
  return pending.size;
}

/**
 * Ask the desktop shell to spawn a terminal for `envelope`. Resolves when a
 * webview reports the Tauri `console_launch` result, or with a timeout error
 * when no desktop shell claims the request in time. Never throws.
 */
export async function requestDesktopConsoleLaunch(opts: {
  envelope: ConsoleEnvelope;
  label?: string | null;
  planSlug?: string | null;
  timeoutMs?: number;
}): Promise<BridgeLaunchResult> {
  const requestId = randomUUID();
  const timeoutMs = opts.timeoutMs ?? DESKTOP_BRIDGE_TIMEOUT_MS;

  const result = new Promise<BridgeLaunchResult>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({
        ok: false,
        pid: null,
        error:
          `no desktop shell answered the console-launch request within ${timeoutMs}ms — ` +
          'the Papercusp desktop window must be OPEN (its webview relays the spawn to the ' +
          'Tauri console_launch command; the WSL operator cannot open a Session-1 window itself)',
      });
    }, timeoutMs);
    timer.unref?.();
    pending.set(requestId, { claimed: false, timer, resolve });
  });

  // The envelope's mcpJsonContents is EMPTY on agent launches (skipMcpJson) —
  // and launch_inner (native_console.rs) skips displacement for empty contents,
  // so the bridged spawn never clobbers a project's real .mcp.json.
  try {
    await notifySyncInvalidate(CONSOLE_LAUNCH_REQUEST_EVENT, {
      requestId,
      envelope: opts.envelope as unknown as Record<string, unknown>,
      label: opts.label ?? null,
      planSlug: opts.planSlug ?? null,
    });
  } catch (e: any) {
    const p = pending.get(requestId);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(requestId);
      return { ok: false, pid: null, error: `sync-bus emit failed: ${e?.message ?? e}` };
    }
  }

  return result;
}

/**
 * First-claimer-wins gate so N open webviews spawn ONE window per request.
 * Returns false for an unknown/expired/already-claimed request — the caller
 * webview must then NOT invoke console_launch.
 */
export function claimConsoleLaunch(requestId: string): boolean {
  const p = pending.get(requestId);
  if (!p || p.claimed) return false;
  p.claimed = true;
  return true;
}

/**
 * Webview callback with the Tauri `console_launch` outcome. Returns false when
 * the request is unknown (expired / double-report) — harmless, just ignored.
 */
export function completeConsoleLaunch(
  requestId: string,
  result: { ok: boolean; pid?: number | null; error?: string | null },
): boolean {
  const p = pending.get(requestId);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(requestId);
  p.resolve({
    ok: result.ok,
    pid: result.pid ?? null,
    error: result.error ?? (result.ok ? null : 'console_launch failed'),
  });
  return true;
}
