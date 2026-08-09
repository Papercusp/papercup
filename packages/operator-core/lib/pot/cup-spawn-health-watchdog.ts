/**
 * cup-spawn-health-watchdog — WI-36299: alarm when `cup:spawn` starts failing,
 * INDEPENDENTLY of anyone happening to need a cup.
 *
 * THE GAP: `cup:spawn` had been failing at 100% since at least 2026-07-19
 * (EI-18138823488652209: 9/9 over 19 days) with NO alarm, escalation, or health
 * signal on the spawn path itself the whole time. Every discovery was
 * incidental — an agent tried to place a cup, it failed, and only then did
 * anyone look. `placement-watchdog.ts` (P-020/P-021) reconciles the fallout of
 * a bad placement (re-place / curse / escalate the ITEM), but a run of
 * infra-attributed cup losses is deliberately NOT escalated per item
 * (`infraAttributed` in `evaluatePlacement` — see its doc comment: "the Mug/owner
 * cannot fix such a loss by re-placing or investigating THIS item ... only the
 * per-item NOISE is suppressed"), so a systemic spawn outage produces zero
 * alarms there by design. The gate-health family of watchdogs in this codebase
 * (`release/green-stall-watchdog.ts`) proves the alarming MECHANISM works — the
 * cup-spawn path simply had nothing wired to it. This file is that wiring.
 *
 * THE SIGNAL: consecutive `child_role='cup'` spawn failures with zero successes
 * in between, read directly off `harness_shared.spawned_agents` (the same table
 * `placement-watchdog.ts` / `spawn-reclaim.ts` already read). Deliberately a
 * SIMPLE count-based signal, not a rate over a fixed clock window — a fleet with
 * bursty cup traffic (idle for hours, then several spawns in a minute) makes a
 * fixed-window rate noisy in both directions; N-in-a-row-with-no-success is
 * unambiguous regardless of how sparse or bursty the traffic is, and it is
 * exactly the shape the pot's own IMMEDIATE GOAL already measures manually
 * (`roleSuccess.cup.totalTerminalTurns`) per the item's own suggested guard.
 *
 * Process-level (NOT a DBOS routine), same rationale as `green-stall-watchdog`:
 * the whole point is to keep working even if the routine engine is what's
 * wedged. Reuses the exact alarm plumbing (`notifyAttention` +
 * `broadcastSevereEvent` + `harness_escalations`) under its OWN phase/condition
 * key so it can never clobber another watchdog's dedup state. One-shot per
 * alarm transition (mirrors `checkGreenStall`'s `watchdogAlerted`-style latch,
 * expressed here as "an open escalation row for this phase"); a single
 * successful spawn clears it.
 *
 * Kill-switch: PAPERCUSP_CUP_SPAWN_HEALTH_WATCHDOG='0'.
 */
import type { Sql } from 'postgres';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { broadcastSevereEvent, broadcastSevereEventResolved } from '../severe-event-broadcast';

/** N consecutive cup:spawn failures (no success in between) before this alarms.
 *  Mirrors the orchestrator/placement-watchdog `breakerThreshold` default (3):
 *  a couple of failures can be noise (a flaky account, a transient shed); three
 *  in a row with zero recoveries is the "the whole path is down" signature the
 *  9-over-19-days outage this item reports actually had. */
const DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD = 3;
/** How many of the most recent terminal cup spawns (per workspace+harness) to
 *  read — just enough to see past the threshold with a little headroom, cheap
 *  to query per group via a ROW_NUMBER() window. */
const DEFAULT_SAMPLE_SIZE = 12;
/** Only consider spawns started within this long — bounds the query and keeps
 *  a quiet weekend's last real spawn from being read as "3 failures right now"
 *  months later. Wide enough to span normal low-traffic stretches (a pot can
 *  legitimately go a day+ without needing a cup). */
const DEFAULT_LOOKBACK_MS = 4 * 24 * 60 * 60 * 1000; // 4 days
/** Sweep cadence. cup:spawn can fire many times an hour under load, so this is
 *  deliberately tighter than the hourly-cadence green-checkpoint watchdog. */
const DEFAULT_WATCHDOG_INTERVAL_MS = 5 * 60 * 1000; // 5 min

const WATCHDOG_PHASE = 'cup-spawn-health-watchdog';

export interface CupSpawnHealthThresholds {
  consecutiveThreshold?: number;
  sampleSize?: number;
  lookbackMs?: number;
}

/** The bits of one terminal cup spawn the decider needs. */
export interface CupSpawnRecord {
  status: string;
  exitCode: number | null;
}

export interface CupSpawnHealthSnapshot {
  /** The most recent terminal cup spawns for one (workspace, harness), NEWEST
   *  FIRST. May be empty (no cup spawns in the lookback window — never alarms;
   *  "no cups attempted" is a different question than "cups are failing"). */
  recent: CupSpawnRecord[];
}

