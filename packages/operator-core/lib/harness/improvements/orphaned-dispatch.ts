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

/**
 * EI-1689 — host-restart re-dispatch circuit-breaker. EI-403 Option B rolls a
 * host-restart victim back + re-dispatches it every sweep; with NO cap, a single
 * item thrashes indefinitely while the host is unstable (EI-1405 was re-dispatched
 * 8× — every attempt orphaned by the next restart — and NEVER reached a terminal
 * outcome, burning a dispatch slot the whole time). After this many host-restart
 * recoveries inside {@link ORPHAN_THRASH_WINDOW_MS}, the breaker trips: instead of
 * re-dispatching, route the item to a human (`payload.needsHuman`, the same flag
 * resolve-core sets for attempts-exhausted items — policy.ts honors it and drops
 * the item from the auto-eligible pool). The source (bg-host recycle storm) is
 * addressed separately (EI-1613/EI-1607); this is the residual backstop so a doomed
 * item can't loop forever once the source regresses.
 */
export const HOST_RESTART_REDISPATCH_CAP = 3;
/** Window over which host-restart recoveries are counted toward the cap. */
export const ORPHAN_THRASH_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h — spans a typical instability burst

/**
 * Env-outage detection (D-004 @ relight-self-learning-edges-2026-06-14): when the
 * fleet's shared credential pool is exhausted (rate-limit / weekly-limit / auth),
 * EVERY dispatch dies — and the ones the back-edge couldn't tag (durable fire lost,
 * or the worker killed before it reported) surface as CAUSE-UNKNOWN 2h-collector
 * orphans. Those are outage casualties, not lane breakage, yet they pass
 * isLaneBreakageOrphan (no env marker on the row) → a false "lane broken" EI →
 * which is itself auto-implement-eligible → DOA on the SAME outage → another orphan
 * EI: the EI-536/523/512/509 self-amplifying loop. So while a lane env-outage is
 * detected, cause-unknown orphans are suppressed too (the env outage is captured
 * separately as service-down; once it clears, a genuine orphan re-signals).
 */
export const ENV_OUTAGE_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h — a credential window
export const ENV_OUTAGE_MIN_DEATHS = 2; // ≥2 env deaths in-window ⇒ the lane is in an outage

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
  /**
   * When the lane is in a detected env outage ({@link laneInEnvOutage}), cause-unknown
   * orphans are outage casualties, not lane breakage — suppressed to break the EI-536
   * noise loop. Default false (healthy lane: a cause-unknown orphan IS worth a signal).
   */
  envOutage?: boolean;
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

/** An ENV-failure death (rate-limit / auth / credential, EI-406) — says nothing about the item. */
export function isEnvFailureDeath(r: ImprovementDispatchRow): boolean {
  return r.resolvedBy === 'worker-exit-backedge-env' || (r.fireError ?? '').includes('[env-failure');
}

/**
 * The lane is in an env outage when ≥ENV_OUTAGE_MIN_DEATHS dispatches died with an
 * env-failure signature inside the recent window — the shared credential pool is
 * exhausted, so a death says nothing about any one item. Pure over the ledger rows.
 */
export function laneInEnvOutage(
  rows: readonly ImprovementDispatchRow[],
  opts: { nowMs: number; windowMs?: number; minDeaths?: number },
): boolean {
  const windowMs = opts.windowMs ?? ENV_OUTAGE_WINDOW_MS;
  const minDeaths = opts.minDeaths ?? ENV_OUTAGE_MIN_DEATHS;
  let n = 0;
  for (const r of rows) {
    if (!isEnvFailureDeath(r)) continue;
    const ts = Date.parse(r.resolvedAt ?? r.firedAt);
    if (!Number.isNaN(ts) && opts.nowMs - ts <= windowMs) n += 1;
  }
  return n >= minDeaths;
}

/**
 * A CAUSE-UNKNOWN orphan: the 2h timeout collector drove it terminal with no
 * recorded death cause (no back-edge ever fired — durable-fire lost, or the worker
 * killed before it reported). Indistinguishable from an env casualty DURING an
 * outage; a genuine-breakage signal when the lane is healthy. Only suppressed while
 * {@link laneInEnvOutage} — a 2h-collector orphan that DID carry a real (non-env)
 * fireError is genuine breakage and still signals.
 */
