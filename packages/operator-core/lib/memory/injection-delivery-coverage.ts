/**
 * Per-(client, port) context-injection DELIVERY coverage — the derive-miss TRACE.
 *
 * Plan: codex-context-injection-parity-2026-08-09, P-005 / D-005 §3b.
 * Table: harness_shared.context_injection_coverage (migration 772 — its header
 * carries the full rationale, including why this is NOT a column on
 * memory_recall_stats).
 *
 * ⚠⚠ NOT `injection-coverage.ts`, WHICH IS A DIFFERENT MODULE ON A DIFFERENT
 * PLAN. The two names are close enough that one of them has already been
 * clobbered once (2026-08-09). Keep them straight:
 *
 *   injection-coverage.ts   (context-injection-retrieval-reach-…-2026-08-03 P-004)
 *     "Is retrieval still REACHING the corpus semantically?" — a PURE assessor
 *     over embed-coverage surfaces. No I/O. Exports assessInjectionReach /
 *     formatInjectionReachToast, consumed by dbos/periodic-workflows.ts.
 *
 *   THIS FILE                (codex-context-injection-parity-2026-08-09 P-005)
 *     "Is injection being DELIVERED to each client at all?" — a counter WRITER.
 *     Does I/O. Knows nothing about embeddings or corpus reach.
 *
 * One is about whether the corpus can answer; this one is about whether anybody
 * asked. A regression in either is invisible in the other.
 *
 * ── THE QUESTION THIS ANSWERS ──
 * "Is client X actually receiving per-turn context?" had no answer from the
 * outside, because the ways of getting no context are indistinguishable once
 * they have all written nothing:
 *
 *   no rows at all         the hook never fired            (install/trust bug)
 *   outcome='unknown-tool' it fired; the tool is unmapped   (VOCABULARY DRIFT)
 *   outcome='no-signal'    it fired; known tool, no signal  (expected quiet)
 *   outcome='no-recall'    it ran; nothing relevant         (healthy quiet)
 *   outcome='recalled'     it ran and returned context      (working)
 *
 * Only 'unknown-tool' is actionable, and before this it was invisible — which
 * is exactly how codex and omp stayed structurally zeroed on the mid-turn port
 * without anything reporting a fault (D-005 §1).
 *
 * ── FAIL-SILENT, LIKE EVERY OTHER TELEMETRY WRITE ON THIS PATH ──
 * This runs inside a hook-serving request whose whole contract is that it must
 * never cost the agent's turn. It never throws and is never awaited by the
 * caller. Losing a counter is a rounding error; surfacing an error into a turn
 * is a wedged agent.
 */

/** Matches memory_recall_stats.surface vocabulary. */
export type InjectionPort = 'turn-start' | 'mid-turn';

export type InjectionDeliveryOutcome =
  /** The injection ran and returned context. */
  | 'recalled'
  /** It ran, and found nothing relevant. Healthy quiet. */
  | 'no-recall'
  /** Reached the endpoint; a KNOWN tool carried no query signal. Expected. */
  | 'no-signal'
  /** Reached the endpoint; the tool is absent from the shared vocabulary. */
  | 'unknown-tool';

export interface InjectionDeliveryEvent {
  port: InjectionPort;
  outcome: InjectionDeliveryOutcome;
  /** '' when the caller sent none — a real reading (a host without the P-005
   *  threading), deliberately not defaulted to a client name. */
  client?: string | null;
  /** The tool name, for the tool-specific outcomes. '' otherwise. */
  tool?: string | null;
  workspaceId?: string | null;
}

/**
 * A tool name is part of the primary key, so an unbounded one would be an
 * unbounded key. Nothing legitimate is close to this.
 */
const TOOL_CLAMP = 120;

/** Only these outcomes are about a specific tool; the others store ''. */
function toolFor(ev: InjectionDeliveryEvent): string {
  if (ev.outcome !== 'unknown-tool' && ev.outcome !== 'no-signal') return '';
  return (ev.tool ?? '').trim().slice(0, TOOL_CLAMP);
}

function keyOf(ev: InjectionDeliveryEvent, tool: string): string {
  return [ev.workspaceId ?? '', ev.client ?? '', ev.port, ev.outcome, tool].join(' ');
}

/**
 * Record one or more delivery-coverage events. Never throws; never
 * load-bearing. Call WITHOUT awaiting.
 *
 * Events are AGGREGATED IN JS FIRST. A codex mid-turn batch can carry a dozen
 * calls that all miss the same way, and one upsert carrying n=12 is both
 * cheaper and more honest than twelve racing increments.
 */
export async function recordInjectionCoverage(
  events: readonly InjectionDeliveryEvent[],
): Promise<void> {
  try {
    if (!events.length) return;

    const counts = new Map<string, { ev: InjectionDeliveryEvent; tool: string; n: number }>();
    for (const ev of events) {
      if (!ev?.port || !ev?.outcome) continue;
      const tool = toolFor(ev);
      const key = keyOf(ev, tool);
      const prior = counts.get(key);
      if (prior) prior.n += 1;
      else counts.set(key, { ev, tool, n: 1 });
    }
    if (counts.size === 0) return;

    const { getOrgPg } = await import('@papercusp/db-org');
    const sql = getOrgPg().sql;

    for (const { ev, tool, n } of counts.values()) {
      await sql`
        INSERT INTO harness_shared.context_injection_coverage
          (day, workspace_id, client, port, outcome, tool, n, first_seen_at, last_seen_at)
        VALUES (
          CURRENT_DATE,
          ${ev.workspaceId ?? ''},
          ${ev.client ?? ''},
          ${ev.port},
          ${ev.outcome},
          ${tool},
          ${n},
          now(),
          now()
        )
        ON CONFLICT (day, workspace_id, client, port, outcome, tool)
        DO UPDATE SET
          n = harness_shared.context_injection_coverage.n + EXCLUDED.n,
          last_seen_at = now()
      `;
    }
  } catch {
    /* swallow — see the fail-silent note in the header. */
  }
}
