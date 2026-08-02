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
 * git-sync-stall-watchdog. Four signals, any of which alarms:
 *   1. `aheadCount`      — local canonical is >= `aheadCountMax` commits ahead of the
 *      last-known origin tip (a straight `git rev-list --count <origin>..<local>`).
 *   2. `originTipAgeMs`  — the tracked origin tip has sat UNCHANGED for `tipAgeStaleMs`
 *      while local stayed ahead of it (the head-unchanged-clock idiom
 *      git-sync-stall-watchdog uses for the local HEAD, applied here to the origin tip).
 *   3. `publishRefusedSweeps` — the publish leg says outright it will not publish (WI-5738).
 *   4. `publishBacklogSweeps` — the publish leg is publishing, admitted, and STILL not
 *      keeping up: `own_head_publish.backlogRemains === true` sustained (WI-6996). See below.
 *
 * EI-19341709637436070: this field was persisted as `drained` (assigned
 * `!resolution.complete` in own-head-publish.ts) until it was renamed — the old name read
 * as "has been drained" (healthy) while `true` actually meant the publish advanced but did
 * NOT reach the worktree head, i.e. backlog REMAINS. Wiring it the intuitive way round
 * would have silently inverted this detector into one that alarms only when the pipeline
 * is healthy. Now named `backlogRemains`, so the value agrees with its name.
 *
 * WI-6996 — WHY SIGNALS 1+2 CANNOT BE THE WHOLE STORY, and why 4 exists.
 *
 * Signals 1 and 2 both measure CANONICAL against ORIGIN. On 2026-08-02 the thing that
 * froze was canonical ITSELF: `refs/hive/staging` stuck at f7a85ad748 for ~6h, with origin
 * sitting at the identical sha because origin can only ever be a copy of canonical. So
 * `aheadCount` was 0 — not "small", exactly 0 — which took the `ahead <= 0` early return
 * below and reported `ok` on every single sweep. The two inferred signals are STRUCTURALLY
 * incapable of seeing a canonical-side freeze: they compare two values that freeze together.
 *
 * The upstream cause was a publish BACKLOG, and it was never a refusal. WI-5738 made
 * own-head publish INCREMENTAL: it drains a bounded slice per tick and CAS-writes
 * `publishedSha`. When the slice is smaller than the inflow the namespace head falls
 * permanently behind the worktree head (it reached ~114 commits back), so the integrator
 * could only announce shas that were ANCESTORS of the already-accepted watermark; the
 * bridge rejected each one non-fast-forward — a TERMINAL reason that skips-and-continues
 * and logs nothing — while `last_status` stayed 'synced'. Nothing refused, so signal 3 read
 * 0 too. Three green signals, ~6h of the fleet's work reaching nobody and no off-box backup.
 *
 * `drained` is the leg's own answer to "is there backlog left?" and it was already being
 * computed and then discarded on every tick. A detector that ignores an explicit self-report
 * in favour of inference is the detector failure — the same lesson signal 3 was added for,
 * re-learned one stage upstream. Signal 4 therefore bypasses the `ahead <= 0` early return
 * for exactly the reason signal 3 does: a backlog is true regardless of how any
 * canonical-vs-origin commit count comes out, and in this incident that count was 0.
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
  /**
   * WI-6996 — the FOURTH signal, and the one that catches the failure the other three
   * are all blind to: the publish leg is ADMITTED (no refusal) and still not keeping up.
   *
   * Count of CONSECUTIVE sweeps the publish leg finished with backlog remaining — i.e.
   * `own_head_publish.backlogRemains === true` (see the module header for the EI-19341709637436070
   * rename this field used to be named `drained`, backwards). 0 = fully caught up (healthy).
   * Null when unknown (pre-WI-7009 metadata that never recorded the field), which is
   * treated as healthy rather than guessed at.
   *
   * A tick or two of backlog is NORMAL — that is what incremental publish IS, and it is
   * why this is a sustained-sweep count and not a boolean. What is not normal is backlog
   * that never clears: the namespace head then falls permanently behind and every
   * downstream stage silently starves.
   */
  publishBacklogSweeps?: number | null;
  /** How far `publishedSha` trails the worktree head right now, for the alarm body.
   *  Null when not computable. Reported, never thresholded — the SWEEP COUNT is the
   *  verdict, because a large backlog that is draining is healthy and a small one that
   *  never moves is not. */
  publishBacklogCommits?: number | null;
}

