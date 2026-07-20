/**
 * origin-freshness — the PURE verdict behind the WI-5607 origin-freshness alarm.
 *
 * THE GAP (EI-13924 follow-up, "REMAINING GAP" suggestion (c)): git-sync-stall-watchdog
 * (this module's sibling) watches the LOCAL tree HEAD — the right signal for `legacy`
 * hives, where git-sync pushes origin directly every tick. For a `bridged` hive, a
 * member's local HEAD advances every tick regardless of whether the bridge writer's
 * egress to GitHub is actually landing, so git-sync-stall-watchdog is structurally blind
 * to a stuck bridge. The bridge's own divergence classifier (github-divergence.ts) is
 * ALSO not a complete backstop: it only fires on STRUCTURED residues the mechanism layers
 * report (rejectedNonFF / blockedSecrets / admission-blocked / …) — a bridge that is
 * reachable but simply stuck/slow/wedged for some OTHER reason (a starved lease, a wedged
 * executor reaping egress fires) still classifies `clear` on every tick while origin
 * silently falls behind.
 *
 * This is a standalone, independent assertion: it doesn't need to know WHY origin is
 * stale, only THAT it is — exactly like commit-staleness is to fire-staleness in
 * git-sync-stall-watchdog. Two signals, either alarms:
 *   1. `aheadCount`      — local canonical is >= `aheadCountMax` commits ahead of the
 *      last-known origin tip (a straight `git rev-list --count <origin>..<local>`).
 *   2. `originTipAgeMs`  — the tracked origin tip has sat UNCHANGED for `tipAgeStaleMs`
 *      while local stayed ahead of it (the head-unchanged-clock idiom
 *      git-sync-stall-watchdog uses for the local HEAD, applied here to the origin tip).
 *
 * FALSE-ALARM FIX (same class as every sibling watchdog): local at or behind the tracked
 * origin tip (`aheadCount <= 0`) is definitionally healthy — nothing to push, so neither
 * signal can mean anything, however old the tracked tip's clock is.
 *
 * Pure + unit-testable; the DB/git wiring (tracking the origin-tip clock across sweeps,
 * reading the bare store, alarming) lives in `origin-freshness-watchdog.ts`.
 */

export interface OriginFreshnessSnapshot {
  /** Commits the LOCAL canonical ref has that the last-known origin tip lacks
   *  (`git rev-list --count <originSha>..<canonicalSha>`). Null when either ref is
   *  unknown/unreadable (a fresh seed / first-ever tick) — treated as 0 (never stale). */
  aheadCount: number | null;
  /** ms the tracked origin tip has sat UNCHANGED while local has stayed ahead of it
   *  (watchdog-tracked; mirrors `GitSyncStallSnapshot.headUnchangedMs`). Null on the first
   *  observation of a given origin sha, or when there is nothing to track (aheadCount<=0)
   *  — never stale on a null age. */
  originTipAgeMs: number | null;
}

export interface OriginFreshnessThresholds {
  /** Local ahead of the tracked origin tip by at least this many commits ⇒ stale,
   *  regardless of how long ago that happened (a sudden pile-up is itself a signal).
   *  Default 50 — generous enough to absorb a normal burst of commits between bridge
   *  ticks (3-min cadence) without crying wolf, small enough to catch a real backlog
   *  well before it becomes a multi-hour strand. */
  aheadCountMax?: number;
  /** The tracked origin tip has sat unchanged this long while local is ahead of it ⇒
   *  stale. Default 3h — matches git-sync-stall-watchdog's fire-stale window and the
   *  EI-13924 incident's actual stall duration (3h/25 commits before it was noticed). */
  tipAgeStaleMs?: number;
}

export interface OriginFreshnessVerdict {
  state: 'ok' | 'stale';
  aheadCountStale: boolean;
  tipAgeStale: boolean;
  /** Human reason for the alarm body, or null when not stale. */
  reason: string | null;
}

export const DEFAULT_AHEAD_COUNT_MAX = 50;
export const DEFAULT_TIP_AGE_STALE_MS = 3 * 60 * 60 * 1000; // 3h

const hrs = (ms: number): number => Math.round(ms / 3_600_000);

/**
 * Decide whether a bridged hive's origin has fallen stale relative to its local canonical.
 * Pure; exported for unit testing. See the module header for the two-signal design + the
 * false-alarm fix.
 */
export function evaluateOriginFreshness(
  snapshot: OriginFreshnessSnapshot,
  thresholds: OriginFreshnessThresholds = {},
): OriginFreshnessVerdict {
  const aheadCountMax = thresholds.aheadCountMax ?? DEFAULT_AHEAD_COUNT_MAX;
  const tipAgeStaleMs = thresholds.tipAgeStaleMs ?? DEFAULT_TIP_AGE_STALE_MS;

  const ahead = snapshot.aheadCount ?? 0;
  // Nothing to push (local at/behind the tracked origin tip, or unknown) ⇒ never stale —
  // the false-alarm-fix idiom every sibling watchdog applies to its own "idle" state.
  if (ahead <= 0) {
    return { state: 'ok', aheadCountStale: false, tipAgeStale: false, reason: null };
  }

  const aheadCountStale = ahead >= aheadCountMax;
  const tipAgeStale = snapshot.originTipAgeMs != null && snapshot.originTipAgeMs > tipAgeStaleMs;
  const stale = aheadCountStale || tipAgeStale;

  let reason: string | null = null;
  if (stale) {
    const parts: string[] = [];
    if (aheadCountStale) {
      parts.push(
        `local canonical is ${ahead} commit(s) ahead of the last-known origin tip (>= ${aheadCountMax}) — a backlog is piling up unpushed`,
      );
    }
    if (tipAgeStale && snapshot.originTipAgeMs != null) {
      parts.push(
        `the tracked origin tip has not advanced in ~${hrs(snapshot.originTipAgeMs)}h while local stayed ${ahead} commit(s) ahead of it — origin looks frozen`,
      );
    }
    reason = parts.join('; ');
  }

  return { state: stale ? 'stale' : 'ok', aheadCountStale, tipAgeStale, reason };
}

/**
 * Thin alias matching the exact signature WI-5607 sketched as the suggested
 * implementation (`originFreshness({ aheadCount, originTipAgeMs }, thresholds) → 'ok' |
 * 'stale'`), for anyone grepping for that name. `evaluateOriginFreshness` above (with the
 * `reason` + per-signal breakdown) is what the watchdog actually consumes.
 */
export function originFreshness(
  snapshot: OriginFreshnessSnapshot,
  thresholds: OriginFreshnessThresholds = {},
): 'ok' | 'stale' {
  return evaluateOriginFreshness(snapshot, thresholds).state;
}
