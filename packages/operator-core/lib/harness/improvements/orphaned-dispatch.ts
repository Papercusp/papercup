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
import { releaseIssue, mergeIssuePayload } from '../../issues-engineer';

/**
 * This process's boot time (ms). `process.uptime()` is import-timing-independent
 * (unlike a module-load `Date.now()`), so a dispatch row fired BEFORE this is from
 * a PREVIOUS process — its worker (a child of the dead host) cannot still be alive
 * (EI-403 Option B host-restart recovery). Single-host assumption for the implement
 * lane: the routine + its loopback-fired workers run on one host (the routine holds
 * a cross-host lock), so a row predating boot is a restart victim, not another live
 * host's in-flight worker.
 */
export function processBootMs(): number {
  return Date.now() - Math.floor(process.uptime() * 1000);
}

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
  /**
   * This process's boot time (ms). An OPEN row fired before it is a host-restart
   * victim — orphaned IMMEDIATELY, regardless of age (EI-403 Option B). Default 0
   * (disabled — no row predates the epoch), so the pure threshold semantics are
   * unchanged unless a caller opts in (the glue passes the live processBootMs()).
   */
  bootMs?: number;
}

/** True when an open row predates this process — its worker died with the old host. */
export function isHostRestartVictim(row: ImprovementDispatchRow, bootMs: number): boolean {
  if (row.outcome !== null || bootMs <= 0) return false;
  const firedMs = Date.parse(row.firedAt);
  return !Number.isNaN(firedMs) && firedMs < bootMs;
}

/**
 * Pure: which OPEN ledger rows mean a dead worker — either past the age threshold
 * (the worker timed out / silently died) OR fired before this process booted (a
 * host restart killed it mid-dispatch — EI-403 Option B, recovered now instead of
 * at the 2h threshold). A row whose fire already failed is terminal ('fire-failed')
 * and never reaches this; a row stuck at fire_result='pending' (the dispatcher died
 * mid-fire) does.
 */
