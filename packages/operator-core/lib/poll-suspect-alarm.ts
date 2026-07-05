/**
 * Poll-suspect periodic alarm (EI-7428) — the ANNOUNCE half of the EI-7029
 * poll-detector guard. `flagPollSuspects` (dev-data.ts) already computes the
 * poll-suspect list, but it is READ-TIME-ONLY: it only fires when an agent
 * calls `dev:telemetry`. The statusline double-call storm (~200k wasted MCP
 * calls/day) sat visible-but-unnoticed in that very rollup for WEEKS — the
 * guard as shipped would not have self-announced it either, since nobody
 * looked. This module is the periodic half: an hourly in-process sweep
 * (wired into in-process-periodic.ts, category 'global-sweep') that runs the
 * SAME detector proactively and toasts (surfaced via `notifications:recent`
 * and the /dev Telemetry tab banner) any suspect not already alerted in the
 * last 24h.
 *
 * Dedup state is a plain in-memory Map<tool_name, lastAlertTs> — EPHEMERAL is
 * fine here (a bg-host restart re-alerting once is an acceptable cost; this
 * mirrors the other periodic monitors' fail-open/best-effort posture — see
 * storage-growth-alarm.ts / disk-space-alarm.ts for the sibling pattern this
 * follows). A durable dedup table would be over-engineering for an
 * at-most-once-per-24h announcement.
 */
import { generated, getOrgPg } from '@papercusp/db-org';
import { desc, inArray } from 'drizzle-orm';
import { notifySyncInvalidate } from './sync-sse';
import { flagPollSuspects, telemetryRollup, type PollSuspect } from './dev-data';

const TOAST_RING_BUFFER = 2000;

/** Re-alert window: a suspect already announced within this long stays quiet. */
export const POLL_SUSPECT_ALERT_DEDUPE_MS = 24 * 3600_000;

/** Rollup lookback for each scan tick — short enough to catch a fresh storm quickly,
 *  long enough that a single slow hour doesn't dilute a genuinely sustained rate. */
export const POLL_SUSPECT_SCAN_WINDOW_HOURS = 3;

/**
 * Pure alert-decision: which suspects are NEW (never alerted, or alerted more
 * than `dedupeMs` ago). Unit-testable without a clock/DB/Map mutation — the
 * caller stamps `lastAlertedAt` for the returned suspects AFTER a successful
 * toast, so a failed emit correctly retries next tick instead of silently
 * marking a never-announced suspect as seen.
 */
export function pickNewAlerts(
  suspects: PollSuspect[],
  lastAlertedAt: ReadonlyMap<string, number>,
  now: number,
  dedupeMs: number = POLL_SUSPECT_ALERT_DEDUPE_MS,
): PollSuspect[] {
  return suspects.filter((s) => {
    const last = lastAlertedAt.get(s.tool_name);
    return last === undefined || now - last >= dedupeMs;
  });
}

/** Build the toast body for a batch of newly-alerted suspects. Pure. */
export function formatPollSuspectToast(suspects: PollSuspect[]): {
  level: string;
  message: string;
  description: string;
} {
  const lines = suspects
    .map(
      (s) =>
        `• ${s.tool_name}: ${s.calls_per_hour}/hr aggregate, ${s.callers} caller(s) ` +
        `(~${s.calls_per_caller_per_hour}/hr each)`,
    )
    .join('\n');
  return {
    level: 'warning',
    message: `Poll-suspect alert — ${suspects.length} tool(s) polling-shaped`,
    description:
      `These tools sustain a polling-shaped call rate (EI-7029 guard — expect an ` +
      `SSE/event subscription or a cached read instead):\n${lines}\n\n` +
      `Review in /dev → Telemetry.`,
  };
}

async function defaultEmitToast(t: { level: string; message: string; description: string }): Promise<void> {
  const tl = generated.toastLogInHarnessShared;
  const { db } = getOrgPg();
  await db.insert(tl).values({
    level: t.level,
    message: t.message,
    description: t.description,
    harnessSlug: null,
    createdAt: Date.now(),
    actionLabel: null,
    actionHref: null,
  });
  // Bound the ring buffer (mirrors storage-growth-alarm / disk-space-alarm).
  void (async () => {
    const stale = await db
      .select({ id: tl.id })
      .from(tl)
      .orderBy(desc(tl.createdAt))
      .offset(TOAST_RING_BUFFER);
    if (stale.length > 0) await db.delete(tl).where(inArray(tl.id, stale.map((r) => r.id)));
  })().catch(() => {});
  void notifySyncInvalidate('toastLog.recent', undefined).catch(() => {});
}

export interface PollSuspectScanDeps {
  /** Injectable for tests — defaults to a live cross-workspace telemetryRollup + flagPollSuspects. */
  loadSuspects?: () => Promise<PollSuspect[]>;
  /** Injectable for tests — defaults to a toast_log row + sync invalidate. */
  emitToast?: (t: { level: string; message: string; description: string }) => Promise<void>;
  /** Injectable for tests — defaults to the module-level production dedup map. */
  lastAlertedAt?: Map<string, number>;
  /** Injectable clock for tests. */
  now?: () => number;
  dedupeMs?: number;
}

/** Module-level dedup state for the production wiring (one process, one map — see
 *  the module doc comment on why ephemeral/in-memory is an accepted trade-off here). */
const productionLastAlertedAt = new Map<string, number>();

/**
 * One scan pass: pull the live poll-suspect list, toast the NEW ones (not
 * alerted in the last `dedupeMs`), stamp them alerted. Never throws —
 * observability is best-effort, mirroring the other periodic monitors
 * (storage-growth-alarm, disk-space-alarm).
 */
export async function runPollSuspectScanOnce(
  deps: PollSuspectScanDeps = {},
): Promise<{ checked: number; alerted: PollSuspect[] }> {
  const loadSuspects =
    deps.loadSuspects ??
    (async () => {
      const { entries } = await telemetryRollup({
        workspaceIds: null,
        transports: null,
        hours: POLL_SUSPECT_SCAN_WINDOW_HOURS,
      });
      return flagPollSuspects(entries, POLL_SUSPECT_SCAN_WINDOW_HOURS);
    });
  const emitToast = deps.emitToast ?? defaultEmitToast;
  const lastAlertedAt = deps.lastAlertedAt ?? productionLastAlertedAt;
  const now = deps.now ?? Date.now;
  const dedupeMs = deps.dedupeMs ?? POLL_SUSPECT_ALERT_DEDUPE_MS;

  let suspects: PollSuspect[] = [];
  try {
    suspects = await loadSuspects();
  } catch (err) {
    console.warn(
      `[poll-suspect-alarm] scan skipped (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
    return { checked: 0, alerted: [] };
  }

  const nowMs = now();
  const fresh = pickNewAlerts(suspects, lastAlertedAt, nowMs, dedupeMs);
  if (fresh.length > 0) {
    try {
      await emitToast(formatPollSuspectToast(fresh));
      for (const s of fresh) lastAlertedAt.set(s.tool_name, nowMs);
    } catch (err) {
      console.warn(
        `[poll-suspect-alarm] toast emit failed (non-fatal, retries next tick): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { checked: suspects.length, alerted: fresh };
}
