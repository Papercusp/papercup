/**
 * launch-agent.ts — one renderer-side entry point for launching a
 * tracked agent session, across all three backends (agent-launch
 * unification, Phase 4 / P-030).
 *
 * Dispatch by agent, lowest-regression-risk:
 *   - `omp`           → the existing `launchOmpAgent` path (console-launch
 *                       `mode:'omp'`). Unchanged — preserves model / kickoff /
 *                       resume / label exactly. Still the default.
 *   - `claude`/`codex` → `POST /api/adv/sessions/launch-su` → server spawns
 *                       a terminal running `psu --no-picker --agent=<a> …`,
 *                       which records the tracked adv_sessions row + exec's
 *                       the matching `*-su` wrapper.
 *
 * So every "Launch agent" button becomes agent-selectable now, with no
 * behavior change when the agent is `omp`. The legacy console-launch
 * `mode:'omp'` builder stays as the omp implementation (the deferred
 * P-032 deletion converges omp onto psu too, once e2e-verified).
 *
 * Parity note: model / kickoff / resume are honored only on the `omp`
 * path today. Selecting claude/codex for a launch that needs one of those
 * drops it (a new-capability limitation, not an omp regression) — callers
 * that require those features should keep agent='omp' until the psu path
 * reaches parity.
 */
import { launchOmpAgent, type OmpLaunchResult } from './native-omp-launch';
import type { LaunchOpts } from './native-console';
import type { SuAgent } from './su-agents';

export interface LaunchAgentOpts extends LaunchOpts {
  /** Which backend to launch. Defaults to 'omp' (preserves prior behavior). */
  agent?: SuAgent;
}

export type LaunchAgentResult = OmpLaunchResult;

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
 * Launch a tracked agent session. `omp` delegates to the proven
 * launchOmpAgent path; claude/codex go through launch-su → psu.
 */
export async function launchAgent(opts: LaunchAgentOpts): Promise<LaunchAgentResult> {
  const agent: SuAgent = opts.agent ?? 'omp';
  if (agent === 'omp') {
    return launchOmpAgent(opts);
  }

  const body = JSON.stringify({
    agent,
    harness_slug: opts.slug ?? null,
    plan_slug: opts.planSlug ?? null,
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
        | { status?: string; code?: string; error?: string }
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
      if (r.ok && data.status === 'ok') return { ok: true };
      lastError = data.error ?? `launch-su HTTP ${r.status}`;
    } catch (e: unknown) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, error: lastError };
}
