/**
 * native-console.ts — renderer-side wrapper for the Tauri
 * `console_launch` command.
 *
 * Resolves the spawn envelope from the operator's
 * /api/agent-mcp/console/resolve endpoint, then hands it to the
 * Rust side. The Rust side writes the .mcp.json into the cwd and
 * spawns the user's OS-native terminal in a new window.
 */

import { commands } from './tauri-bindings';

export interface LaunchOpts {
  slug: string | null;
  /** Plan slug to tag the launched session with — surfaces in
   *  /adv/sessions for grouping + focus. Optional; null = untagged. */
  planSlug?: string | null;
  /** Display label shown in the /adv/sessions list. Falls back to
   *  the plan title or the cwd basename when omitted. */
  label?: string | null;
  /** OMP session id to pass through as `omp -r <id>` so the new
   *  session resumes an existing conversation. Honored only in
   *  omp mode (launchOmpAgent). */
  resumeSessionId?: string | null;
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

/**
 * Where to send the launch fetch. In Tauri's webview the page origin
 * may not match the operator's origin (Tauri sometimes uses
 * `tauri://localhost` as the page origin even with devUrl set), so a
 * relative URL routes to the wrong place. Detect Tauri and use an
 * absolute URL pointing at the operator's known dev port; in browser
 * sessions stay relative so the request just rides the page origin.
 */
function resolveLaunchEndpoint(): string {
  if (typeof window === 'undefined') return '/api/agent-mcp/console/launch';
  try {
    const loc = window.location;
    // If the page is already on http(s)://...:3055 or :3070, relative is safe.
    if (loc.protocol === 'http:' || loc.protocol === 'https:') {
      return '/api/agent-mcp/console/launch';
    }
    // Tauri webview (or anything else) — pin to the dev operator.
    // 3070 is the prod-standalone port; 3055 is dev. Try 3070 first
    // for prod desktop builds, fall back to 3055 for dev. We don't
    // probe — we just try 3070 and let the renderer's catch fall
    // through to 3055.
    return 'http://localhost:3055/api/agent-mcp/console/launch';
  } catch {
    return '/api/agent-mcp/console/launch';
  }
}

async function tryServerSideSpawn(
  opts: LaunchOpts,
  url: string,
): Promise<{ ok: boolean; data: any; status: number }> {
  console.info('[console-launcher] fetching', url);
  // Use text/plain content-type so this counts as a CORS "simple request"
  // and skips the preflight OPTIONS entirely — Tauri's webkit2gtk in this
  // build appears to fail preflight handshakes silently. Server parses
  // either JSON or empty bodies.
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({
      slug: opts.slug,
      planSlug: opts.planSlug ?? null,
      label: opts.label ?? null,
    }),
  });
  const data = await r.json().catch(() => ({ status: 'error', error: 'invalid JSON' }));
  return { ok: r.ok, data, status: r.status };
}

export async function launchNativeConsole(opts: LaunchOpts): Promise<void> {
  console.info('[console-launcher] click', {
    opts,
    hasTauri: hasTauriInvoke(),
    pageOrigin: typeof window !== 'undefined' ? window.location.origin : '(ssr)',
  });

  // Primary path: Image().src GET request. This is a no-CORS request
  // type in browsers — no preflight, no Origin header check, just a
  // GET to the URL. Tauri's webkit2gtk fetch() preflight is broken in
  // this build, so we sidestep it entirely. Server-side ?action=spawn
  // hits doSpawn() and returns a 1x1 PNG.
  if (typeof window !== 'undefined') {
    try {
      console.info('[console-launcher] firing Image().src GET');
      const params = new URLSearchParams({ action: 'spawn' });
      if (opts.slug) params.set('slug', opts.slug);
      const img = new window.Image();
      const imgLoaded = new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('image-spawn load failed'));
      });
      img.src = `http://localhost:3055/api/agent-mcp/console/launch?${params}`;
      await Promise.race([
        imgLoaded,
        new Promise((res) => setTimeout(res, 2000)), // don't block on the PNG
      ]);
      console.info('[console-launcher] image-spawn fired');
      return;
    } catch (e: any) {
      console.warn('[console-launcher] image-spawn failed', e?.message);
    }
  }

  // Fallback path: fetch() POST. Kept for completeness; this is the
  // path that triggered the preflight issue we're routing around.
  const endpoints = [resolveLaunchEndpoint()];
  if (!endpoints[0].includes('localhost:3055')) {
    endpoints.push('http://localhost:3055/api/agent-mcp/console/launch');
  }
  let lastError: any;
  for (const url of endpoints) {
    try {
      const { ok, data, status } = await tryServerSideSpawn(opts, url);
      console.info('[console-launcher] fetch result', { url, status, data });
      if (ok && data?.status === 'ok') return;
      if (status === 501) break;
      lastError = new Error(data?.error ?? `console/launch HTTP ${status}`);
    } catch (e: any) {
      console.warn('[console-launcher] fetch failed', { url, error: e?.message });
      lastError = e;
    }
  }
  if (!hasTauriInvoke()) {
    throw lastError ?? new Error('no spawn path available');
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
