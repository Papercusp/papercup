/**
 * green-stall-watchdog — EI-455 bug #2: a "no green verdict in N hours" /
 * "green-checkpoint stopped firing" alarm that runs INDEPENDENTLY of the
 * green-checkpoint routine.
 *
 * THE GAP: the in-routine stall detector (`trackGateStall` in
 * harness/routines/release-actions.ts) fires only when green-checkpoint
 * produces a verdict. It already catches stuck-red, no-green-while-firing
 * (>6h), and a crashing/timing-out suite (counted as a red). But it is
 * structurally BLIND to the one failure that actually bit us on 2026-06-13/19:
 * the green-checkpoint routine NOT FIRING AT ALL (the dead-executor dedup
 * wedge). When the routine never runs, `trackGateStall` never runs either —
 * `gate_health` just freezes (`consecutiveReds:0, lastGreenAt:stale,
 * stallAlerted:false`) and NOTHING alarms. `main` froze for ~23h, silently.
 *
 * THE FIX: a process-level watcher — deliberately NOT a DBOS routine, for the
 * same reason the dead-executor reaper isn't one: a routine-based watchdog
 * would queue on the very engine that wedges, so it couldn't fire when most
 * needed. This runs in the operator process, independent of the routine
 * engine, and alarms on EITHER:
 *   1. fire-staleness  — an ACTIVE green-checkpoint routine whose `last_fired_at`
 *      is older than FIRE_STALE_MS (cron is hourly, so ~3 missed fires ⇒ the
 *      scheduler isn't running it). This is the novel signal the in-routine
 *      detector cannot see.
 *   2. verdict-staleness — no GREEN verdict (`lastGreenAt`) in NO_GREEN_MS
 *      (12h). A deep backstop, set well past the in-routine 6h alarm so the two
 *      don't double-ping in the overlap; this only trips if the in-routine path
 *      somehow failed to alarm too.
 *
 * It reuses the exact alarm surfaces of the in-routine detector — an urgent
 * `notifyAttention` + a durable `harness_escalations` row — under its OWN phase
 * (`green-checkpoint-watchdog`) and its OWN dedup flag (`watchdogAlerted`) so it
 * never clobbers the in-routine `green-checkpoint-stall` row/flag. Both can
 * coexist; in the wedge case only the watchdog can fire. Recovery (the routine
 * fires + greens again) clears the flag + escalation idempotently.
 *
 * Kill-switch: PAPERCUSP_GREEN_STALL_WATCHDOG='0'.
 */
import type { Sql } from 'postgres';

/** An ACTIVE green-checkpoint that hasn't FIRED in this long ⇒ the scheduler isn't
 *  running it (cron is hourly at :15, so this is ~3 missed fires). */
const DEFAULT_FIRE_STALE_MS = 3 * 60 * 60 * 1000; // 3h
/** No GREEN verdict in this long ⇒ alarm. A deep backstop past the in-routine 6h
 *  alarm (STALL_AGE_MS) so the two detectors don't double-ping. */
const DEFAULT_NO_GREEN_MS = 12 * 60 * 60 * 1000; // 12h
/** How often the watchdog sweeps. green-checkpoint is hourly, so 15m is ample. */
const DEFAULT_WATCHDOG_INTERVAL_MS = 15 * 60 * 1000; // 15 min

/** Phase + kind for the durable escalation — distinct from the in-routine
 *  `green-checkpoint-stall` so the two never clobber each other. */
const WATCHDOG_PHASE = 'green-checkpoint-watchdog';
const WATCHDOG_KIND = 'green-checkpoint-watchdog';

export interface GreenStallThresholds {
  fireStaleMs?: number;
  noGreenMs?: number;
}

/** The bits of one green-checkpoint routine row the verdict is computed from. */
export interface GreenStallSnapshot {
  /** epoch ms of the routine's last fire (`last_fired_at`), or null if never fired. */
  lastFiredMs: number | null;
  /** epoch ms of the last green verdict (`gate_health.lastGreenAt`), or null. */
  lastGreenAt: number | null;
  /** the watchdog's own dedup flag (`gate_health.watchdogAlerted`). */
  watchdogAlerted: boolean;
}

export interface GreenStallVerdict {
  stalled: boolean;
  /** the routine is active but hasn't fired in fireStaleMs (the scheduler is wedged). */
  fireStale: boolean;
  /** no green verdict in noGreenMs (the deep backstop). */
  verdictStale: boolean;
  /** human reason for the alarm body, or null when not stalled. */
  reason: string | null;
}

