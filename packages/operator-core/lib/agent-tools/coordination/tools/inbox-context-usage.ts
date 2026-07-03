/**
 * inbox-context-usage — the per-turn context-usage signal prepended to the coord
 * injection block (agent-managed-compaction P-007 + WI-1795).
 *
 * A pure presentation helper, deliberately split OUT of the coord:inbox handler so
 * its threshold-gating is unit-testable without the tool's DB dependency graph.
 */

/** agent-managed-compaction (WI-1795, owner-requested 2026-07-03): at/above this
 *  %-of-soft-limit the context-usage line stops being a bare FACT and names the
 *  ACTION — call session:request-compaction. Below it, low-% turns stay clean (just
 *  the `context: N/M (P%)` fact). The soft `compactionLimit` sits below the true
 *  model window, so 85% of it is a genuine "wrap up + compact soon" signal, not a panic. */
export const COMPACTION_HINT_PCT = 85;

/**
 * WI-1795 (owner-requested 2026-07-03): render the context-usage signal prepended to the
 * coord injection each turn. Below {@link COMPACTION_HINT_PCT} it's a bare
 * `context: N/M (P%)` FACT; at/above it, the line also NAMES THE ACTION
 * (call `session:request-compaction`). This line is the ONE surface guaranteed in front of
 * the agent at the compaction decision moment — and a fact with no affordance is why agents
 * stall at the threshold and NARRATE "ending the turn so a compaction runs" instead of
 * CALLING the tool that compacts (the affordance half of a two-part fix; the behavioral half
 * is on the agent). Returns null when usage can't be computed (no limit / no estimate).
 */
export function renderContextUsageLine(
  contextTokens: number | null | undefined,
  compactionLimit: number | null | undefined,
): string | null {
  if (!compactionLimit || contextTokens == null) return null;
  const pct = Math.round((contextTokens / compactionLimit) * 100);
  let line = `context: ${contextTokens}/${compactionLimit} (${pct}%)`;
  if (pct >= COMPACTION_HINT_PCT) {
    line +=
      ' — near limit: CALL session:request-compaction (or /compact) with a focus NOW at a clean stopping point; do not merely describe ending the turn.';
  }
  return line;
}