export interface CupSpawnHealthVerdict {
  alarmed: boolean;
  /** How many of the newest spawns, walking back from index 0, were failures
   *  before hitting a success (or running out of sample). */
  consecutiveFailures: number;
  sampleSize: number;
  reason: string | null;
}

/** A terminal spawn counts as a SUCCESS only on `status: 'done'` (the launcher
 *  sets `finalStatus = exitCode === 0 ? 'done' : 'failed'` — see
 *  operator-spawn.ts) — `failed`/`cancelled`/`reaped` are all non-success for
 *  this signal (a cancel/reap still means the cup did not do its job). A null
 *  exit_code alongside `status: 'done'` is treated as success (some legacy rows
 *  predate the column) — never the inverse. */
function isSpawnSuccess(r: CupSpawnRecord): boolean {
  return r.status === 'done' && (r.exitCode == null || r.exitCode === 0);
}

/**
 * Pure: does this (workspace, harness)'s recent cup-spawn history show a
 * consecutive-failure streak long enough to call it a systemic outage rather
 * than noise? Exported for unit testing (the DB wiring around it is a thin,
 * fail-soft SQL read — the same split as the other watchdogs in this codebase).
 */
export function evaluateCupSpawnHealth(
  s: CupSpawnHealthSnapshot,
  opts: CupSpawnHealthThresholds = {},
): CupSpawnHealthVerdict {
  const threshold = opts.consecutiveThreshold ?? DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD;
  let consecutiveFailures = 0;
  for (const r of s.recent) {
    if (isSpawnSuccess(r)) break;
    consecutiveFailures++;
  }
  const sampleSize = s.recent.length;
  if (consecutiveFailures < threshold) {
    return { alarmed: false, consecutiveFailures, sampleSize, reason: null };
  }
  return {
    alarmed: true,
    consecutiveFailures,
    sampleSize,
    reason:
      `${consecutiveFailures} consecutive cup:spawn failure(s) with zero successes in between ` +
      `(>= threshold ${threshold}) — the cup pipeline is likely systemically broken (a model/binary ` +
      `mispairing, account-pool exhaustion, or a bad launch config affecting every cup, not one item). ` +
      `Read the most recent failing rows' \`harness_run_output.err_body\` for the real stderr before ` +
      `guessing the cause (see WI-36197 for the model/binary-mispairing shape this has taken before).`,
  };
}

export interface CupSpawnHealthResult {
  alarmed: Array<{ workspaceId: string; harnessSlug: string }>;
  recovered: Array<{ workspaceId: string; harnessSlug: string }>;
}

/**
 * One watchdog pass: for every (workspace, harness) with recent cup-spawn
 * activity, evaluate the consecutive-failure signal and alarm/recover exactly
 * once per transition. Never throws — rides an interval and must not break it.
 */