export interface OriginFreshnessThresholds {
  /** Consecutive sweeps of publish-guard refusal before alarming. Default 3 —
   *  a refusal is a deliberate, sustained verdict, so this only debounces a
   *  blip (e.g. a transient git error) rather than waiting out a real wedge. */
  publishRefusedSweepsMax?: number;
  /** WI-6996: consecutive sweeps of UNDRAINED publish backlog before alarming. Default 4.
   *  The watchdog sweeps every 15 min and git-sync ticks every 3 min, so 4 sweeps = ~1h,
   *  i.e. the publish leg has had ~20 consecutive ticks to drain and has not. That is
   *  comfortably above any legitimate burst (a big but healthy range drains in a handful
   *  of ticks) and far below the ~6 DAYS the 2026-08-02 backlog actually ran undetected. */
  publishBacklogSweepsMax?: number;
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
  /** WI-6996: the publish leg is admitted but has carried backlog for `publishBacklogSweepsMax`
   *  consecutive sweeps — publishing, and still losing ground. */
  publishBacklog: boolean;
  /** Human reason for the alarm body, or null when not stale. */
  reason: string | null;
}

export const DEFAULT_AHEAD_COUNT_MAX = 50;
export const DEFAULT_PUBLISH_REFUSED_SWEEPS_MAX = 3;
export const DEFAULT_PUBLISH_BACKLOG_SWEEPS_MAX = 4;
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
  const backlogMax = thresholds.publishBacklogSweepsMax ?? DEFAULT_PUBLISH_BACKLOG_SWEEPS_MAX;

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

  // WI-6996: an admitted-but-undrained publish backlog, sustained. Like the refusal
  // above — and for the same reason — this must NOT be gated behind the ahead<=0 early
  // return: in the 2026-08-02 wedge canonical and origin were the SAME frozen sha, so
  // `ahead` was exactly 0 and every inferred signal was silenced while the real fault
  // sat one stage upstream, reporting itself honestly on every tick and being discarded.
  const publishBacklog = (snapshot.publishBacklogSweeps ?? 0) >= backlogMax;
  const backlogReason = publishBacklog
    ? `the p2p publish leg has carried UNDRAINED backlog for ${snapshot.publishBacklogSweeps} consecutive sweeps` +
      (snapshot.publishBacklogCommits != null
        ? ` (published head trails the worktree head by ${snapshot.publishBacklogCommits} commit(s))`
        : '') +
      ' — it is publishing, but losing ground, so the namespace head is falling permanently behind'
    : null;

  const ahead = snapshot.aheadCount ?? 0;
  // Nothing to push (local at/behind the tracked origin tip, or unknown) ⇒ never stale —
  // the false-alarm-fix idiom every sibling watchdog applies to its own "idle" state.
  // NOTE the two self-reported signals deliberately survive this return; only the two
  // INFERRED ones are suppressed here.
  if (ahead <= 0) {
    const selfReported = [refusalReason, backlogReason].filter(Boolean) as string[];
    return {
      state: publishRefused || publishBacklog ? 'stale' : 'ok',
      aheadCountStale: false,
      tipAgeStale: false,
      publishRefused,
      publishBacklog,
      reason: selfReported.length > 0 ? selfReported.join('; ') : null,
    };
  }

  const aheadCountStale = ahead >= aheadCountMax;
  const tipAgeStale = snapshot.originTipAgeMs != null && snapshot.originTipAgeMs > tipAgeStaleMs;
  const stale = aheadCountStale || tipAgeStale || publishRefused || publishBacklog;

  let reason: string | null = null;
  if (stale) {
    const parts: string[] = [];
    if (refusalReason) parts.push(refusalReason);
    if (backlogReason) parts.push(backlogReason);
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

  return { state: stale ? 'stale' : 'ok', aheadCountStale, tipAgeStale, publishRefused, publishBacklog, reason };
}

