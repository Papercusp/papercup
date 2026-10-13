/**
 * green-main-slo-watchdog — the delivery half of P-016 (green-main-cycle-time-2026-10-08,
 * AUTO-BAR-R-14; ruling D-030). `computeGreenMainSlo` decides WHAT is breached; this pass reads
 * its inputs and delivers each breach to the owner exactly once per episode.
 *
 * Why once-per-episode and not once-per-tick: during the 2026-10-02.. red the owner was paged
 * ~100 times a day by an age alarm that re-fired every 15 minutes (measured in
 * harness_shared.attention_notifications, D-030). Each breach carries an `episodeKey` derived from
 * the clock that started it, and `notifyAttentionOnce` reserves that key durably, so a page fires
 * on the first tick past its threshold and never again for that episode, across restarts.
 *
 * Unknown is not fine: a reader that fails leaves its input null (which can only SUPPRESS the
 * breach that input drives, never invent one), and the pass then records a failure in
 * watchdog_health so the silence is visible rather than read as "within SLO". The other inputs
 * still compute, so one broken read never silences the other page.
 *
 * Wired into `startGreenStallWatchdog` beside `checkGateLiveInvariants`.
 */
import type { Sql } from 'postgres';
import type { AttentionNotifyResult, ReplaySafeAttentionNotifyInput } from '../attention-notify';
import {
  computeGreenMainSlo,
  syncTalliesFromDeltaCoverage,
  type GreenMainSlo,
  type GreenMainSloQueue,
  type GreenMainSloThresholds,
  type SyncBatchFleetTally,
} from './green-main-slo';

export interface GreenMainSloPassDeps {
  installSlug: string;
  workspaceId: string;
  nowMs: number;
  thresholds?: GreenMainSloThresholds;
  readLastGreenAtMs: () => Promise<number | null>;
  readLastVerdictAtMs: () => Promise<number | null>;
  /** The live frozen queue, null when none is open. Throw when it cannot be read. */
  readQueue: () => Promise<GreenMainSloQueue | null>;
  /** Per-fleet sync tallies; omit until the sync-batch delta check exposes them. */
  readSyncTallies?: () => Promise<readonly SyncBatchFleetTally[] | null>;
  notifyOnce: (input: ReplaySafeAttentionNotifyInput) => Promise<AttentionNotifyResult>;
}

export interface GreenMainSloDelivery {
  episodeKey: string;
  severity: 'page' | 'alert';
  /** True when an earlier tick already delivered this episode (the steady state of a long red). */
  deduped: boolean;
  /** Set when delivery threw; the breach stays undelivered and the next tick retries it. */
  error?: string;
}

export interface GreenMainSloPassResult {
  slo: GreenMainSlo;
  deliveries: GreenMainSloDelivery[];
  /** Readers that failed this tick, by input name. Empty on a healthy pass. */
  readErrors: Array<{ input: 'lastGreenAt' | 'lastVerdictAt' | 'queue' | 'syncTallies'; message: string }>;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** One pass with injected IO. Never throws: read and delivery failures are reported in the result. */
export async function runGreenMainSloPass(deps: GreenMainSloPassDeps): Promise<GreenMainSloPassResult> {
  const readErrors: GreenMainSloPassResult['readErrors'] = [];
  const read = async <T>(
    input: GreenMainSloPassResult['readErrors'][number]['input'],
    fn: () => Promise<T>,
    fallback: T,
  ): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      readErrors.push({ input, message: message(e) });
      return fallback;
    }
  };

  const [lastGreenAtMs, lastVerdictAtMs, queue, syncTallies] = await Promise.all([
    read('lastGreenAt', deps.readLastGreenAtMs, null),
    read('lastVerdictAt', deps.readLastVerdictAtMs, null),
    read('queue', deps.readQueue, null),
    deps.readSyncTallies ? read('syncTallies', deps.readSyncTallies, null) : Promise.resolve(null),
  ]);

  const slo = computeGreenMainSlo(
    { installSlug: deps.installSlug, nowMs: deps.nowMs, lastGreenAtMs, lastVerdictAtMs, queue, syncTallies },
    deps.thresholds,
  );

  const deliveries: GreenMainSloDelivery[] = [];
  for (const breach of slo.breaches) {
    try {
      const res = await deps.notifyOnce({
        kind: 'intervention',
        title: breach.title,
        body: breach.detail,
        importance: breach.severity === 'page' ? 'urgent' : 'normal',
        harnessSlug: deps.installSlug,
        workspaceId: deps.workspaceId,
        dedupeKey: breach.episodeKey,
        data: {
          source: 'green-main-slo',
          metric: breach.metric,
          severity: breach.severity,
          value: breach.value,
          threshold: breach.threshold,
        },
      });
      deliveries.push({ episodeKey: breach.episodeKey, severity: breach.severity, deduped: res.deduped });
    } catch (e) {
      deliveries.push({ episodeKey: breach.episodeKey, severity: breach.severity, deduped: false, error: message(e) });
    }
  }
  return { slo, deliveries, readErrors };
}

