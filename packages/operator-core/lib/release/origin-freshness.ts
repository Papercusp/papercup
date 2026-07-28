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
  /**
   * WI-5738 — the THIRD signal, and the only one that is not a proxy.
   *
   * The two signals above infer a stall from origin standing still. A publish
   * guard REFUSAL is the stall stated outright: the p2p publish leg reporting,
   * every tick, that it will not publish. It was recorded at
   * `metadata.own_head_publish.refused` and raised NOTHING — no condition, no
   * escalation, no health flag — so the 2026-07-20 wedge ran for five days
   * while the leg logged its own refusal on every single tick. A detector that
   * ignores an explicit self-report in favour of inference is the detector
   * failure, not just a missed inference.
   *
   * Count of CONSECUTIVE sweeps the publish leg has reported a refusal (0 =
   * publishing fine). Null when unknown/not applicable.
   */
  publishRefusedSweeps?: number | null;
  /** The refusal code being reported, for the alarm body (e.g. 'total-over-cap'). */
  publishRefusalCode?: string | null;
}

export interface OriginFreshnessThresholds {
  /** Consecutive sweeps of publish-guard refusal before alarming. Default 3 —
   *  a refusal is a deliberate, sustained verdict, so this only debounces a
   *  blip (e.g. a transient git error) rather than waiting out a real wedge. */
  publishRefusedSweepsMax?: number;
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
  /** WI-5738: the publish leg is explicitly refusing to publish, sustained. */
  publishRefused: boolean;
  /** Human reason for the alarm body, or null when not stale. */
  reason: string | null;
}

export const DEFAULT_AHEAD_COUNT_MAX = 50;
export const DEFAULT_PUBLISH_REFUSED_SWEEPS_MAX = 3;
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
  const refusedMax = thresholds.publishRefusedSweepsMax ?? DEFAULT_PUBLISH_REFUSED_SWEEPS_MAX;

  // WI-5738: an explicit, sustained publish REFUSAL alarms on its own — it is a
  // direct self-report, not an inference, so it must NOT be gated behind the
  // ahead<=0 early return below. In the 2026-07-20 wedge `ahead` was computed
  // against the wrong branch and read 24, which silenced everything; a refusal
  // is true regardless of how any commit-count comes out.
  const publishRefused = (snapshot.publishRefusedSweeps ?? 0) >= refusedMax;
  const refusalReason = publishRefused
    ? `the p2p publish leg has REFUSED to publish for ${snapshot.publishRefusedSweeps} consecutive sweeps` +
      (snapshot.publishRefusalCode ? ` (${snapshot.publishRefusalCode})` : '') +
      ' — nothing this device commits is reaching peers or origin'
    : null;

  const ahead = snapshot.aheadCount ?? 0;
  // Nothing to push (local at/behind the tracked origin tip, or unknown) ⇒ never stale —
  // the false-alarm-fix idiom every sibling watchdog applies to its own "idle" state.
  if (ahead <= 0) {
    return {
      state: publishRefused ? 'stale' : 'ok',
      aheadCountStale: false,
      tipAgeStale: false,
      publishRefused,
      reason: refusalReason,
    };
  }

  const aheadCountStale = ahead >= aheadCountMax;
  const tipAgeStale = snapshot.originTipAgeMs != null && snapshot.originTipAgeMs > tipAgeStaleMs;
  const stale = aheadCountStale || tipAgeStale || publishRefused;

  let reason: string | null = null;
  if (stale) {
    const parts: string[] = [];
    if (refusalReason) parts.push(refusalReason);
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

  return { state: stale ? 'stale' : 'ok', aheadCountStale, tipAgeStale, publishRefused, reason };
}

/**
 * WI-6643 — which of the three signals the operator should be told about.
 *
 * `publish-refused` is the direct self-report; `origin-behind` is the pair of
 * inferred signals (aheadCount / tipAge) that share one runbook.
 */
export type OriginFreshnessCause = 'publish-refused' | 'origin-behind';

export interface OriginFreshnessAlertFraming {
  cause: OriginFreshnessCause;
  /** notifyAttention title. */
  title: string;
  /** The broadcast summary — the ONE line an agent sees in coord:inbox. */
  summary: string;
  /** The "why it matters / claim it" paragraph appended to the alarm body. */
  whyItMatters: string;
}

