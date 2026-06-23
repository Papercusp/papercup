/**
 * invoke-outcome — the ONE rule for "did a spawned agent actually run a turn?"
 *
 * HTTP 200 from the /invoke route does NOT mean the agent ran. The fire holds the
 * connection for the whole run, so on an unstable/restarting launcher host — or
 * (more often) an upstream gateway stall / 429 storm killing the agent MID-TURN —
 * the route returns an ok-shaped response while the agent never emitted a turn
 * (the ~3s/0-token wakes that were recorded `done` → silent placement/scorecard/
 * doc-heal stalls). Both spawn-fire paths must judge a fire the SAME way:
 *   - durable-spawn (dbos/durable-spawn.ts) — the orchestrator/queen/bee/worker path.
 *   - launch-blueprint (blueprint/launch-blueprint.ts) — event/cadence launches incl.
 *     the doc-steward, which previously recorded HTTP-200-no-turn as `done` (the
 *     silent-swallow that left drifted docs un-healed; docs-audit 2026-06-23 #1).
 *
 * Rule: inspect the invoke-result body ({ ok, agentOutput|stdout, exitCode, timedOut }).
 * The agent RAN iff `ok === true` AND the output is non-empty (blueprint roles ALWAYS
 * emit a decision line, so empty ⇒ no turn). An unparseable / non-result body ⇒ assume
 * it ran (the old `done` behavior) — NEVER flip a spawn to failed on uncertainty (this
 * is the most load-bearing path; a false `failed` would re-fire/alarm needlessly).
 */

export interface InvokeOutcome {
  /** True iff the agent completed at least one turn (or the body is unreadable/
   *  non-result-shaped → assume ran, preserving the legacy `done`). */
  ran: boolean;
  /** When ran=false, a self-diagnosing infra-loss detail for the persisted
   *  error_message + watchdog signal. Empty when ran=true. */
  detail: string;
}

/**
 * Judge an /invoke response body. `label` (e.g. `<slug>/<role>`) is woven into the
 * detail so the persisted failure names which spawn died.
 */
export function agentProducedTurn(bodyText: string, label = ''): InvokeOutcome {
  // Unreadable body ⇒ assume done (legacy behavior; never flip on uncertainty).
  if (!bodyText) return { ran: true, detail: '' };
  let b: { ok?: unknown; agentOutput?: unknown; stdout?: unknown; exitCode?: unknown; timedOut?: unknown };
  try {
    b = JSON.parse(bodyText);
  } catch {
    return { ran: true, detail: '' }; // unparseable ⇒ assume done
  }
  // Only judge when the body carries the invoke-result shape (a boolean `ok`).
  if (typeof b.ok !== 'boolean') return { ran: true, detail: '' };
  const out =
    typeof b.agentOutput === 'string'
      ? b.agentOutput
      : typeof b.stdout === 'string'
        ? b.stdout
        : '';
  if (b.ok === true && out.trim().length > 0) return { ran: true, detail: '' };
  return {
    ran: false,
    detail: ` ${label} returned HTTP 200 but the agent produced no turn (ok=${String(b.ok)}, exitCode=${String(
      b.exitCode,
    )}, timedOut=${String(b.timedOut)}, outLen=${out.trim().length}) — agent died before emitting a turn: a dead/restarting launcher host OR (more often) an upstream gateway stall/429 storm killing the agent MID-TURN (the transcript shows a normal run that stops on its 2nd call) — see agent-insights/rate-limit-is-usually-account-routing-not-capacity Fault #5; recorded failed, not done`,
  };
}
