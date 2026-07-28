/**
 * session-ingest-lag-watchdog.ts — the transcript-ingest silent-degradation
 * guard (session-turn-storage-2026-07-28 P-007, D-005).
 *
 * THE BUG THIS EXISTS TO CATCH, and the reason it is NOT a lag threshold.
 *
 * On 2026-07-28 the corpus read: claude 59 s behind, codex 2 d 9 h behind, omp
 * 6 d 8 h behind. That looks like two dead adapters. It was not — P-005 checked
 * the disk and found ZERO codex rollouts modified since the codex cursor and
 * ZERO omp transcripts modified in 45 days. Both adapters were healthy and
 * fully caught up; nobody had run those clients.
 *
 * That is the whole design constraint. **A quiet adapter and a wedged adapter
 * are INDISTINGUISHABLE in the lag column**, so a watchdog thresholding on
 * `now() - max(ts)` would have paged twice that morning for nothing — and, far
 * worse, would have trained everyone to ignore it before the day a real wedge
 * showed up. Alert fatigue on a silent-degradation guard is not a nuisance, it
 * defeats the guard.
 *
 * So the condition is SOURCE-RELATIVE, not clock-relative: alert only when
 * there are bytes ON DISK that the adapter has NOT consumed and has not
 * consumed for longer than the threshold. That is unambiguous — the work
 * exists, the worker is not doing it — and it stays silent forever on an
 * adapter nobody uses, which is the correct behavior.
 *
 * Same chassis as the sibling watchdogs (rubric-staleness,
 * release-deploy-staleness): a PURE decider unit-tested with no DB or fs, a
 * thin sweep wired into routinesTick as one durable step, fail-soft
 * throughout, an env `<=0` kill switch, and the shared fires-ledger debounce.
 */
import { stat } from 'node:fs/promises';
import { getOrgPg } from '@papercusp/db-org';
import { recentWatchdogFires, recordFire } from '../pot/watchdog';
import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';

/** How long an adapter may sit on unconsumed on-disk bytes before this
 *  watchdog alerts. Default 1 h — comfortably longer than the 2-min ingest
 *  cron plus the per-tick file/byte caps, so normal backlog drain is never
 *  mistaken for a wedge. `<=0` DISABLES the sweep (kill switch). */
export function ingestLagThresholdSec(): number {
  const n = Number(process.env.PAPERCUSP_INGEST_LAG_THRESHOLD_SEC ?? 3_600);
  return Number.isFinite(n) ? n : 3_600;
}

/** Ignore a backlog smaller than this — a transcript's last line is written
 *  incrementally, so a live session ALWAYS has a few hundred unconsumed bytes
 *  (readNewLines deliberately stops at the last complete line). Without this
 *  floor every busy session would look like a wedge. */
export const INGEST_LAG_MIN_BACKLOG_BYTES = 64 * 1024;

/** One adapter's observed state: its most-stale unconsumed file. */
export interface AdapterLagObservation {
  sourceKind: string;
  /** Files with on-disk bytes past their stored byte_offset. */
  behindFiles: number;
  /** Total unconsumed bytes across those files. */
  backlogBytes: number;
  /** Age (ms) of the OLDEST unconsumed backlog — how long the adapter has been
   *  sitting on work, measured from that file's ingest-state updated_at. */
  oldestBacklogAgeMs: number;
  /** The worst offender, for the alert body. */
  worstPath: string | null;
}

export interface IngestLagVerdict {
  wedged: boolean;
  reason: string;
}

/**
 * PURE: is this adapter WEDGED (as opposed to merely quiet)?
 *
 * Deliberately makes no reference to wall-clock lag or to `max(ts)`. The only
 * question asked is: does unconsumed work exist, is it big enough to be real,
 * and has it been sitting there past the threshold?
 */