const hrs = (ms: number): number => Math.round(ms / 3_600_000);

/**
 * Pure: decide whether one ACTIVE green-checkpoint routine is in a silent stall
 * the in-routine detector cannot see. Exported for unit testing (the DB wiring
 * around it is integration-covered, like the reaper's live self-test).
 *
 * A never-fired routine (`lastFiredMs === null` with no `lastGreenAt`) is a fresh
 * install — no evidence it SHOULD have greened — and never alarms.
 */
export function evaluateGreenStall(
  s: GreenStallSnapshot,
  now: number,
  opts: GreenStallThresholds = {},
): GreenStallVerdict {
  const fireStaleMs = opts.fireStaleMs ?? DEFAULT_FIRE_STALE_MS;
  const noGreenMs = opts.noGreenMs ?? DEFAULT_NO_GREEN_MS;

  const fireStale = s.lastFiredMs != null && now - s.lastFiredMs > fireStaleMs;
  const verdictStale = s.lastGreenAt != null && now - s.lastGreenAt > noGreenMs;
  const stalled = fireStale || verdictStale;

  let reason: string | null = null;
  if (stalled) {
    const parts: string[] = [];
    if (fireStale && s.lastFiredMs != null) {
      parts.push(
        `the routine has not FIRED in ~${hrs(now - s.lastFiredMs)}h (active, cron hourly) — the routine scheduler/engine is not running it`,
      );
    }
    if (verdictStale && s.lastGreenAt != null) {
      parts.push(`no GREEN verdict in ~${hrs(now - s.lastGreenAt)}h`);
    }
    reason = parts.join('; ');
  }
  return { stalled, fireStale, verdictStale, reason };
}

/** Pure: the `harness_escalations` body for a watchdog-detected stall (testable). */
export function greenStallEscalationBody(opts: {
  installSlug: string;
  verdict: GreenStallVerdict;
  lastFiredMs: number | null;
  lastGreenAt: number | null;
  nowMs: number;
}): string {
  return JSON.stringify({
    kind: WATCHDOG_KIND,
    harness_slug: opts.installSlug,
    fireStale: opts.verdict.fireStale,
    verdictStale: opts.verdict.verdictStale,
    lastFiredAt: opts.lastFiredMs != null ? new Date(opts.lastFiredMs).toISOString() : null,
    lastGreenAt: opts.lastGreenAt != null ? new Date(opts.lastGreenAt).toISOString() : null,
    emitted_at: opts.nowMs,
    detail: `green-checkpoint silent stall (watchdog): ${opts.verdict.reason}. ` +
      `\`main\` is frozen and the in-routine stall detector cannot see this (it runs only when the routine fires). ` +
      `The dead-executor reaper should auto-recover a wedge; if this persists the bg-host / DBOS engine needs a look.`,
  });
}

export interface GreenStallWatchdogResult {
  /** install slugs that crossed into a stall this pass (one-shot, deduped). */
  alarmed: string[];
  /** install slugs whose prior stall recovered this pass. */
  recovered: string[];
}

/**
 * One watchdog pass: scan every ACTIVE green-checkpoint routine, alarm once per
 * stall transition (cross-process exactly-once via a conditional flag flip), and
 * clear the flag + escalation on recovery. Never throws — it rides boot + an
 * interval and must not break either.
 */
