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
import type { SuAgent } from './su-agents';

export interface LaunchAgentOpts extends LaunchOpts {
  /** Which backend to launch. Defaults to 'omp' (preserves prior behavior). */
  agent?: SuAgent;
  /**
   * Deferred (pui-reactive-session-panes D-006): RECORD a pending "workbench
   * launch" instead of spawning a terminal. The session materializes as a pane
   * in the pui workbench (the single launcher), not a standalone terminal.
   * Returns `advSessionId` of the recorded row.
   */
  deferSpawn?: boolean;
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
  const agent: SuAgent = opts.agent ?? 'omp';
  const body = JSON.stringify({
    agent,
    harness_slug: opts.slug ?? null,
    plan_slug: opts.planSlug ?? null,
    model: opts.model ?? null,
    resume_session_id: opts.resumeSessionId ?? null,
    kickoff: opts.kickoff ?? null,
    defer_spawn: opts.deferSpawn ?? false,
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
        | { status?: string; code?: string; error?: string; advSessionId?: number }
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
        return { ok: true, advSessionId: data.advSessionId };
      }
      lastError = data.error ?? `launch-su HTTP ${r.status}`;
    } catch (e: unknown) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, error: lastError };
}