export function evaluateIngestLag(obs: AdapterLagObservation, thresholdMs: number): IngestLagVerdict {
  if (thresholdMs <= 0) return { wedged: false, reason: 'kill switch (thresholdMs <= 0)' };
  if (obs.behindFiles === 0) {
    return {
      wedged: false,
      reason:
        `${obs.sourceKind}: fully caught up — no on-disk bytes past the cursor. ` +
        `(An adapter nobody is running looks exactly like this, and that is correct: ` +
        `wall-clock lag is NOT evidence of a wedge — D-005.)`,
    };
  }
  if (obs.backlogBytes < INGEST_LAG_MIN_BACKLOG_BYTES) {
    return {
      wedged: false,
      reason:
        `${obs.sourceKind}: ${obs.backlogBytes} unconsumed byte(s) across ${obs.behindFiles} file(s) — ` +
        `below the ${INGEST_LAG_MIN_BACKLOG_BYTES}-byte floor (a live session's partially-written last line).`,
    };
  }
  if (obs.oldestBacklogAgeMs < thresholdMs) {
    const mins = Math.round(obs.oldestBacklogAgeMs / 60_000);
    return {
      wedged: false,
      reason:
        `${obs.sourceKind}: ${obs.backlogBytes} unconsumed byte(s), oldest ${mins}m — ` +
        `inside the threshold window (normal bounded-tick drain).`,
    };
  }
  const hours = (obs.oldestBacklogAgeMs / 3_600_000).toFixed(1);
  const mb = (obs.backlogBytes / 1_048_576).toFixed(1);
  return {
    wedged: true,
    reason:
      `${obs.sourceKind} ingest is WEDGED: ${mb} MB across ${obs.behindFiles} transcript file(s) has sat ` +
      `unconsumed past the adapter's byte_offset for ${hours}h. The work exists on disk and the adapter is ` +
      `not consuming it — this is NOT a quiet client. Worst offender: ${obs.worstPath ?? 'unknown'}.`,
  };
}

