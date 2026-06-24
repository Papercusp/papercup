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

/**
 * How a no-turn death is classified — drives the persisted error prefix AND the retry
 * policy (spawn-classification audit P-006/H13):
 *   - 'capacity_shed' — a CLEAN mid-turn exit-1 (empty stderr, no timeout) that
 *     COINCIDED with a wholesale-throttled gateway (the all-accounts 429 storm / no
 *     fresh account). A transient CAPACITY event → RETRYABLE, NOT a host bug. This is
 *     the GENUINE all-accounts throttle that never surfaces as a 429
 *     (agent-insights/rate-limit-is-usually-account-routing-not-capacity Fault #5).
 *   - 'infra_loss' — a genuine launcher-host death / no-turn 0-token wake → terminal.
 *     The conservative default — chosen whenever the capacity-shed signals don't BOTH
 *     hold (never relabel on uncertainty).
 */
export type SpawnFailureClass = 'infra_loss' | 'capacity_shed';

export interface InvokeOutcome {
  /** True iff the agent completed at least one turn (or the body is unreadable/
   *  non-result-shaped → assume ran, preserving the legacy `done`). */
  ran: boolean;
  /** When ran=false, a self-diagnosing detail for the persisted error_message +
   *  watchdog signal. Empty when ran=true. */
  detail: string;
  /** When ran=false, how the death is classified (see SpawnFailureClass). Undefined
   *  when ran=true. The caller prefixes the persisted error with this (`capacity_shed:`
   *  vs `infra_loss:`) and, for capacity_shed, RETRIES the fire instead of recording a
   *  terminal phantom host death. */
  failureClass?: SpawnFailureClass;
}

/**
 * Judge an /invoke response body. `label` (e.g. `<slug>/<role>`) is woven into the
 * detail so the persisted failure names which spawn died.
 *
 * `opts.gatewayThrottled` is the live corroboration that distinguishes a capacity-shed
 * (the gateway pool was wholesale-throttled at death) from a host loss. The caller
 * supplies it (best-effort, e.g. observability.gatewayWholesaleThrottled()); the
 * function stays PURE so it is unit-testable without a live gateway. When omitted the
 * death classifies `infra_loss` — the conservative legacy label.
 */
export function agentProducedTurn(
  bodyText: string,
  label = '',
  opts: { gatewayThrottled?: boolean } = {},
): InvokeOutcome {
  // Unreadable body ⇒ assume done (legacy behavior; never flip on uncertainty).
  if (!bodyText) return { ran: true, detail: '' };
  let b: {
    ok?: unknown;
    agentOutput?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    exitCode?: unknown;
    timedOut?: unknown;
  };
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

  // ── ran=false: classify the death. ───────────────────────────────────────────
  // Capacity-shed FINGERPRINT: a CLEAN mid-turn process exit — exit code exactly 1,
  // no timeout, and EMPTY stderr. A real host loss / crash / OOM leaves a stderr trail
  // or a null/signal exit code; a capacity shed (the agent's 2nd gateway call hit the
  // all-accounts storm and the process exited 1 with nothing on stderr) does not.
  // BOTH the body fingerprint AND the live gateway-throttled corroboration are required
  // — never relabel on one signal alone (the never-flip-on-uncertainty contract).
  const exitCode = typeof b.exitCode === 'number' ? b.exitCode : null;
  const stderr = typeof b.stderr === 'string' ? b.stderr : '';
  const midTurnCleanExit = exitCode === 1 && b.timedOut !== true && stderr.trim().length === 0;
  if (midTurnCleanExit && opts.gatewayThrottled === true) {
    return {
      ran: false,
      failureClass: 'capacity_shed',
      detail: ` ${label} was SHED mid-turn by an all-accounts gateway throttle (capacity_shed — RETRYABLE, NOT a host fault): exit 1, empty stderr, timedOut=false, and the gateway pool was wholesale-throttled (paused/rejected) at death — the GENUINE all-accounts 429 storm that never surfaces as a 429 (agent-insights/rate-limit-is-usually-account-routing-not-capacity Fault #5). Retry through the paced gateway when capacity returns; do NOT hunt a host bug.`,
    };
  }
  return {
    ran: false,
    failureClass: 'infra_loss',
    detail: ` ${label} returned HTTP 200 but the agent produced no turn (ok=${String(b.ok)}, exitCode=${String(
      b.exitCode,
    )}, timedOut=${String(b.timedOut)}, outLen=${out.trim().length}) — agent died before emitting a turn: a dead/restarting launcher host OR (more often) an upstream gateway stall/429 storm killing the agent MID-TURN (the transcript shows a normal run that stops on its 2nd call) — see agent-insights/rate-limit-is-usually-account-routing-not-capacity Fault #5; recorded failed, not done`,
  };
}