/** Parse `gate_health.lastGreenAt` as stored (epoch ms, number or numeric string). */
export function parseLastGreenAtMs(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`gate_health.lastGreenAt is not an epoch ms: ${String(raw)}`);
  return n;
}

/** The production pass, wired into `startGreenStallWatchdog`. Never throws. */
export async function checkGreenMainSlo(
  sql: Sql,
  opts: { installSlug?: string; nowMs?: () => number; thresholds?: GreenMainSloThresholds } = {},
): Promise<GreenMainSloPassResult | null> {
  const installSlug = opts.installSlug ?? 'papercusp';
  const { recordWatchdogPassOutcome } = await import('./watchdog-health');
  let passError: unknown;
  try {
    const rows = await sql<{ workspace_id: string; last_green_at: string | number | null }[]>`
      SELECT workspace_id, (metadata->'gate_health'->>'lastGreenAt') AS last_green_at
        FROM harness_shared.routines
       WHERE install_slug = ${installSlug} AND target_role = 'system:green-checkpoint'
       LIMIT 1`;
    if (rows.length === 0) return null;
    const workspaceId = rows[0].workspace_id;
    const target = { workspaceId, installSlug };

    const { readVerdictRateWindow } = await import('./gate-verdict-rate-alarm');
    const { readFrozenCandidateRepairQueueState } = await import('../harness/routines/release-actions');
    const { notifyAttentionOnce } = await import('../attention-notify');

    const result = await runGreenMainSloPass({
      installSlug,
      workspaceId,
      nowMs: (opts.nowMs ?? Date.now)(),
      thresholds: opts.thresholds,
      readLastGreenAtMs: async () => parseLastGreenAtMs(rows[0].last_green_at),
      readLastVerdictAtMs: async () => (await readVerdictRateWindow(sql, target)).lastVerdictBearingAtMs,
      readQueue: async () => {
        const q = await readFrozenCandidateRepairQueueState(target);
        if (q.status === 'value') return q.queue;
        if (q.status === 'absent') return null;
        throw new Error(`frozen repair queue unreadable: ${q.reason}`);
      },
      readSyncTallies: async () => {
        const delta = await sql<{ sync_delta: unknown }[]>`
          SELECT metadata->'sync_delta' AS sync_delta FROM harness_shared.routines
           WHERE install_slug = ${installSlug} AND name = 'sync-batch-delta-check'
           LIMIT 1`;
        return syncTalliesFromDeltaCoverage(delta[0]?.sync_delta);
      },
      notifyOnce: notifyAttentionOnce,
    });

    const failed = [
      ...result.readErrors.map((r) => `read ${r.input}: ${r.message}`),
      ...result.deliveries.filter((d) => d.error).map((d) => `deliver ${d.episodeKey}: ${d.error}`),
    ];
    if (failed.length > 0) passError = new Error(failed.join('; '));
    const fresh = result.deliveries.filter((d) => !d.deduped && !d.error);
    if (fresh.length > 0) {
      console.warn(`[green-main-slo] ${installSlug}: delivered ${fresh.map((d) => `${d.severity} ${d.episodeKey}`).join(', ')}`);
    }
    return result;
  } catch (e) {
    passError = e;
    console.warn(`[green-main-slo] pass failed (non-fatal): ${message(e)}`);
    return null;
  } finally {
    await recordWatchdogPassOutcome(sql, 'green-main-slo', { routineName: 'green-checkpoint', installSlug }, passError);
  }
}