export async function checkCupSpawnHealth(
  sql: Sql,
  opts: CupSpawnHealthThresholds = {},
): Promise<CupSpawnHealthResult> {
  const out: CupSpawnHealthResult = { alarmed: [], recovered: [] };
  const sampleSize = opts.sampleSize ?? DEFAULT_SAMPLE_SIZE;
  const lookbackMs = opts.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  try {
    const rows = await sql<
      { workspace_id: string; harness_slug: string; status: string; exit_code: number | null }[]
    >`
      WITH ranked AS (
        SELECT workspace_id, harness_slug, status, exit_code, started_at,
               row_number() OVER (PARTITION BY workspace_id, harness_slug ORDER BY started_at DESC) AS rn
          FROM harness_shared.spawned_agents
         WHERE child_role = 'cup'
           AND status IN ('done', 'failed', 'cancelled', 'reaped')
           AND started_at > now() - (${lookbackMs}::text || ' milliseconds')::interval
      )
      SELECT workspace_id, harness_slug, status, exit_code
        FROM ranked
       WHERE rn <= ${sampleSize}
       ORDER BY workspace_id, harness_slug, started_at DESC`;

    const byKey = new Map<string, { workspaceId: string; harnessSlug: string; recent: CupSpawnRecord[] }>();
    for (const r of rows) {
      const key = `${r.workspace_id}\x00${r.harness_slug}`;
      let g = byKey.get(key);
      if (!g) {
        g = { workspaceId: r.workspace_id, harnessSlug: r.harness_slug, recent: [] };
        byKey.set(key, g);
      }
      g.recent.push({ status: r.status, exitCode: r.exit_code });
    }

    for (const { workspaceId, harnessSlug, recent } of byKey.values()) {
      const verdict = evaluateCupSpawnHealth({ recent }, opts);
      const conditionKey = `cup-spawn-health:${workspaceId}:${harnessSlug}`;

      const existing = await sql<{ escalation: unknown }[]>`
        SELECT escalation FROM harness_shared.harness_escalations
         WHERE harness_slug = ${harnessSlug} AND phase = ${WATCHDOG_PHASE}`;
      const alreadyAlarmed = existing.length > 0 && existing[0].escalation != null;

      if (verdict.alarmed) {
        if (alreadyAlarmed) continue; // one-shot until recovery
        try {
          const { notifyAttention } = await import('../attention-notify');
          await notifyAttention({
            kind: 'intervention',
            title: `cup:spawn is failing — ${verdict.consecutiveFailures} consecutive failures on ${harnessSlug}`,
            body: verdict.reason ?? '',
            importance: 'urgent',
            workspaceId,
            data: { consecutiveFailures: verdict.consecutiveFailures, sampleSize: verdict.sampleSize, harnessSlug },
          });
        } catch (e) {
          console.warn(`[cup-spawn-health-watchdog] notify failed: ${e instanceof Error ? e.message : e}`);
        }
        // Fleet broadcast (inject-only, wake=false via oneShot semantics elsewhere
        // in this codebase's severe-event convention): every running agent sees it
        // next turn without a wake storm, and can claim diagnosing/unblocking it.
        await broadcastSevereEvent({
          summary:
            `cup:spawn is failing on ${harnessSlug} — ${verdict.consecutiveFailures} consecutive failures, ` +
            `zero successes. Placement is likely stalled fleet-wide.`,
          body:
            `${verdict.reason}\n\nThis is the FIRST proactive alarm on this path (WI-36299) — before it existed, ` +
            `this class of outage was only ever discovered incidentally, when an agent happened to need a cup. ` +
            `Query harness_shared.harness_run_output for the most recent failing spawn_id's err_body.`,
          category: 'severe-event',
          conditionKey,
          oneShot: true,
        });
        try {
          await sql`
            INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
            VALUES (${harnessSlug}, ${WATCHDOG_PHASE}, ${JSON.stringify({
              kind: WATCHDOG_PHASE,
              harness_slug: harnessSlug,
              workspace_id: workspaceId,
              consecutiveFailures: verdict.consecutiveFailures,
              sampleSize: verdict.sampleSize,
              detail: verdict.reason,
              emitted_at: Date.now(),
            })}, ${Date.now()}, ${workspaceId})
            ON CONFLICT (harness_slug, phase)
            DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`;
        } catch (e) {
          console.warn(`[cup-spawn-health-watchdog] escalation write failed: ${e instanceof Error ? e.message : e}`);
        }
        out.alarmed.push({ workspaceId, harnessSlug });
        console.warn(`[cup-spawn-health-watchdog] ALARM ${harnessSlug}: ${verdict.reason}`);
      } else if (alreadyAlarmed) {
        await sql`
          UPDATE harness_shared.harness_escalations
             SET escalation = NULL, mtime_ms = ${Date.now()}
           WHERE harness_slug = ${harnessSlug} AND phase = ${WATCHDOG_PHASE} AND escalation IS NOT NULL`;
        await broadcastSevereEventResolved({
          conditionKey,
          summary: `cup:spawn RECOVERED on ${harnessSlug} — a successful spawn landed; the earlier failure-rate alarm is stale.`,
        });
        out.recovered.push({ workspaceId, harnessSlug });
      }
    }
    return out;
  } catch (e) {
    console.warn(`[cup-spawn-health-watchdog] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return out;
  }
}

let watchdogTimer: ManagedHandle | null = null;

/**
 * Start the watchdog: an immediate boot check + a recurring process-level
 * sweep. Idempotent (a second call replaces the timer). Kill-switch:
 * PAPERCUSP_CUP_SPAWN_HEALTH_WATCHDOG='0'. The timer is unref'd (via
 * managedSetInterval) so it never keeps the process alive on shutdown.
 */
export function startCupSpawnHealthWatchdog(
  sql: Sql,
  opts: CupSpawnHealthThresholds & { intervalMs?: number } = {},
): void {
  if (process.env.PAPERCUSP_CUP_SPAWN_HEALTH_WATCHDOG === '0') return;
  const intervalMs = opts.intervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;

  const run = (): void => {
    void checkCupSpawnHealth(sql, opts).then((r) => {
      if (r.alarmed.length > 0) {
        console.warn(`[cup-spawn-health-watchdog] alarmed on: ${r.alarmed.map((a) => a.harnessSlug).join(', ')}`);
      }
    });
  };

  run(); // boot check
  if (watchdogTimer) watchdogTimer.stop();
  // D-004: 'violation', declared HONESTLY and retained DELIBERATELY. By the letter of
  // D-004 this recomputes a derived verdict from `harness_shared.spawned_agents`, a store
  // that already emits a change event on every terminal spawn — so the streak could be
  // evaluated invalidate-on-write instead of on a clock. It stays a timer for the reason
  // in this file's header: the alarm must keep firing when the ROUTINE/EVENT ENGINE
  // ITSELF is what is wedged, and a subscription would go silent in exactly that case.
  // Classifying it 'must-sample' to make it look clean would be the self-serving
  // reclassification that empties the register of meaning; D-004 forbids only OMITTING
  // the classification, not declaring a justified violation.
  watchdogTimer = managedSetInterval('cup-spawn-health-watchdog', intervalMs, run, {
    category: 'watchdog',
    classification: 'violation',
  });
}
