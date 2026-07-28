/**
 * launch-agent.ts — one renderer-side entry point for launching a
 * tracked agent session, across all three backends (agent-launch
 * unification; Phase 4 P-030, converged in P-032).
 *
 * ALL agents go through one path now: `POST /api/adv/sessions/launch-su`
 * → server spawns a terminal running `psu --no-picker --agent=<a> …`,
 * which records the tracked `adv_sessions` row + exec's the matching
 * `*-su` wrapper. model / resume-by-id / kickoff are threaded through to
 * the wrapper (P-032 retired the omp-only `buildEngineerOmpLaunchCommand`
 * / console-launch `mode:'omp'` path — omp now rides psu like the others,
 * so there's a single launch implementation instead of two).
 */
import type { LaunchOpts } from './native-console';
import type { SuAgent, SuContextSize } from './su-agents';

export interface LaunchAgentOpts extends LaunchOpts {
  /** Which backend to launch. Omitted → the configured backend
   *  (/settings/agent, resolved server-side by launch-su). */
  agent?: SuAgent;
  /**
   * Deferred (pui-reactive-session-panes D-006): RECORD a pending "workbench
   * launch" instead of spawning a terminal. The session materializes as a pane
   * in the pui workbench (the single launcher), not a standalone terminal.
   * Returns `advSessionId` of the recorded row.
   */
  deferSpawn?: boolean;
  /**
   * su-context-size-variants: initial-context size variant, orthogonal to
   * `agent`. 'full' loads the whole superuser catalog; 'trimmed' uses the
   * client's native soft-trim (small core up-front, rest on demand). Omitted →
   * the client's native default.
   */
  contextSize?: SuContextSize;
  /**
   * WI-6321 — psu-parity launch options. Before these, a GUI launch could express
   * neither, so every one was silently unfleeted and on the default system
   * credential while `psu` offered both.
   *
   * `fleet` JOINS an existing fleet by slug; `fleetName` CREATES one (this session
   * leads it), optionally forcing its colour via `fleetScheme`. Pass one or the
   * other — launch-su rejects both together.
   */
  fleet?: string | null;
  fleetName?: string | null;
  fleetScheme?: string | null;
  /** psu `--account=`: 'default' (system/CLI login) | 'auto' (gateway-routed with
   *  failover) | a pool account id. A GUI launch should ALWAYS send one — psu with
   *  no --account opens an interactive picker that would hang the spawn. */
  account?: string | null;
  /**
   * WI-6505 — psu `--headless`: launch with NO desktop window. The session still
   * registers presence, joins its fleet and stays injectable for warm wakes; it
   * just logs to a file instead of a terminal. Orthogonal to every other option.
   *
   * Omitted/false keeps the historical behaviour exactly (a visible terminal).
   */
  headless?: boolean;
}

export interface LaunchAgentResult {
  ok: boolean;
  /** Set when the launcher (`psu`/`*-su` wrappers) isn't installed. */
  code?: 'omp_not_installed';
  error?: string;
  /** Suggested local command to repair the missing prerequisite. */
  installCmd?: string;
  /** The recorded adv_sessions row id when `deferSpawn` was set (else absent). */
  advSessionId?: number;
  /**
   * WI-6363: the coord owner id launch-su PRE-PINNED for this session (`psu
   * --owner-id=`), present on BOTH the terminal and deferred paths.
   *
   * This — not `advSessionId` — is the handle a caller opens the session's chat
   * with. On the terminal path no adv_sessions row exists at launch (psu records
   * one asynchronously once it boots), so `advSessionId` is absent there; the
   * pre-pinned owner id is stable from launch onward.
   */
  ownerId?: string;
  /**
   * EI-18696184925888288: set when launch-su reported `ok` but the spawned
   * terminal process exited almost immediately — a likely silent launch
   * failure (no window ever opened) that a flat success would hide.
   */
  warning?: string;
  /**
   * WI-6505: the fleet slug this launch resolved to — the server's slugify of
   * `fleetName` when it created one, else the `fleet` joined. A multi-member
   * launch feeds this back as `fleet` for members 2..N so they JOIN rather than
   * each creating their own; never re-derive it client-side.
   */
  fleetSlug?: string;
}

/** The launch-su endpoints to try (same-origin first, then Tauri fallback ports). */
function launchSuEndpoints(): string[] {
  const out: string[] = [];
  if (typeof window !== 'undefined') {
    const p = window.location.protocol;
    if (p === 'http:' || p === 'https:') out.push('/api/adv/sessions/launch-su');
  }
  out.push('http://localhost:3070/api/adv/sessions/launch-su');
  out.push('http://localhost:3055/api/adv/sessions/launch-su');
  return out;
}

/**
 * Launch a tracked agent session via launch-su → psu → `<agent>-su`.
 * Threads model / resume / kickoff so every backend has parity.
 */
export async function launchAgent(opts: LaunchAgentOpts): Promise<LaunchAgentResult> {
  // No explicit agent → omit it; the launch-su route resolves the CONFIGURED
  // backend (/settings/agent). Explicit picks (the sessions launcher) pass
  // through unchanged.
  const agent: SuAgent | null = opts.agent ?? null;
  const body = JSON.stringify({
    agent,
    harness_slug: opts.slug ?? null,
    plan_slug: opts.planSlug ?? null,
    model: opts.model ?? null,
    context_size: opts.contextSize ?? null,
    resume_session_id: opts.resumeSessionId ?? null,
    kickoff: opts.kickoff ?? null,
    defer_spawn: opts.deferSpawn ?? false,
    // WI-6321 — psu parity. Null-safe: an omitted option keeps the previous
    // behaviour exactly (launch-su treats null as "not supplied").
    fleet: opts.fleet ?? null,
    fleet_name: opts.fleetName ?? null,
    fleet_scheme: opts.fleetScheme ?? null,
    account: opts.account ?? null,
    // WI-6505. Null-safe like the options above: an omitted flag is "not
    // supplied", which launch-su treats as a headed launch.
    headless: opts.headless ?? false,
  });
  let lastError = 'no spawn path available';
  for (const url of launchSuEndpoints()) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' }, // CORS "simple request" — sidesteps WebKit preflight
        body,
      });
      const data = (await r.json().catch(() => null)) as
        | { status?: string; code?: string; error?: string; advSessionId?: number; ownerId?: string; warning?: string; fleetSlug?: string }
        | null;
      if (!data) { lastError = `launch-su HTTP ${r.status} (no body)`; continue; }
      if (data.code === 'psu_not_installed') {
        return {
          ok: false,
          code: 'omp_not_installed',
          error: data.error,
          installCmd: 'bash apps/operator/scripts/install-standalone-mcp.sh',
        };
      }
      if (r.ok && data.status === 'ok') {
        return { ok: true, advSessionId: data.advSessionId, ownerId: data.ownerId, warning: data.warning, fleetSlug: data.fleetSlug };
      }
      lastError = data.error ?? `launch-su HTTP ${r.status}`;
    } catch (e: unknown) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, error: lastError };
}