export function scanOrphanedDispatches(
  rows: ImprovementDispatchRow[],
  opts: OrphanScanOpts,
): ImprovementDispatchRow[] {
  const orphanAfterMs = opts.orphanAfterMs ?? dispatchOverdueAfterMs();
  const bootMs = opts.bootMs ?? 0;
  return rows.filter((r) => {
    if (r.outcome !== null) return false;
    const firedMs = Date.parse(r.firedAt);
    const age = Number.isNaN(firedMs) ? Number.POSITIVE_INFINITY : opts.nowMs - firedMs;
    return age > orphanAfterMs || isHostRestartVictim(r, bootMs);
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
 * Which 'orphaned' rows indicate POSSIBLE LANE BREAKAGE worth a human signal, vs a
 * correctly-handled transient/infra death that needs no alarm. A worker death is NOT
 * lane breakage when it is:
 *   - a HOST-RESTART victim (resolved_by 'host-restart-recovery') — a deploy/restart
 *     killed it mid-dispatch; already recovered (claim released + attempt rolled back,
 *     EI-403 Option B). Infra, not the lane's fault.
 *   - an ENV-FAILURE death (resolved_by 'worker-exit-backedge-env', or a legacy
 *     'worker-exit-backedge' whose detail still carries '[env-failure') — rate-limit /
 *     auth / connectivity (EI-406); attempt rolled back, self-resolving (e.g. a
 *     weekly-limit reset). Filing a major "lane broken" EI for it is a FALSE ALARM —
 *     and since that EI is itself auto-implement-eligible, it would DOA on the SAME
 *     outage and file ANOTHER orphan EI: a self-amplifying backlog-noise loop (EI-536/
 *     523/512/509). The dispatch-stats rollup still counts it; the human signal does not.
 * INCLUDED (genuine breakage): the 2h orphan collector's catch-all + a genuine non-env
 * worker crash — a worker that actually died/hung for a reason that IS about the lane.
 */
export function isLaneBreakageOrphan(r: ImprovementDispatchRow): boolean {
  if (r.resolvedBy === 'host-restart-recovery' || r.resolvedBy === 'worker-exit-backedge-env') return false;
  if ((r.fireError ?? '').includes('[env-failure')) return false; // legacy rows (pre-distinct resolved_by)
  return true;
}

/**
 * Pure: one signal per ITEM with orphaned-dispatch evidence inside the window.
 * `evidence` is rows with outcome 'orphaned' (just-marked rows included, with
 * their fresh resolvedAt) — EXCLUDING correctly-handled env-failure + host-restart
 * deaths ({@link isLaneBreakageOrphan}), which are transient/infra, not lane
 * breakage. Titles are STABLE (no counts) — the cross-tick search-first dedup
 * matches on them; detail lives in the body.
 */
export function buildOrphanedDispatchSignals(
  evidence: ImprovementDispatchRow[],
  opts: OrphanSignalOpts,
): WatchdogSignal[] {
  const windowMs = opts.evidenceWindowMs ?? ORPHAN_EVIDENCE_WINDOW_MS;
  const maxSignals = opts.maxSignals ?? ORPHAN_MAX_SIGNALS;

  const inWindow = evidence.filter((r) => {
    if (r.outcome !== 'orphaned' || !isLaneBreakageOrphan(r)) return false;
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
 * Recovery seam (EI-403 Option B) — injectable so the glue is unit-testable. Default
 * wires the real issue back-edges: release the stale claim + roll the attempt back.
 */
export interface OrphanRecoverDeps {
  releaseClaim: (id: string) => Promise<unknown>;
  rollbackAttempt: (id: string, attempts: number) => Promise<unknown>;
}

const defaultRecover: OrphanRecoverDeps = {
  releaseClaim: releaseIssue,
  rollbackAttempt: (id, attempts) => mergeIssuePayload(id, { implementAttempts: attempts }),
};

/**
 * Thin PG glue: read recent ledger rows, drive overdue OPEN rows terminal
 * ('orphaned' — race-safe against a late resolve via the `outcome IS NULL`
 * guard), then signal per affected item. Rows a late resolve beat us to are
 * NOT evidence (the worker did resolve — nothing was silent).
 *
 * EI-403 Option B: a row fired before this process booted is a HOST-RESTART victim
 * (a deploy/crash killed the worker AND the /invoke route, so the EI-404 back-edge
 * couldn't fire). Recover it fast — release the item's claim so the next implement
 * tick re-dispatches (vs the 2h stale-claim window) and roll the attempt back (a
 * restart is an environment event, not the item's fault). `bootMs` defaults to the
 * live process boot; tests pin it (0 disables the host-restart leg).
 */
export async function collectOrphanedDispatchSignals(
  workspaceId: string,
  opts: { bootMs?: number; recover?: OrphanRecoverDeps } = {},
): Promise<CollectorResult> {
  const nowMs = Date.now();
  const bootMs = opts.bootMs ?? processBootMs();
  const recover = opts.recover ?? defaultRecover;
  let rows: ImprovementDispatchRow[];
  try {
    rows = await readRecentDispatches(workspaceId, { limit: ORPHAN_SCAN_READ_LIMIT });
  } catch (e) {
    if (isMissingLedgerTable(e)) {
      return { signals: [], note: 'dispatch ledger absent (migration 238 not applied yet) — skipped' };
    }
    throw e;
  }

  const toMark = scanOrphanedDispatches(rows, { nowMs, bootMs });
  const nowIso = new Date(nowMs).toISOString();
  const marked: ImprovementDispatchRow[] = [];
  let recovered = 0;
  for (const row of toMark) {
    const hostRestart = isHostRestartVictim(row, bootMs);
    const ok = hostRestart
      ? await markDispatchOrphaned(
          row.id,
          'host-restart-recovery',
          `host restarted mid-dispatch (fired ${row.firedAt}, before process boot) — worker killed; ` +
            `claim released + attempt rolled back for re-dispatch (EI-403 Option B)`,
        )
      : await markDispatchOrphaned(row.id);
    if (!ok) continue;
    marked.push({
      ...row,
      outcome: 'orphaned',
      resolvedAt: nowIso,
      resolvedBy: hostRestart ? 'host-restart-recovery' : 'orphaned-dispatch-collector',
    });
    if (hostRestart) {
      try {
        await recover.releaseClaim(row.itemId);
        await recover.rollbackAttempt(row.itemId, Math.max(0, (row.attempt ?? 1) - 1));
        recovered += 1;
      } catch (e) {
        console.warn(
          `[orphaned-dispatch] host-restart recovery failed for ${row.itemId}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  }

  const evidence = [...marked, ...rows.filter((r) => r.outcome === 'orphaned')];
  const signals = buildOrphanedDispatchSignals(evidence, { nowMs });
  const notes: string[] = [];
  if (marked.length) notes.push(`marked ${marked.length} open dispatch(es) orphaned (worker presumed dead)`);
  if (recovered) notes.push(`recovered ${recovered} host-restart victim(s) (claim released + attempt rolled back)`);
  return { signals, ...(notes.length ? { note: notes.join('; ') } : {}) };
}
