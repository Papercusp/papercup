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
 * The rounded percent-of-soft-limit for a session, or null when it can't be computed
 * (no limit / no estimate). Split out (flush-to-proceed-stretch-discipline P-002) so the
 * context-usage line AND the flush-freshness gate key on ONE pct computation instead of
 * each re-deriving it — a single source for "how full am I", identical rounding.
 */
export function contextUsagePct(
  contextTokens: number | null | undefined,
  compactionLimit: number | null | undefined,
): number | null {
  if (!compactionLimit || contextTokens == null) return null;
  return Math.round((contextTokens / compactionLimit) * 100);
}

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
  const pct = contextUsagePct(contextTokens, compactionLimit);
  if (pct == null) return null;
  let line = `context: ${contextTokens}/${compactionLimit} (${pct}%)`;
  if (pct >= COMPACTION_HINT_PCT) {
    line +=
      ' — near limit: CALL session:request-compaction (or /compact) with a focus NOW at a clean stopping point; do not merely describe ending the turn.';
  }
  return line;
}

/* ── Banded ambient gauge (agent-managed-compaction D-009 / P-013 + P-015) ──────
 *
 * The SAME context percent, rendered as a BANDED line for the two ambient-awareness
 * surfaces that a heads-down session (one that never calls a coord tool, so never
 * sees {@link renderContextUsageLine}) still hits: every papercusp-su MCP tool RESULT
 * (P-013, the result-annotator seam) and the native-tool PostToolUse hook (P-015).
 * Bands (owner-proposed, D-009): SILENT below QUIET so the vast majority of low-% turns
 * append NOTHING (zero noise, zero cost); a QUIET bare fact 65–79%; a LOUD ⚠ action line
 * 80–89%; a CRITICAL ⚠ urgent line ≥90%. Thresholds are exported so the client hook +
 * statusline band on ONE definition. */
export const CONTEXT_GAUGE_QUIET_PCT = 65;
export const CONTEXT_GAUGE_LOUD_PCT = 80;
export const CONTEXT_GAUGE_CRITICAL_PCT = 90;

/** The gauge band for a rounded percent: null (silent) below {@link CONTEXT_GAUGE_QUIET_PCT}. */
export type ContextGaugeBand = 'quiet' | 'loud' | 'critical';
export function contextGaugeBand(pct: number | null | undefined): ContextGaugeBand | null {
  if (pct == null) return null;
  if (pct >= CONTEXT_GAUGE_CRITICAL_PCT) return 'critical';
  if (pct >= CONTEXT_GAUGE_LOUD_PCT) return 'loud';
  if (pct >= CONTEXT_GAUGE_QUIET_PCT) return 'quiet';
  return null;
}

/**
 * Render the banded ambient gauge, or null below the QUIET band (silent — the common
 * case, so most calls append nothing). QUIET is a bare fact; LOUD/CRITICAL also NAME the
 * action (session:request-compaction) so the line is an affordance, not just a number —
 * the same fact-vs-affordance split as {@link renderContextUsageLine}. Pure; null when
 * usage can't be computed (no limit / no estimate).
 */
export function renderBandedContextGauge(
  contextTokens: number | null | undefined,
  compactionLimit: number | null | undefined,
): string | null {
  const pct = contextUsagePct(contextTokens, compactionLimit);
  const band = contextGaugeBand(pct);
  if (band == null) return null;
  const fact = `context: ${contextTokens}/${compactionLimit} (${pct}%)`;
  switch (band) {
    case 'quiet':
      return fact;
    case 'loud':
      return (
        `⚠ ${fact} — approaching your soft compaction limit; reach a clean stopping ` +
        `point soon and call session:request-compaction (or /compact) with a focus.`
      );
    case 'critical':
      return (
        `⚠ ${fact} — CRITICAL: at your soft compaction limit. Call session:request-compaction ` +
        `(or /compact) with a focus NOW, at the nearest stopping point — do not merely narrate ending the turn.`
      );
  }
}
