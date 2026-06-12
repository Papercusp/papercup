/**
 * orphaned-dispatch.ts — the orphaned-dispatch watchdog collector
 * (self-improvement-consume-edges-2026-06-12 P-011 / B-05, with B-04's ledger
 * the other half of EI-365's fix).
 *
 * The auto-implement lane dispatched for two days without a single resolve and
 * nothing noticed: a worker that dies silently (SIGTERM, crash, never spawned)
 * never calls `improvements:resolve`, and before the dispatch ledger (migration
 * 238) there was no record to notice it BY. This collector closes that edge —
 * the watchdog finally watches the implement lane itself:
 *
 *   1. An OPEN ledger row (outcome NULL) older than the threshold T means the
 *      worker is presumed dead. The collector drives it terminal
 *      (`markDispatchOrphaned` — the ledger's designated P-011 write) so a dead
 *      worker is permanently distinguishable from one in progress.
 *   2. Each affected ITEM files one `orphaned-dispatch` signal through the
 *      normal capture path (search-first dedup, known-open pre-filter,
 *      per-tick caps) — so repeated worker death generates queue pressure
 *      instead of silence.
 *
 * T defaults to 2h via `dispatchOverdueAfterMs()` (dispatch-ledger.ts, env
 * `PAPERCUSP_IMPROVEMENT_DISPATCH_OVERDUE_MS`) — ONE tunable shared with the
 * ledger's `overdue` read bucket, aligned with plan-implement's stale-claim
 * window and comfortably above the 45-min worker timeout. Already-orphaned rows
 * keep signaling for an evidence window so a signal deferred by the per-tick
 * cap re-fires next tick instead of dying with the row's terminal transition.
 *
 * Pure core (`scanOrphanedDispatches` + `buildOrphanedDispatchSignals`) + thin
 * PG glue (`collectOrphanedDispatchSignals`), mirroring insight-staleness.ts.
 * The glue skips with a note (not an error) while migration 238 is not yet
 * applied — a deploy-ordering gap must not self-escalate the watchdog.
 */

import type { WatchdogSignal } from './watchdog';
import type { CollectorResult } from './watchdog';
import {
  dispatchOverdueAfterMs,
  markDispatchOrphaned,
  readRecentDispatches,
  type ImprovementDispatchRow,
} from './dispatch-ledger';

/**
 * How long an already-orphaned row keeps backing a signal (re-fire window). The
 * capture can be deferred by the watchdog's per-tick caps — the evidence must
 * outlive the deferral, not vanish the tick after the row goes terminal.
 */
export const ORPHAN_EVIDENCE_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Cap signals per sweep (the watchdog has its own per-tick cap on top). */
export const ORPHAN_MAX_SIGNALS = 5;

/** Ledger rows the glue reads per sweep (newest-first; ~10 days at the lane's cadence). */
export const ORPHAN_SCAN_READ_LIMIT = 500;

export interface OrphanScanOpts {
  nowMs: number;
  /** Open-row age past which the worker is presumed dead. Default dispatchOverdueAfterMs(). */
  orphanAfterMs?: number;
}

/**
 * Pure: which OPEN ledger rows are past the threshold — the worker is presumed
 * dead and the row should be driven terminal ('orphaned'). A row whose fire
 * already failed is terminal ('fire-failed') and never reaches this; a row
 * stuck at fire_result='pending' (the dispatcher died mid-fire) does.
 */
export function scanOrphanedDispatches(
  rows: ImprovementDispatchRow[],
  opts: OrphanScanOpts,
): ImprovementDispatchRow[] {
  const orphanAfterMs = opts.orphanAfterMs ?? dispatchOverdueAfterMs();
  return rows.filter((r) => {
    if (r.outcome !== null) return false;
    const firedMs = Date.parse(r.firedAt);
    const age = Number.isNaN(firedMs) ? Number.POSITIVE_INFINITY : opts.nowMs - firedMs;
    return age > orphanAfterMs;
  });
}

export interface OrphanSignalOpts {
  nowMs: number;
  /** How long orphaned evidence keeps re-firing the signal. Default ORPHAN_EVIDENCE_WINDOW_MS. */
  evidenceWindowMs?: number;
  /** Cap signals per sweep. Default ORPHAN_MAX_SIGNALS. */
  maxSignals?: number;
}

/**
 * Pure: one signal per ITEM with orphaned-dispatch evidence inside the window.
 * `evidence` is rows with outcome 'orphaned' (just-marked rows included, with
 * their fresh resolvedAt). Titles are STABLE (no counts) — the cross-tick
 * search-first dedup matches on them; detail lives in the body.
 */
