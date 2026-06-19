/**
 * Per-thread perf-SLO budgets (round-4 Lane F / P-030). The DURABLE budget contract
 * that turns Lane E's `perf-signals-v1` capture (E1, ~/.papercusp/perf-baselines/
 * capture-signals.py) into a standing operator-health verdict — consumed by the
 * `infra` health panel so a per-thread saturation episode reds `overall` (the
 * operator_degraded signal) instead of being discoverable only by tool calls failing.
 *
 * LOAD-BEARING REFRAME (round-4 E5, su-1aa2f): this box has 128 cores, so loadavg
 * 16–22 is a ratio ~0.13 = STABLE, not oversubscription. The constraint is PER-THREAD
 * event-loop saturation (D-002), NOT host capacity. Therefore every budget here is
 * per-thread / per-worker / definitive-wedge — there is deliberately NO loadavg-
 * absolute budget. Budgeting on loadavg would lie on a many-core box.
 */
import type { PanelStatus } from './types';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** The subset of Lane E's perf-signals-v1 record the budgets read. The MCP-merged
 *  signals (eventLoopLag, tool p95, pgConns) are null until an agent run keyed to
 *  capturedAt fills them, so they are optional — host-side signals alone yield a
 *  verdict. */
export interface PerfSignalsV1 {
  schemaVersion: string;
  capturedAt: string; // ISO 8601
  hostState: 'stable' | 'wedge-active' | string;
  signals: {
    loadavg?: { l1: number; l5: number; l15: number; cores: number } | null;
    operatorWorkers?: Array<{ pid: number; cpuPct: number; rssKb: number; etimeSec: number }> | null;
    closeWait_3070?: number | null;
    gateway_8788_reachable?: boolean | null;
    operator_3070_reachable?: boolean | null;
    // MCP-merged (null until an agent run fills them) — supported in either spot.
    eventLoopLag?: { lag_p95_ms?: number | null } | null;
    _mcp_supplemented?: { eventLoopLag?: { lag_p95_ms?: number | null } | null } | null;
  };
}

export interface PerfBudgets {
  /** A request worker sustained above this %CPU is HOT (warn). Noisy on a many-core
   *  box, so never crit on its own — the event-loop-lag + reachability + CLOSE_WAIT
   *  signals are the definitive per-thread-saturation crits. */
  workerCpuPctWarn: number;
  /** Worker RSS (KB) warn — the bg-host OOM'd at ~3.2GB (EI-1613); a leak/working-set watch. */
  workerRssKbWarn: number;
  /** :3070 CLOSE_WAIT — a pegged event loop can't run socket close() callbacks, so
   *  sockets pile up (deeb4: 0→470 while pegged, 935 peak). warn then crit. */
  closeWaitWarn: number;
  closeWaitCrit: number;
  /** Event-loop lag p95 (ms) — THE per-thread saturation signal (cpuprofile p95 was
   *  1746ms during the wedge). Only evaluated when an agent run merged it. warn then crit. */
  eventLoopLagP95WarnMs: number;
  eventLoopLagP95CritMs: number;
  /** A capture older than this (ms) is STALE — don't threshold it (avoid alarming on
   *  an old snapshot when the E1 cron hasn't run recently). */
  staleMs: number;
}

/** Default per-thread budgets, grounded in the round-4 baseline + live evidence. */
export const PERF_BUDGETS: PerfBudgets = {
  workerCpuPctWarn: 200,
  workerRssKbWarn: 3_000_000,
  closeWaitWarn: 200,
  closeWaitCrit: 500,
  eventLoopLagP95WarnMs: 250,
  eventLoopLagP95CritMs: 1000,
  staleMs: 10 * 60_000,
};

export interface PerfVerdict {
  /** ok | warn | crit | unknown (stale, or no usable signals). */
  status: PanelStatus;
  /** Convenience: the standing operator_degraded boolean (status === 'crit'). */
  degraded: boolean;
  /** Human reasons for the worst tier reached (the alarm copy). */
  reasons: string[];
  hostState: string | null;
  worstWorkerCpuPct: number | null;
  worstWorkerRssKb: number | null;
  closeWait: number | null;
  eventLoopLagP95Ms: number | null;
  operatorReachable: boolean | null;
  ageMs: number | null;
  stale: boolean;
}

function lagP95(s: PerfSignalsV1['signals']): number | null {
  const v = s.eventLoopLag?.lag_p95_ms ?? s._mcp_supplemented?.eventLoopLag?.lag_p95_ms;
  return typeof v === 'number' ? v : null;
}

/**
 * Evaluate a perf-signals-v1 capture against per-thread budgets. PURE — no IO. A
 * stale capture (older than budgets.staleMs measured from `nowMs`) returns `unknown`
 * so an old snapshot never reds the system. Crit is reserved for DEFINITIVE per-thread
 * wedge signals (operator unreachable, hostState=wedge-active, event-loop-lag, a
 * CLOSE_WAIT storm); worker CPU%/RSS are warn-only (noisy on a many-core box).
 */