export async function checkGreenStall(
  sql: Sql,
  opts: GreenStallThresholds = {},
): Promise<GreenStallWatchdogResult> {
  const out: GreenStallWatchdogResult = { alarmed: [], recovered: [] };
  try {
    const rows = await sql<
      {
        install_slug: string;
        workspace_id: string;
        last_fired_ms: string | number | null;
        gh: { lastGreenAt?: number; watchdogAlerted?: boolean } | null;
      }[]
    >`
      SELECT install_slug,
             workspace_id,
             extract(epoch from last_fired_at) * 1000 AS last_fired_ms,
             metadata->'gate_health' AS gh
        FROM harness_shared.routines
       WHERE target_role = 'system:green-checkpoint'
         AND active = true`;

    const now = Date.now();
    for (const row of rows) {
      const lastFiredMs = row.last_fired_ms != null ? Number(row.last_fired_ms) : null;
      const lastGreenAt = row.gh?.lastGreenAt ?? null;
      const watchdogAlerted = row.gh?.watchdogAlerted ?? false;
      const verdict = evaluateGreenStall({ lastFiredMs, lastGreenAt, watchdogAlerted }, now, opts);

      if (verdict.stalled) {
        if (watchdogAlerted) continue; // already alarmed; one-shot until recovery
        // Cross-process exactly-once: only the writer that flips watchdogAlerted
        // false→true gets to alarm. jsonb_set merges into the existing gate_health
        // so we never drop consecutiveReds/lastGreenAt/etc.
        const flip = await sql`
          UPDATE harness_shared.routines
             SET metadata = jsonb_set(
                   COALESCE(metadata, '{}'::jsonb),
                   '{gate_health}',
                   COALESCE(metadata->'gate_health', '{}'::jsonb) || '{"watchdogAlerted":true}'::jsonb
                 ),
                 updated_at = now()
           WHERE install_slug = ${row.install_slug}
             AND target_role = 'system:green-checkpoint'
             AND COALESCE((metadata->'gate_health'->>'watchdogAlerted')::boolean, false) = false`;
        if (flip.count !== 1) continue; // another process won the flip

        try {
          const { notifyAttention } = await import('../attention-notify');
          await notifyAttention({
            kind: 'intervention',
            title: 'Release pipeline STALLED — green-checkpoint not producing greens',
            body: `green-checkpoint (${row.install_slug}) silent stall: ${verdict.reason}. \`main\` is frozen and the per-verdict detector can't see this. The dead-executor reaper should auto-recover a wedge; manual help may be needed if it persists.`,
            importance: 'urgent',
            workspaceId: row.workspace_id,
            data: { fireStale: verdict.fireStale, verdictStale: verdict.verdictStale },
          });
        } catch (e) {
          console.warn(`[green-stall-watchdog] notify failed: ${e instanceof Error ? e.message : e}`);
        }
        try {
          await sql`
            INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
            VALUES (${row.install_slug}, ${WATCHDOG_PHASE}, ${greenStallEscalationBody({
              installSlug: row.install_slug,
              verdict,
              lastFiredMs,
              lastGreenAt,
              nowMs: now,
            })}, ${now}, ${row.workspace_id})
            ON CONFLICT (harness_slug, phase)
            DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`;
        } catch (e) {
          console.warn(`[green-stall-watchdog] escalation write failed: ${e instanceof Error ? e.message : e}`);
        }
        out.alarmed.push(row.install_slug);
        console.warn(`[green-stall-watchdog] ALARM ${row.install_slug}: ${verdict.reason}`);
      } else {
        // Healthy. Clear the watchdog flag (a green verdict already wipes gate_health,
        // so this is belt-and-suspenders) and the escalation row, both idempotently.
        if (watchdogAlerted) {
          await sql`
            UPDATE harness_shared.routines
               SET metadata = jsonb_set(
                     COALESCE(metadata, '{}'::jsonb),
                     '{gate_health}',
                     COALESCE(metadata->'gate_health', '{}'::jsonb) || '{"watchdogAlerted":false}'::jsonb
                   ),
                   updated_at = now()
             WHERE install_slug = ${row.install_slug}
               AND target_role = 'system:green-checkpoint'`;
        }
        // Independent of the flag: a green-verdict wipe can clear watchdogAlerted while
        // leaving our escalation row, so always run the idempotent clear (no-op when null).
        const cleared = await sql`
          UPDATE harness_shared.harness_escalations
             SET escalation = NULL, mtime_ms = ${now}
           WHERE harness_slug = ${row.install_slug}
             AND phase = ${WATCHDOG_PHASE}
             AND escalation IS NOT NULL`;
        if (cleared.count === 1 || watchdogAlerted) out.recovered.push(row.install_slug);
      }
    }
    return out;
  } catch (e) {
    console.warn(`[green-stall-watchdog] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return out;
  }
}

let watchdogTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the watchdog: an immediate boot check + a recurring process-level sweep.
 * Idempotent (a second call replaces the timer). Kill-switch:
 * PAPERCUSP_GREEN_STALL_WATCHDOG='0'. The timer is unref'd so it never keeps the
 * process alive on shutdown.
 */
export function startGreenStallWatchdog(
  sql: Sql,
  opts: GreenStallThresholds & { intervalMs?: number } = {},
): void {
  if (process.env.PAPERCUSP_GREEN_STALL_WATCHDOG === '0') return;
  const intervalMs = opts.intervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;

  const run = (): void => {
    void checkGreenStall(sql, opts).then((r) => {
      if (r.alarmed.length > 0) {
        console.warn(`[green-stall-watchdog] alarmed on: ${r.alarmed.join(', ')}`);
      }
    });
  };

  run(); // boot check
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(run, intervalMs);
  if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref();
}
