/**
 * native-console.ts — renderer-side wrapper for spawning a native
 * terminal console.
 *
 * Primary path: a relative same-origin POST to
 * /api/agent-mcp/console/launch (the operator spawns the terminal +
 * records the adv_sessions row). On the desktop this rides the
 * sys:http IPC bridge; in browser dev it's a plain same-origin fetch.
 * Fallback (non-Linux operator → 501): the Tauri `console_launch`
 * command, which resolves an envelope and spawns the terminal Rust-side.
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
   *  omp mode (launchAgent). */
  resumeSessionId?: string | null;
  /** Optional OMP model fuzzy-match argument (`omp-su --model <value>`). */
  model?: string | null;
  /**
   * Optional kickoff brief — per
   * `plans-newbutton-and-subharness-scope-2026-05-25` P-005. Honored
   * only in omp mode. The console-launch route Zod-validates `kind`
   * against the allowlist; the server then writes a /dev/shm brief
   * and appends `--append-system-prompt=<path>` to the OMP launch
   * command. Curated in-repo briefs only — no free-text payloads.
   */
  kickoff?: { kind: 'new-plan' } | null;
  /**
   * psu-in-desktop-builds-2026-06-23 B: open the console straight into a `psu`
   * superuser agent session instead of a plain shell. Honored only when
   * FLAGS.PSU_END_USER is on (re-checked server-side in buildConsoleEnvelope).
   */
  runPsu?: boolean;
}

interface ConsoleEnvelope {
  cwd: string;
  env: Record<string, string>;
  mcpJsonContents: string;
  greetingCmd: string;
  needsSuperuserBootstrap: boolean;
  /** windows-desktop-feature-parity-2026-07-02 P-010: per-launch window
   *  identity — see console-launcher.ts's ConsoleEnvelope.sessionId doc. */
  sessionId: string;
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
      runPsu: opts.runPsu ?? false,
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

  // Primary path: a RELATIVE same-origin POST to the server-side spawn
  // endpoint. The desktop webview is same-origin with the operator
  // (http://localhost:<sidecar-port>), so this rides the sys:http IPC
  // bridge when IPC is up (no libsoup connection slot) and a same-origin
  // native fetch otherwise — either way same-origin, so there is NO CORS
  // preflight. That preflight (broken in WebKitGTK for cross-origin) is
  // the only reason the old Image().src GET + absolute http://localhost:3055
  // fetch hacks existed; now that the webview shares the operator's origin
  // they're unnecessary. The server handler does the full spawn + the
  // adv_sessions tracking row (which the Tauri command path below skips).
  let lastError: any;
  try {
    const { ok, data, status } = await tryServerSideSpawn(opts, '/api/agent-mcp/console/launch');
    console.info('[console-launcher] server-side spawn result', { status, data });
    if (ok && data?.status === 'ok') return;
    // 501 = operator host isn't Linux → fall through to the Tauri command.
    if (status !== 501) {
      lastError = new Error(data?.error ?? `console/launch HTTP ${status}`);
    }
  } catch (e: any) {
    console.warn('[console-launcher] server-side spawn failed', e?.message);
    lastError = e;
  }
  if (!hasTauriInvoke()) {
    throw lastError ?? new Error('no spawn path available');
  }

  // Fallback path: the Tauri `console_launch` IPC command — covers the
  // non-Linux operator case (server-side spawn returns 501) by spawning
  // the terminal from the Rust side. Resolves the envelope via the same
  // relative (IPC-bridged) endpoint.
  const resolveR = await fetch('/api/agent-mcp/console/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: opts.slug, runPsu: opts.runPsu ?? false }),
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

  // windows-desktop-feature-parity-2026-07-02 P-014: the Rust-side spawn above
  // never touches adv_sessions (only console-spawn.ts's Linux/macOS path does
  // that, right after it forks). Without this, a plain (non-psu) console
  // opened via this fallback is completely untracked — invisible to /adv,
  // unparkable, unresumable.
  //
  // Scoped to `!opts.runPsu` ON PURPOSE: a `runPsu` console self-registers
  // its OWN row independently the moment `psu` boots (bootstrap-su.ts's
  // `recordAdvSession` call, made from inside WSL to the WSL-hosted operator
  // — already works cross-platform, no Windows-specific code needed). Also
  // recording HERE for that case would leave a SECOND, permanently-orphaned
  // row behind: this route deliberately records with `coordOwnerId: null`
  // (see console-record.ts header — no safe pid to key liveness off either),
  // and idle-session-reaper.ts's "no coord_owner_id → can't liveness-check →
  // never reap" rule means a coordOwnerId-less row never self-closes. One
  // untracked-lifetime row per plain-shell console is an accepted, documented
  // gap (no Rust-side "console exited" callback exists yet — see
  // native_console.rs's sentinel-file exit trap for the mechanism a future
  // fix could hook); TWO such rows per psu launch would be a regression.
  //
  // Best-effort + non-fatal: never let a recording hiccup fail an
  // already-successful terminal launch. Deliberately does NOT forward the
  // Rust-returned pid (see console-record.ts header: it's a Windows-namespace
  // pid, meaningless — and actively misleading — to the WSL-hosted operator's
  // liveness checks).
  if (!opts.runPsu) {
    try {
      await fetch('/api/agent-mcp/console/record', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cwd: envelope.cwd,
          terminalBin: 'wt.exe',
          label: opts.label ?? null,
          planSlug: opts.planSlug ?? null,
          launchArgv: [envelope.greetingCmd].filter(Boolean),
        }),
      });
    } catch (e: any) {
      console.warn('[console-launcher] console/record failed (non-fatal)', e?.message);
    }
  }
}
