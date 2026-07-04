/**
 * Timeout-fallback: the guidance a timeout-wake carries + the detector that
 * surfaces systematic dead-drops (await-timeout-fallback-defaults-2026-07-03 P-003/P-004).
 *
 * When an await's deadline passes without its event, the sweeper fires a `timeout`
 * wake (fired_reason='timeout') so the blocked agent is re-invoked instead of
 * hanging until a human notices. Two concerns live here, both PG-free so they
 * unit-test without Docker/testcontainers:
 *
 *  1. The re-arm GUIDANCE (P-004): the message the woken agent reads — re-orient,
 *     re-check whether the thing already happened, re-arm if it still matters. A
 *     non-event is a prompt to RECONCILE, not a signal to give up.
 *  2. The DETECTOR (P-003): most timeouts are incidental (a slow event). But a key
 *     FAMILY that times out over and over — with ~no matching event ever — is a
 *     systematic dead-drop: a mistyped key, a dead/renamed emitter, an event that
 *     never fires. That is a BUG the fallback would otherwise silently paper over.
 *     `summarizeTimeoutFires` groups a sweep's fires by normalized family;
 *     `recordTimeoutFires` accumulates across sweeps and flags a family the moment
 *     its running total crosses a warn threshold.
 */

import type { AwaitRow } from './types';

/** The re-arm nudge carried in a timeout wake's `summary` (one human line). */
export const TIMEOUT_WAKE_SUMMARY =
  'await deadline passed WITHOUT the event firing — re-orient (coord:orient), check whether the thing you awaited already happened, and re-arm the await if it still matters. Do not assume it will never come.';

/** The structured guidance carried in a timeout wake's `payload.guidance`. */
export const TIMEOUT_WAKE_GUIDANCE =
  'Your await timed out — the event never fired within the window. This is a FALLBACK wake, not the event. Re-orient with coord:orient, reconcile whether the awaited state already changed (a missed / never-emitted event, a dead emitter, or a mistyped key), and if your work is still blocked on it, RE-ARM the await (or take another path). Do not give up silently.';

/**
 * Normalize an event key to its FAMILY for detector grouping: collapse any
 * segment that carries an id (a digit anywhere, or a long hex/uuid run) to `*`,
 * so `lock:grant:t123` and `lock:grant:t456` both group as `lock:grant:*` and
 * `work-item:done:WI-1` groups as `work-item:done:*`. Static words (grant, done,
 * deploy) are preserved — they are what makes a family recognizable in the log.
 */
export function eventKeyFamily(key: string): string {
  return key
    .split(':')
    .map((seg) => (/\d/.test(seg) || /^[0-9a-f]{16,}$/i.test(seg) ? '*' : seg))
    .join(':');
}

export interface TimeoutFireSummary {
  /** The normalized key family (ids collapsed to `*`). */
  family: string;
  /** How many awaits in this batch timed out on keys in this family. */
  count: number;
  /** The distinct raw keys that timed out (deduped, capped for log sanity). */
  keys: string[];
}

/**
 * Group a batch of timed-out awaits by key family, most-frequent first — the
 * per-sweep detector signal. Pure; reads only each await's `eventKey`.
 */
export function summarizeTimeoutFires(awaits: Array<Pick<AwaitRow, 'eventKey'>>): TimeoutFireSummary[] {
  const counts = new Map<string, number>();
  const rawKeys = new Map<string, Set<string>>();
  for (const a of awaits) {
    const fam = eventKeyFamily(a.eventKey);
    counts.set(fam, (counts.get(fam) ?? 0) + 1);
    const set = rawKeys.get(fam);
    if (set) set.add(a.eventKey);
    else rawKeys.set(fam, new Set([a.eventKey]));
  }
  return [...counts.entries()]
    .map(([family, count]) => ({ family, count, keys: [...(rawKeys.get(family) ?? [])].slice(0, 10) }))
    .sort((a, b) => b.count - a.count || a.family.localeCompare(b.family));
}

// ── cumulative cross-sweep detector ────────────────────────────────────────────
// A family that times out ONCE is noise; one that keeps timing out is the signal.
// Accumulate per-family totals across sweeps (process-lifetime, in-memory — no
// schema needed) and report each family the moment its running total crosses the
// warn threshold, so the operator log gets ONE loud line per systematic dead-drop
// rather than a trickle that blends into the noise.

const cumulativeTotals = new Map<string, number>();

/** Warn once a family's lifetime timeout-fire total reaches this. */
export const TIMEOUT_FIRE_WARN_THRESHOLD = 10;

export interface TimeoutFireCrossing {
  family: string;
  total: number;
}

/**
 * Fold a sweep's per-family summaries into the lifetime totals; return the
 * families that JUST crossed the warn threshold on THIS call (edge-triggered —
 * reported once at the crossing, not on every sweep thereafter).
 */
export function recordTimeoutFires(summaries: TimeoutFireSummary[]): TimeoutFireCrossing[] {
  const crossed: TimeoutFireCrossing[] = [];
  for (const s of summaries) {
    const prev = cumulativeTotals.get(s.family) ?? 0;
    const total = prev + s.count;
    cumulativeTotals.set(s.family, total);
    if (total >= TIMEOUT_FIRE_WARN_THRESHOLD && prev < TIMEOUT_FIRE_WARN_THRESHOLD) {
      crossed.push({ family: s.family, total });
    }
  }
  return crossed;
}

/** Snapshot the lifetime per-family totals (detector inspection / tests). */
export function timeoutFireTotals(): Record<string, number> {
  return Object.fromEntries(cumulativeTotals);
}

/** Test hook: reset the cumulative counter between cases. */
export function __resetTimeoutFireTotals(): void {
  cumulativeTotals.clear();
}
