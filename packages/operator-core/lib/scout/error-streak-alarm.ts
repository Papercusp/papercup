/**
 * error-streak-alarm.ts — the Scout cycle ERROR-STREAK pager
 * (scorecard-blender-pipeline-fixes-2026-07-11 P-001 / WI-4274).
 *
 * THE GAP: the autoloop circuit gate BACKS OFF on repeated cycle failures but
 * pages NOBODY — so transport-death streaks run silently until a human happens
 * to look (2026-07-12 morning: 6 consecutive hourly cycles died on "rate-limit
 * pause exceeds maxWait" unnoticed; historically the @singleton Scout produced
 * 0 ideas for 12 days the same silent way). The audit (WI-4250) called this
 * out: "circuit gate exists but pages nobody".
 *
 * THE FIX: after every ERROR tick lands on the ledger, check whether the
 * newest N scout ticks for the workspace are ALL errors (default N=3 ≈ 1.5h of
 * dead hourly cycles; minutes under volume firing). On a streak, fire ONE
 * debounced escalation: a durable `@role:mug`-addressed coord message naming
 * the streak + the distinct error messages (the mug-brief-launch slot drains
 * it into every future Mug wake — the fireGradingNudge "reliable half").
 * Debounced per-workspace over `hive_watchdog_fires`
 * (source='scout-error-streak') so a continuing streak pages at most once per
 * window, never per tick.
 *
 * Same fail-soft watchdog-family contract as ungraded-filings-watchdog.ts:
 * pure decider split from the PG/coord edge, env-tunable threshold with a
 * `<=0` kill switch, NEVER throws into the tick-record path (the ledger write
 * must never fail because paging hiccuped).
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';

// ── tunables ──────────────────────────────────────────────────────────────────

/** Consecutive ERROR ticks that constitute a pageable streak. Default 3;
 *  env PAPERCUSP_SCOUT_ERROR_STREAK_THRESHOLD; `<=0` DISABLES the alarm. */
export function scoutErrorStreakThreshold(): number {
  const n = Number(process.env.PAPERCUSP_SCOUT_ERROR_STREAK_THRESHOLD ?? 3);
  return Number.isFinite(n) ? n : 3;
}

/** Debounce window: a continuing streak re-pages at most once per this many
 *  hours (default 6). */
export function scoutErrorStreakDebounceHours(): number {
  const n = Number(process.env.PAPERCUSP_SCOUT_ERROR_STREAK_DEBOUNCE_HOURS ?? 6);
  return Number.isFinite(n) && n > 0 ? n : 6;
}

// ── pure decider (unit-tested with no DB) ─────────────────────────────────────

/**
 * PURE: do the newest ticks constitute an error streak? `statusesNewestFirst`
 * is the newest-first status column of the last `threshold` ticks — a streak
 * iff we HAVE `threshold` ticks and every one of them is 'error'. A
 * `threshold <= 0` (kill switch) never streaks.
 */
export function isErrorStreak(statusesNewestFirst: readonly string[], threshold: number): boolean {
  if (threshold <= 0) return false;
  if (statusesNewestFirst.length < threshold) return false;
  return statusesNewestFirst.slice(0, threshold).every((s) => s === 'error');
}

// ── the check-and-fire edge ───────────────────────────────────────────────────

/**
 * Called (fire-and-forget) by recordScoutTick after an ERROR tick lands.
 * Workspace-wide read (the install_slug key drifts — same lesson as
 * signal-accumulator.ts); debounced; never throws.
 */
export async function checkAndFireErrorStreakAlarm(opts: {
  workspaceId?: string;
  installSlug?: string | null;
}): Promise<void> {
  try {
    const threshold = scoutErrorStreakThreshold();
    if (threshold <= 0) return; // kill switch
    const ws = opts.workspaceId ?? activeWorkspaceId();
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ status: string; detail: unknown }>>`
      SELECT status, detail
        FROM harness_shared.scout_ticks
       WHERE workspace_id = ${ws} AND origin = 'scout'
       ORDER BY tick_at DESC
       LIMIT ${threshold}`;
    if (!isErrorStreak(rows.map((r) => r.status), threshold)) return;

    // Debounce over hive_watchdog_fires (the watchdog-family dedup surface).
    const slug = opts.installSlug ?? '@singleton';
    const { recentWatchdogFires, recordFire } = await import('../pot/watchdog');
    const windowHours = scoutErrorStreakDebounceHours();
    if ((await recentWatchdogFires(ws, slug, windowHours, 'scout-error-streak')) > 0) return;

    const errors = [
      ...new Set(
        rows
          .map((r) => {
            const d = r.detail as { error?: unknown } | null;
            return typeof d?.error === 'string' ? d.error.slice(0, 160) : null;
          })
          .filter((e): e is string => e !== null),
      ),
    ];
    const summary =
      `Scout cycle ERROR STREAK: the last ${threshold} cycles ALL failed — ideation is down ` +
      `and the circuit gate is only backing off, not fixing it. Distinct errors: ` +
      (errors.length > 0 ? errors.join(' | ') : '(no error detail recorded)') +
      `. Investigate the transport (gateway pool saturation / account limits / ideator timeouts); ` +
      `scout_ticks has per-cycle detail. Signal is NOT lost — the accumulator watermark only ` +
      `advances on a successful cycle — but nothing routes until a cycle lands.`;

    // The durable half (fireGradingNudge's reliable leg): an @role:mug park the
    // Mug brief drains on its next wake, whatever owner id it boots under.
    const [{ sendMessage }, { runWithWorkspace }] = await Promise.all([
      import('../agent-tools/coordination/messages'),
      import('../workspace-als'),
    ]);
    await runWithWorkspace(ws, () =>
      sendMessage(
        {
          ownerId: 'scout-error-streak-alarm',
          ownerLabel: 'scout-error-streak-alarm',
          source: 'static-client',
          workspaceId: ws,
          userId: null,
        },
        { to: ['@role:mug'], summary, body: summary },
      ),
    );
    await recordFire({
      workspaceId: ws,
      installSlug: slug,
      source: 'scout-error-streak',
      reason: `${threshold}-cycle error streak: ${errors[0] ?? 'no detail'}`,
      wakeAt: null,
    });
  } catch (e) {
    console.warn(
      `[scout-error-streak] alarm failed (tick recording unaffected): ${e instanceof Error ? e.message : e}`,
    );
  }
}