export function isCauseUnknownOrphan(r: ImprovementDispatchRow): boolean {
  return r.resolvedBy === 'orphaned-dispatch-collector' && (r.fireError ?? '').trim() === '';
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
  const envOutage = opts.envOutage ?? false;

  const inWindow = evidence.filter((r) => {
    if (r.outcome !== 'orphaned' || !isLaneBreakageOrphan(r)) return false;
    if (envOutage && isCauseUnknownOrphan(r)) return false; // env-outage casualty, not lane breakage
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
  /**
   * EI-1689: the host-restart re-dispatch breaker has tripped for this item — route
   * it to a human instead of re-dispatching (default sets `payload.needsHuman`, which
   * the policy honors to drop it from the auto-eligible pool).
   */
  escalateThrash: (id: string) => Promise<unknown>;
}

const defaultRecover: OrphanRecoverDeps = {
  releaseClaim: releaseIssue,
  rollbackAttempt: (id, attempts) => mergeIssuePayload(id, { implementAttempts: attempts }),
  escalateThrash: (id) => mergeIssuePayload(id, { needsHuman: true }),
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
  let thrashEscalated = 0;
  for (const row of toMark) {
    const hostRestart = isHostRestartVictim(row, bootMs);
    // EI-1689: count this item's PRIOR host-restart recoveries in the window — each
    // recovery cycle leaves one terminal `host-restart-recovery` row, and `rows`
    // (≤500, ~10d) comfortably spans the 6h window. The current row is still OPEN
    // (in toMark), so it is not yet counted; the breaker trips on the cap-th cycle.
    const priorRestartRecoveries = hostRestart
      ? rows.filter(
          (r) =>
            r.itemId === row.itemId &&
            r.resolvedBy === 'host-restart-recovery' &&
            r.resolvedAt != null &&
            nowMs - Date.parse(r.resolvedAt) <= ORPHAN_THRASH_WINDOW_MS,
        ).length
      : 0;
    const thrashTripped = hostRestart && priorRestartRecoveries >= HOST_RESTART_REDISPATCH_CAP;
    const ok = hostRestart
      ? await markDispatchOrphaned(
          row.id,
          'host-restart-recovery',
          `host restarted mid-dispatch (fired ${row.firedAt}, before process boot) — worker killed; ` +
            (thrashTripped
              ? `re-dispatch cap (${HOST_RESTART_REDISPATCH_CAP} in ${Math.round(ORPHAN_THRASH_WINDOW_MS / 3.6e6)}h) exceeded — routed to human, NOT re-dispatched (EI-1689 thrash breaker)`
              : `claim released + attempt rolled back for re-dispatch (EI-403 Option B)`),
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
        // Always release the dead worker's claim (cleanup). Then EITHER re-dispatch
        // (roll the attempt back) OR — if the breaker tripped — route to a human so
        // the item drops out of the auto-eligible pool instead of thrashing forever.
        await recover.releaseClaim(row.itemId);
        if (thrashTripped) {
          await recover.escalateThrash(row.itemId);
          thrashEscalated += 1;
        } else {
          await recover.rollbackAttempt(row.itemId, Math.max(0, (row.attempt ?? 1) - 1));
          recovered += 1;
        }
      } catch (e) {
        console.warn(
          `[orphaned-dispatch] host-restart recovery failed for ${row.itemId}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  }

  const evidence = [...marked, ...rows.filter((r) => r.outcome === 'orphaned')];
  const envOutage = laneInEnvOutage(rows, { nowMs });
  const signals = buildOrphanedDispatchSignals(evidence, { nowMs, envOutage });
  const notes: string[] = [];
  if (marked.length) notes.push(`marked ${marked.length} open dispatch(es) orphaned (worker presumed dead)`);
  if (recovered) notes.push(`recovered ${recovered} host-restart victim(s) (claim released + attempt rolled back)`);
  if (thrashEscalated)
    notes.push(
      `routed ${thrashEscalated} thrashing item(s) to human — host-restart re-dispatch cap (${HOST_RESTART_REDISPATCH_CAP}) exceeded (EI-1689)`,
    );
  if (envOutage) notes.push('lane env-outage detected — cause-unknown orphans suppressed (EI-536 noise-loop guard)');
  return { signals, ...(notes.length ? { note: notes.join('; ') } : {}) };
}