/**
 * WI-6643 — name the alarm after the cause that actually fired.
 *
 * Until now the title, summary and "why it matters" runbook were hardcoded to the
 * origin-behind framing, and `verdict.reason` (which DOES state a refusal correctly)
 * was buried in the body. On 2026-07-28 that misdirected the responding agent for
 * ~25min: the guard had refused the publish over a secrets finding, and the alarm
 * announced "GitHub origin is falling behind local; bridge divergence classifier
 * reports clear" and told them to go inspect `metadata.github_bridge` and the
 * integrator lease — a bridge that was in fact working fine. The detector was
 * right and the ANNOUNCEMENT sent them to the wrong subsystem.
 *
 * A refusal takes precedence over the inferred signals because it is both the
 * direct self-report AND the actionable one: while the publish leg refuses, origin
 * falls behind as a CONSEQUENCE, so reporting the consequence buries the cause.
 */
export function describeOriginFreshnessAlert(
  verdict: OriginFreshnessVerdict,
  ctx: { slug: string; potHomeSlug?: string | null; publishRefusalCode?: string | null },
): OriginFreshnessAlertFraming {
  const where = ctx.potHomeSlug ? `${ctx.slug} (bridged hive ${ctx.potHomeSlug})` : ctx.slug;

  if (verdict.publishRefused) {
    const code = ctx.publishRefusalCode ?? 'unknown';
    // The recovery lever is code-specific: a `secrets` refusal is the one an agent
    // can clear itself (WI-5591 runtime path exemptions, reachable from an ordinary
    // workspace-scoped session as of WI-6641).
    const lever =
      code === 'secrets'
        ? `Claim it: the publish guard found a secret-shaped string in the range it is judging. Inspect the git-sync ` +
          `journal for the offending path:line, then — if and ONLY if it is a false positive (a detector fixture, a ` +
          `documented example credential, a placeholder, never a REAL live secret) — register it with ` +
          `\`pot_git:secrets_exemptions {action:'add', path, reason}\` and the next tick retries. If it IS a real ` +
          `credential, rotate it; editing the file is NOT enough, because the offending blob is already in history.`
        : `Claim it: inspect the git-sync routine's \`metadata.own_head_publish\` for the refusal detail, and the ` +
          `git-sync journal for the guard's own log line naming the offending commit.`;
    return {
      cause: 'publish-refused',
      title: `p2p publish REFUSED (${code}) — this device's commits are reaching nobody`,
      summary:
        `p2p publish REFUSED on ${ctx.slug} (${code}) — the publish guard is refusing every tick, so nothing this ` +
        `device commits reaches peers or origin. This is NOT a bridge/egress fault.`,
      whyItMatters:
        `Why it matters: the publish guard's baseline only advances through an ADMITTED publish, so a hard refusal ` +
        `re-judges the SAME range on every tick and stays refused until the finding is resolved — it does not ` +
        `self-heal. Origin falling behind is a downstream SYMPTOM here; the bridge and its divergence classifier ` +
        `are working correctly and are not where to look.\n\n${lever}`,
    };
  }

  return {
    cause: 'origin-behind',
    title: 'origin freshness STALLED — GitHub origin is falling behind local',
    summary: `origin freshness STALLED on ${ctx.slug} (bridged) — GitHub origin is falling behind local; bridge divergence classifier reports clear.`,
    whyItMatters:
      `Why it matters: the github-bridge divergence classifier only fires on structured residues ` +
      `(rejectedNonFF / blockedSecrets / …) — a bridge that is reachable but simply stuck (a starved integrator lease, ` +
      `a wedged egress fire) still reports 'clear' while origin freezes. Claim it: inspect the ${where} git-sync ` +
      `routine's metadata.github_bridge for the last tick's outcome, and check whether the bridge writer (integrator ` +
      `lock-authority lease holder) is actually running.`,
  };
}

/**
 * WI-6643 — the recovery line, worded for the cause that had alarmed. Recovering
 * from a refusal is NOT "origin caught back up" (the 2026-07-28 recovery said
 * exactly that when what actually happened was a secrets exemption landing).
 */
export function describeOriginFreshnessRecovery(cause: OriginFreshnessCause, slug: string): string {
  return cause === 'publish-refused'
    ? `p2p publish RECOVERED on ${slug} — the publish guard is admitting again; the earlier refusal alarm is stale.`
    : `origin freshness RECOVERED on ${slug} — GitHub origin has caught back up; the earlier stall alarm is stale.`;
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
