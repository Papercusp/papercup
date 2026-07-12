/**
 * precision-alert.ts — pure recall-drop classifier for the memory-precision
 * canary (EI-10047).
 *
 * `precision-monitor.ts` already replays the frozen gold set against the
 * production hybrid backend on a schedule and RECORDS r@10/p@5/fp@5/mrr —
 * but nothing ever looked at whether the recorded number is any GOOD.
 * `learning-loop-health.ts` classifies routine LIVENESS (did it fire on
 * cadence); this classifies METRIC QUALITY (did what it measured collapse).
 * The two are independent: the age A/B re-run's schema-drift incident
 * (missing mig-578 columns → every search throws PG 42703 → the backend's
 * degrade-never-throw design swallows the error and returns zero hits) would
 * have looked perfectly "firing" to learning-loop-health while r@10 silently
 * cratered to 0 — this module is the gap that leaves visible.
 *
 * Pure — no I/O, no Date.now(), no PG. The PG glue (read history, call this,
 * escalate) lives in precision-monitor.ts / precision-alert-ei.ts.
 */

/** Absolute r@10 drop (baseline − latest) that counts as a regression (5 points, per the ask). */
export const RECALL_DROP_THRESHOLD = 0.05;

/**
 * A hard floor independent of baseline: below this, recall is regarded as
 * effectively broken regardless of history (catches the "first run after a
 * total outage" and "not enough history yet but already catastrophic" cases
 * the baseline-delta rule alone can't see). 0.2 is well below D-007's
 * documented ~0.82 steady-state — a healthy run is never anywhere near it.
 */
export const RECALL_CRITICAL_FLOOR = 0.2;

/** Minimum prior (non-null) runs required before a baseline is trusted. */
export const MIN_BASELINE_RUNS = 3;

/** Prior runs considered for the rolling baseline (newest-first, matches precision-read's trendLimit). */
export const BASELINE_HISTORY_WINDOW = 8;

export type RecallDropReason = 'baseline-drop' | 'critical-floor' | 'ok' | 'insufficient-history';

export interface RecallDropEvaluation {
  /** Whether this run should escalate (file/keep-open a durable EI). */
  alert: boolean;
  reason: RecallDropReason;
  /** Median r@10 of qualifying prior runs, or null when there aren't enough (< MIN_BASELINE_RUNS). */
  baseline: number | null;
  /** This run's r@10 (null = the bench itself never produced a number — treated as a floor breach when a baseline exists). */
  latest: number | null;
  /** baseline − latest when both are known (positive = regression); null otherwise. */
  delta: number | null;
}

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Evaluate one run's r@10 against a rolling baseline built from prior runs.
 * A ROBUST baseline (median of the last few runs, not just the immediately
 * previous one) so a single noisy run doesn't itself become the new floor —
 * and so a real regression can't quietly redefine "normal" one run at a time.
 *
 * `priorRAt10` — the recorded r@10 for the last `BASELINE_HISTORY_WINDOW`
 * runs BEFORE this one, newest-first-or-any-order (nulls are dropped). Pass
 * `[]` for a brand-new canary (never alerts on baseline-drop with no
 * history — only the critical floor can fire in that case).
 */
export function evaluateRecallDrop(
  priorRAt10: readonly (number | null)[],
  latestRAt10: number | null,
): RecallDropEvaluation {
  const priorValid = priorRAt10.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const baseline = priorValid.length >= MIN_BASELINE_RUNS ? median(priorValid) : null;

  if (latestRAt10 == null) {
    // The bench produced no number at all — only alertable once we have
    // something to compare against; otherwise there's nothing to say yet.
    return { alert: baseline !== null, reason: baseline !== null ? 'critical-floor' : 'insufficient-history', baseline, latest: null, delta: baseline };
  }

  const delta = baseline !== null ? baseline - latestRAt10 : null;

  if (delta !== null && delta > RECALL_DROP_THRESHOLD) {
    return { alert: true, reason: 'baseline-drop', baseline, latest: latestRAt10, delta };
  }
  if (latestRAt10 < RECALL_CRITICAL_FLOOR) {
    return { alert: true, reason: 'critical-floor', baseline, latest: latestRAt10, delta };
  }
  return { alert: false, reason: baseline !== null ? 'ok' : 'insufficient-history', baseline, latest: latestRAt10, delta };
}