export function buildOrphanedDispatchSignals(
  evidence: ImprovementDispatchRow[],
  opts: OrphanSignalOpts,
): WatchdogSignal[] {
  const windowMs = opts.evidenceWindowMs ?? ORPHAN_EVIDENCE_WINDOW_MS;
  const maxSignals = opts.maxSignals ?? ORPHAN_MAX_SIGNALS;

  const inWindow = evidence.filter((r) => {
    if (r.outcome !== 'orphaned') return false;
    const ts = r.resolvedAt ? Date.parse(r.resolvedAt) : NaN;
    return !Number.isNaN(ts) && opts.nowMs - ts <= windowMs;
  });

  const byItem = new Map<string, ImprovementDispatchRow[]>();
  for (const r of inWindow) {
    const list = byItem.get(r.itemId) ?? [];
    list.push(r);
    byItem.set(r.itemId, list);
  }

  const newestTs = (rows: ImprovementDispatchRow[]): string =>
    rows.map((r) => r.resolvedAt as string).sort().at(-1) as string;

  return [...byItem.entries()]
    .sort(([, a], [, b]) => (newestTs(a) < newestTs(b) ? 1 : -1))
    .slice(0, maxSignals)
    .map(([itemId, rows]) => {
      const newest = rows.reduce((a, b) => ((a.firedAt ?? '') > (b.firedAt ?? '') ? a : b));
      const runIds = [...new Set(rows.map((r) => r.spawnedRunId).filter(Boolean))] as string[];
      return {
        source: 'orphaned-dispatch' as const,
        key: itemId,
        // STABLE title (no counts) — the cross-tick search-first dedup matches on it.
        title: `Auto-implement dispatch for ${itemId} died without resolving — orphaned worker`,
        body:
          `${rows.length} dispatch(es) of improvement \`${itemId}\` went past the orphan threshold with no ` +
          `\`improvements:resolve\` ever recorded — the worker died silently (crashed, SIGTERM'd, or never spawned).\n` +
          `Latest: attempt ${newest.attempt}, fired ${newest.firedAt}, fire_result=${newest.fireResult}` +
          (newest.runnerHarness ? `, runner '${newest.runnerHarness}'` : '') +
          (runIds.length ? `, spawned run(s): ${runIds.join(', ')}` : ', no spawn correlation recorded') +
          `.\n\nThe ledger row(s) are now marked 'orphaned' (terminal); the exhaustion flip routes the item ` +
          `itself to a human once its attempts cap out. Investigate WHY the worker died: the runner harness ` +
          `spawn path, the worker timeout, or the fire transport — repeated orphans mean the implement lane ` +
          `is broken, not the item.`,
        severity: 'major' as const,
        kind: 'bug' as const,
        paths: [
          'packages/operator-core/lib/harness/routines/improvement-actions.ts',
          'packages/operator-core/lib/harness/improvements/dispatch-ledger.ts',
        ],
        latestAt: newestTs(rows),
      };
    });
}

/** True when the error is PG's undefined_table (migration 238 not applied yet). */
function isMissingLedgerTable(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === '42P01') return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /improvement_dispatches.*does not exist|relation.*improvement_dispatches/i.test(msg);
}

/**
 * Thin PG glue: read recent ledger rows, drive overdue OPEN rows terminal
 * ('orphaned' — race-safe against a late resolve via the `outcome IS NULL`
 * guard), then signal per affected item. Rows a late resolve beat us to are
 * NOT evidence (the worker did resolve — nothing was silent).
 */
export async function collectOrphanedDispatchSignals(workspaceId: string): Promise<CollectorResult> {
  const nowMs = Date.now();
  let rows: ImprovementDispatchRow[];
  try {
    rows = await readRecentDispatches(workspaceId, { limit: ORPHAN_SCAN_READ_LIMIT });
  } catch (e) {
    if (isMissingLedgerTable(e)) {
      return { signals: [], note: 'dispatch ledger absent (migration 238 not applied yet) — skipped' };
    }
    throw e;
  }

  const toMark = scanOrphanedDispatches(rows, { nowMs });
  const nowIso = new Date(nowMs).toISOString();
  const marked: ImprovementDispatchRow[] = [];
  for (const row of toMark) {
    if (await markDispatchOrphaned(row.id)) {
      marked.push({ ...row, outcome: 'orphaned', resolvedAt: nowIso, resolvedBy: 'orphaned-dispatch-collector' });
    }
  }

  const evidence = [...marked, ...rows.filter((r) => r.outcome === 'orphaned')];
  const signals = buildOrphanedDispatchSignals(evidence, { nowMs });
  return {
    signals,
    ...(marked.length ? { note: `marked ${marked.length} open dispatch(es) orphaned (worker presumed dead)` } : {}),
  };
}