const INGEST_LAG_IDENTITY: AgentIdentity = {
  ownerId: 'session-ingest-lag-watchdog',
  ownerLabel: 'system · session-ingest-lag-watchdog',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

export interface IngestLagSweepResult {
  sourceKind: string;
  outcome: 'alerted' | 'healthy' | 'debounced' | 'skipped' | 'error';
  reason: string;
}

export interface IngestLagSweepDeps {
  observe?: () => Promise<AdapterLagObservation[]>;
  recentWatchdogFires?: typeof recentWatchdogFires;
  recordFire?: typeof recordFire;
  openEscalation?: typeof openEscalation;
  now?: number;
}

/**
 * Read each adapter's unconsumed-backlog state.
 *
 * Bounded on purpose: only bookkeeping rows touched inside the ingest window
 * are considered, and only the N most recently-updated per source_kind are
 * stat()ed. The corpus is ~13k claude rows — stat()ing all of them every
 * routines tick would be a fleet-visible fs storm for a health check, and a
 * wedge that affects only cold files nobody is appending to is not a wedge.
 */
async function observeAdapterLag(): Promise<AdapterLagObservation[]> {
  const { sql } = getOrgPg();
  const MAX_FILES_PER_KIND = 250;
  const rows = await sql<Array<{
    source_kind: string; file_path: string; byte_offset: string | number; updated_at: string;
  }>>`
    SELECT source_kind, file_path, byte_offset, updated_at::text AS updated_at
      FROM (
        SELECT source_kind, file_path, byte_offset, updated_at,
               row_number() OVER (PARTITION BY source_kind ORDER BY updated_at DESC) AS rn
          FROM harness_shared.session_ingest_state
         WHERE file_path <> '__hwm__'
           AND updated_at > now() - interval '45 days'
      ) ranked
     WHERE rn <= ${MAX_FILES_PER_KIND}
  `;
  const byKind = new Map<string, AdapterLagObservation>();
  const now = Date.now();
  for (const r of rows) {
    const obs = byKind.get(r.source_kind) ?? {
      sourceKind: r.source_kind, behindFiles: 0, backlogBytes: 0, oldestBacklogAgeMs: 0, worstPath: null,
    };
    byKind.set(r.source_kind, obs);
    let size: number;
    try {
      const s = await stat(r.file_path);
      if (!s.isFile()) continue;
      size = s.size;
    } catch {
      // Archived/deleted after its state row was written — not a backlog.
      continue;
    }
    const behind = size - Number(r.byte_offset);
    if (behind <= 0) continue;
    const ageMs = Math.max(0, now - Date.parse(r.updated_at));
    obs.behindFiles += 1;
    obs.backlogBytes += behind;
    if (ageMs > obs.oldestBacklogAgeMs) {
      obs.oldestBacklogAgeMs = ageMs;
      obs.worstPath = r.file_path;
    }
  }
  // Every source_kind with a bookkeeping row is seeded above BEFORE the
  // stat(), so an adapter with zero backlog still reports a healthy verdict
  // rather than silently vanishing from the sweep.
  return [...byKind.values()];
}

/**
 * The ingest-lag sweep. Debounced per source_kind via the shared fires ledger
 * (one alert per threshold window); fail-soft per adapter AND overall.
 * Kill switch: PAPERCUSP_INGEST_LAG_THRESHOLD_SEC <= 0.
 */
export async function sessionIngestLagSweep(
  opts: { workspaceId?: string; installSlug?: string } = {},
  deps: IngestLagSweepDeps = {},
): Promise<IngestLagSweepResult[]> {
  const thresholdSec = ingestLagThresholdSec();
  if (thresholdSec <= 0) return [{ sourceKind: '*', outcome: 'skipped', reason: 'kill switch' }];
  const thresholdMs = thresholdSec * 1_000;
  const workspaceId = opts.workspaceId ?? 'papercusp-workspace';
  const installSlug = opts.installSlug ?? 'papercusp';
  const results: IngestLagSweepResult[] = [];
  try {
    const observations = await (deps.observe ?? observeAdapterLag)();
    for (const obs of observations) {
      try {
        const verdict = evaluateIngestLag(obs, thresholdMs);
        if (!verdict.wedged) {
          results.push({ sourceKind: obs.sourceKind, outcome: 'healthy', reason: verdict.reason });
          continue;
        }
        const windowHours = Math.max(1, Math.round(thresholdSec / 3_600));
        const firedRecently =
          (await (deps.recentWatchdogFires ?? recentWatchdogFires)(
            workspaceId, installSlug, windowHours, 'session-ingest-lag', obs.sourceKind,
          )) > 0;
        if (firedRecently) {
          results.push({ sourceKind: obs.sourceKind, outcome: 'debounced', reason: 'fires-ledger debounce' });
          continue;
        }
        console.warn(`[session-ingest-lag] ALERT: ${verdict.reason}`);
        await (deps.recordFire ?? recordFire)({
          workspaceId, installSlug, source: 'session-ingest-lag', reason: verdict.reason, wakeAt: null,
        });
        await (deps.openEscalation ?? openEscalation)(INGEST_LAG_IDENTITY, {
          severity: 'advisory',
          summary: `Transcript ingest wedged for source_kind '${obs.sourceKind}'`,
          body:
            `${verdict.reason}\n\n` +
            `Why this is trustworthy: the condition is SOURCE-RELATIVE, not a lag threshold — it fires only ` +
            `because unconsumed bytes exist on disk, so a quiet client can never trigger it (D-005).\n\n` +
            `To diagnose: read harness_shared.session_ingest_state for this source_kind (last_error, ` +
            `byte_offset, updated_at) and compare against the file on disk. A stuck byte_offset with a ` +
            `recurring last_error is a parse/DB failure; a stuck offset with NO error is usually the sweep ` +
            `not reaching this adapter (per-tick file/byte caps, or an enumerate failure earlier in the ` +
            `adapter loop). Force one pass with ingestFileNow on the worst path to surface the real error.`,
        });
        results.push({ sourceKind: obs.sourceKind, outcome: 'alerted', reason: verdict.reason });
      } catch (e) {
        results.push({
          sourceKind: obs.sourceKind, outcome: 'error', reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    results.push({ sourceKind: '*', outcome: 'error', reason: e instanceof Error ? e.message : String(e) });
  }
  return results;
}