/**
 * WI-6643 — which of the three signals the operator should be told about.
 *
 * `publish-refused` is the direct self-report; `origin-behind` is the pair of
 * inferred signals (aheadCount / tipAge) that share one runbook.
 */
export type OriginFreshnessCause = 'publish-refused' | 'publish-backlog' | 'origin-behind';

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
  ctx: {
    slug: string;
    potHomeSlug?: string | null;
    publishRefusalCode?: string | null;
    publishBacklogCommits?: number | null;
  },
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

  // WI-6996 — a BACKLOG outranks the inferred signals for the same reason a refusal does:
  // origin falling behind is the downstream consequence, so announcing the consequence
  // sends the responder to the bridge, which is working correctly. On 2026-08-02 that
  // misdirection cost ~6h across five agents — the same mistake WI-6643 fixed for
  // refusals, recurring here because the framing was per-cause but the CAUSE was missing.
  if (verdict.publishBacklog) {
    const trails =
      ctx.publishBacklogCommits != null ? ` The published head trails by ${ctx.publishBacklogCommits} commit(s).` : '';
    return {
      cause: 'publish-backlog',
      title: 'p2p publish is LOSING GROUND — backlog never drains, nothing is refused',
      summary:
        `p2p publish BACKLOG on ${ctx.slug} — the publish leg is admitted (NOT refusing) but ends every tick with ` +
        `backlog remaining, so the namespace head is falling permanently behind.${trails} This is NOT a bridge/egress fault.`,
      whyItMatters:
        `Why it matters: own-head publish is INCREMENTAL (WI-5738) — it drains a bounded slice per tick. When the ` +
        `slice is smaller than the inflow, the namespace head loses ground indefinitely and there is no refusal to ` +
        `see, because nothing is being refused. Downstream this is SILENT by construction: the integrator can only ` +
        `announce shas that are ANCESTORS of the already-accepted watermark, the bridge rejects each one ` +
        `non-fast-forward (a TERMINAL reason that skips-and-continues and logs nothing), and \`last_status\` stays ` +
        `'synced' throughout. Canonical then freezes, and because origin is only ever a copy of canonical, the ` +
        `aheadCount/tipAge signals compare two values that are frozen TOGETHER and report healthy.\n\n` +
        `Claim it: read \`metadata.own_head_publish\` on the ${where} git-sync routine — compare \`publishedSha\` ` +
        `(what actually became servable) against \`sha\` (the worktree head judged this tick), and check ` +
        `\`blockedAtCommit\` / \`oversizedCommit\` for a single commit wedging the range. A large blob landing ` +
        `repeatedly in the range (e.g. regenerated multi-MB generated files) throttles the byte cap and is the ` +
        `usual cause of a slice that cannot keep up.`,
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
  if (cause === 'publish-refused') {
    return `p2p publish RECOVERED on ${slug} — the publish guard is admitting again; the earlier refusal alarm is stale.`;
  }
  if (cause === 'publish-backlog') {
    // WI-6996: recovering from a backlog is "the leg caught up", NOT "origin caught back
    // up" — origin catching up is the downstream consequence, and wording it that way is
    // the same conflation that made the original alarm point at the wrong subsystem.
    return `p2p publish DRAINED on ${slug} — the publish leg has caught up and is fully drained; the earlier backlog alarm is stale.`;
  }
  return `origin freshness RECOVERED on ${slug} — GitHub origin has caught back up; the earlier stall alarm is stale.`;
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