export function evaluatePerfSignals(
  signals: PerfSignalsV1 | null | undefined,
  nowMs: number,
  budgets: PerfBudgets = PERF_BUDGETS,
): PerfVerdict {
  const base: PerfVerdict = {
    status: 'unknown', degraded: false, reasons: [], hostState: null,
    worstWorkerCpuPct: null, worstWorkerRssKb: null, closeWait: null,
    eventLoopLagP95Ms: null, operatorReachable: null, ageMs: null, stale: false,
  };
  if (!signals || signals.schemaVersion !== 'perf-signals-v1') return base;
  const s = signals.signals ?? ({} as PerfSignalsV1['signals']);
  const capMs = Date.parse(signals.capturedAt);
  const ageMs = Number.isNaN(capMs) ? null : Math.max(0, nowMs - capMs);
  const workers = Array.isArray(s.operatorWorkers) ? s.operatorWorkers : [];
  const worstCpu = workers.length ? Math.max(...workers.map((w) => w.cpuPct || 0)) : null;
  const worstRss = workers.length ? Math.max(...workers.map((w) => w.rssKb || 0)) : null;
  const closeWait = typeof s.closeWait_3070 === 'number' ? s.closeWait_3070 : null;
  const lag = lagP95(s);
  const reachable = typeof s.operator_3070_reachable === 'boolean' ? s.operator_3070_reachable : null;
  const v: PerfVerdict = {
    ...base,
    hostState: signals.hostState ?? null,
    worstWorkerCpuPct: worstCpu, worstWorkerRssKb: worstRss, closeWait,
    eventLoopLagP95Ms: lag, operatorReachable: reachable, ageMs,
    stale: ageMs !== null && ageMs > budgets.staleMs,
  };
  if (v.stale) return { ...v, status: 'unknown' };

  // ── CRIT: definitive per-thread wedge (NOT loadavg — see the file header) ──────
  const crit: string[] = [];
  if (reachable === false) crit.push('operator :3070 unreachable');
  if (signals.hostState === 'wedge-active') crit.push('hostState=wedge-active (live wedge captured)');
  if (lag !== null && lag >= budgets.eventLoopLagP95CritMs) crit.push(`event-loop lag p95 ${lag}ms ≥ ${budgets.eventLoopLagP95CritMs}ms`);
  if (closeWait !== null && closeWait >= budgets.closeWaitCrit) crit.push(`:3070 CLOSE_WAIT ${closeWait} ≥ ${budgets.closeWaitCrit} (event-loop peg)`);
  if (crit.length) return { ...v, status: 'crit', degraded: true, reasons: crit };

  // ── WARN: hot-but-not-fatal ────────────────────────────────────────────────────
  const warn: string[] = [];
  if (lag !== null && lag >= budgets.eventLoopLagP95WarnMs) warn.push(`event-loop lag p95 ${lag}ms ≥ ${budgets.eventLoopLagP95WarnMs}ms`);
  if (closeWait !== null && closeWait >= budgets.closeWaitWarn) warn.push(`:3070 CLOSE_WAIT ${closeWait} ≥ ${budgets.closeWaitWarn}`);
  if (worstCpu !== null && worstCpu >= budgets.workerCpuPctWarn) warn.push(`a worker at ${Math.round(worstCpu)}% CPU ≥ ${budgets.workerCpuPctWarn}% (hot thread)`);
  if (worstRss !== null && worstRss >= budgets.workerRssKbWarn) warn.push(`a worker RSS ${(worstRss / 1048576).toFixed(1)}GB ≥ ${(budgets.workerRssKbWarn / 1048576).toFixed(1)}GB`);
  if (s.gateway_8788_reachable === false) warn.push('inference gateway :8788 unreachable');
  if (warn.length) return { ...v, status: 'warn', reasons: warn };
  return { ...v, status: 'ok', reasons: [] };
}

export const PERF_BASELINES_DIR = join(homedir(), '.papercusp', 'perf-baselines');

/**
 * Read the most-recent perf-signals-v1 JSON capture (by mtime) from the perf-baselines
 * dir, or null when none / unreadable / wrong-schema. Fail-soft: a missing dir (no E1
 * cron on this box yet) returns null so the infra panel simply behaves as before.
 */
export async function readLatestPerfSignals(dir: string = PERF_BASELINES_DIR): Promise<PerfSignalsV1 | null> {
  let entries: string[];
  try { entries = await readdir(dir); } catch { return null; }
  const jsons = entries.filter((f) => f.endsWith('.json'));
  if (!jsons.length) return null;
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const f of jsons) {
    try {
      const st = await stat(join(dir, f));
      if (!newest || st.mtimeMs > newest.mtimeMs) newest = { path: join(dir, f), mtimeMs: st.mtimeMs };
    } catch { /* unreadable entry — skip */ }
  }
  if (!newest) return null;
  try {
    const parsed = JSON.parse(await readFile(newest.path, 'utf8')) as PerfSignalsV1;
    return parsed?.schemaVersion === 'perf-signals-v1' ? parsed : null;
  } catch { return null; }
}
