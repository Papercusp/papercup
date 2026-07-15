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
    /** Kernel Pressure Stall Information — %time tasks starved for the resource.
     *  Ratio-free, so it is the ONE host-saturation signal that does not lie on a
     *  128-core box (the 2026-07-10 fs-watch meltdown ran cpu some avg10=96). */
    psi?: {
      cpu?: { some?: { avg60?: number | null } | null } | null;
      io?: { some?: { avg60?: number | null } | null } | null;
      memory?: { some?: { avg60?: number | null } | null } | null;
    } | null;
    /** Per-uid inotify usage (2026-07-10 meltdown class: a silent watch balloon —
     *  94.5k watches/process × 16 workers — starved the host with no signal). */
    inotify?: {
      totalWatches?: number | null;
      totalInstances?: number | null;
      maxPerProcess?: { pid: number; comm: string; watches: number } | null;
      limits?: { maxUserWatches?: number | null } | null;
    } | null;
    /** Per-session dir populations (session-db-archive-retire-dirs P-007).
     *  After archive-at-death these are capped ≈ live-session count; a rebound
     *  means the exit-hook/reconciler stopped archiving — the population the
     *  2026-07-10 meltdown grew on. */
    sessionDirs?: {
      claudeOwnerDirs?: number | null;
      codexHomes?: number | null;
    } | null;
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
  /** A single process holding more fs watches than this is ballooning (warn — early
   *  per-offender attention). Grounded live 2026-07-10: healthy max ≈ 5k (biggest
   *  legit holder 4.9k); pre-GC session-dir bloat put an operator at 17.7k (real
   *  signal — dead-session dirs); the meltdown watcher held 94.5k per process.
   *  NOTE: the host-total tiers do NOT catch a per-proc melt (16×94.5k ≈ 38% of the
   *  kernel limit) — this warn + the PSI crit are the meltdown-class catchers. */
  inotifyPerProcWarn: number;
  /** Host-total watches as a FRACTION of fs.inotify.max_user_watches. Crit is
   *  reserved for approaching the hard kernel limit — past it every chokidar/
   *  fs.watch boot fails ENOSPC fleet-wide (the EI-3385 crash-loop class). */
  inotifyLimitWarnFrac: number;
  inotifyLimitCritFrac: number;
  /** PSI cpu `some avg60` (%time ≥1 task starved for CPU over the last minute).
   *  THE ratio-free host-saturation budget — loadavg-absolute lies here (128
   *  cores). Meltdown 2026-07-10: 94.8; healthy: <1. */
  psiCpuSomeWarn: number;
  psiCpuSomeCrit: number;
  /** Per-session dir population (either root) above this is a stalled
   *  archive-at-death lifecycle (warn — the reconciler/exit-hook stopped).
   *  Steady state post-backfill ≈ live sessions (~60) + churn; the pre-plan
   *  backlog was 17k+ (session-db-archive-retire-dirs P-007). */
  sessionDirsWarn: number;
  /** A capture older than this (ms) is STALE — don't threshold its numbers (avoid
   *  alarming on a briefly-old snapshot: the capture timer may have skipped a tick). */
  staleMs: number;
  /** A capture older than this (ms) means the producer has DIED, not skipped a tick —
   *  the host SLO monitor is BLIND. Surface as `warn` (never crit — the stale numbers
   *  are untrustworthy) instead of a silent `unknown`, so a dead capture timer
   *  (papercup-perf-signals-capture.timer, WI-324) is visible rather than failing open
   *  forever. MUST be >> staleMs + the capture cadence so a normal gap stays `unknown`. */
  blindMs: number;
}

/** Default per-thread budgets, grounded in the round-4 baseline + live evidence. */
export const PERF_BUDGETS: PerfBudgets = {
  workerCpuPctWarn: 200,
  workerRssKbWarn: 3_000_000,
  closeWaitWarn: 200,
  closeWaitCrit: 500,
  eventLoopLagP95WarnMs: 250,
  eventLoopLagP95CritMs: 1000,
  inotifyPerProcWarn: 10_000,
  inotifyLimitWarnFrac: 0.5,
  inotifyLimitCritFrac: 0.8,
  psiCpuSomeWarn: 40,
  psiCpuSomeCrit: 85,
  sessionDirsWarn: 2_000,
  staleMs: 10 * 60_000,
  blindMs: 30 * 60_000,
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
  /** Host-total inotify watches (per-uid) / the fattest single holder. */
  inotifyTotalWatches: number | null;
  inotifyMaxPerProc: { pid: number; comm: string; watches: number } | null;
  /** PSI cpu `some avg60` — %time ≥1 task starved for CPU. */
  psiCpuSome60: number | null;
  /** Per-session dir populations (archive-at-death lifecycle gauge). */
  sessionDirs: { claudeOwnerDirs: number | null; codexHomes: number | null } | null;
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
    eventLoopLagP95Ms: null, operatorReachable: null,
    inotifyTotalWatches: null, inotifyMaxPerProc: null, psiCpuSome60: null,
    sessionDirs: null,
    ageMs: null, stale: false,
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
  const inotifyTotal = typeof s.inotify?.totalWatches === 'number' ? s.inotify.totalWatches : null;
  const inotifyMax = s.inotify?.maxPerProcess ?? null;
  const inotifyLimit = typeof s.inotify?.limits?.maxUserWatches === 'number' ? s.inotify.limits.maxUserWatches : null;
  const psiCpu = typeof s.psi?.cpu?.some?.avg60 === 'number' ? s.psi.cpu.some.avg60 : null;
  const sessionDirs = s.sessionDirs
    ? {
        claudeOwnerDirs: typeof s.sessionDirs.claudeOwnerDirs === 'number' ? s.sessionDirs.claudeOwnerDirs : null,
        codexHomes: typeof s.sessionDirs.codexHomes === 'number' ? s.sessionDirs.codexHomes : null,
      }
    : null;
  const v: PerfVerdict = {
    ...base,
    hostState: signals.hostState ?? null,
    worstWorkerCpuPct: worstCpu, worstWorkerRssKb: worstRss, closeWait,
    eventLoopLagP95Ms: lag, operatorReachable: reachable,
    inotifyTotalWatches: inotifyTotal, inotifyMaxPerProc: inotifyMax, psiCpuSome60: psiCpu,
    sessionDirs,
    ageMs,
    stale: ageMs !== null && ageMs > budgets.staleMs,
  };
  if (v.stale) {
    // Present-but-stale: distinguish a brief gap (skipped a tick → `unknown`: numbers
    // untrustworthy but not alarming) from a DEAD producer (age past blindMs → the host
    // SLO monitor is blind → `warn`, so a stopped capture timer is visible instead of
    // failing open forever). Never crit — stale numbers must not red the system (the
    // original fail-safe). WI-324 recurrence guard.
    if (ageMs !== null && ageMs > budgets.blindMs) {
      const mins = Math.round(ageMs / 60_000);
      return {
        ...v,
        status: 'warn',
        reasons: [
          `perf-signals capture ${mins}min stale (> ${Math.round(budgets.blindMs / 60_000)}min) — host SLO monitor blind; check papercup-perf-signals-capture.timer`,
        ],
      };
    }
    return { ...v, status: 'unknown' };
  }

  // ── CRIT: definitive per-thread wedge (NOT loadavg — see the file header) ──────
  const crit: string[] = [];
  if (reachable === false) crit.push('operator :3070 unreachable');
  if (signals.hostState === 'wedge-active') crit.push('hostState=wedge-active (live wedge captured)');
  if (lag !== null && lag >= budgets.eventLoopLagP95CritMs) crit.push(`event-loop lag p95 ${lag}ms ≥ ${budgets.eventLoopLagP95CritMs}ms`);
  if (closeWait !== null && closeWait >= budgets.closeWaitCrit) crit.push(`:3070 CLOSE_WAIT ${closeWait} ≥ ${budgets.closeWaitCrit} (event-loop peg)`);
  if (inotifyTotal !== null && inotifyLimit !== null && inotifyTotal >= inotifyLimit * budgets.inotifyLimitCritFrac) {
    crit.push(`inotify watches ${inotifyTotal} ≥ ${Math.round(budgets.inotifyLimitCritFrac * 100)}% of max_user_watches ${inotifyLimit} — ENOSPC imminent, fs.watch boots will fail fleet-wide`);
  }
  if (psiCpu !== null && psiCpu >= budgets.psiCpuSomeCrit) crit.push(`PSI cpu some avg60 ${psiCpu} ≥ ${budgets.psiCpuSomeCrit} — tasks starved for CPU (host saturation)`);
  if (crit.length) return { ...v, status: 'crit', degraded: true, reasons: crit };

  // ── WARN: hot-but-not-fatal ────────────────────────────────────────────────────
  const warn: string[] = [];
  if (lag !== null && lag >= budgets.eventLoopLagP95WarnMs) warn.push(`event-loop lag p95 ${lag}ms ≥ ${budgets.eventLoopLagP95WarnMs}ms`);
  if (closeWait !== null && closeWait >= budgets.closeWaitWarn) warn.push(`:3070 CLOSE_WAIT ${closeWait} ≥ ${budgets.closeWaitWarn}`);
  if (worstCpu !== null && worstCpu >= budgets.workerCpuPctWarn) warn.push(`a worker at ${Math.round(worstCpu)}% CPU ≥ ${budgets.workerCpuPctWarn}% (hot thread)`);
  if (worstRss !== null && worstRss >= budgets.workerRssKbWarn) warn.push(`a worker RSS ${(worstRss / 1048576).toFixed(1)}GB ≥ ${(budgets.workerRssKbWarn / 1048576).toFixed(1)}GB`);
  if (inotifyMax && inotifyMax.watches >= budgets.inotifyPerProcWarn) {
    warn.push(`${inotifyMax.comm} (pid ${inotifyMax.pid}) holds ${inotifyMax.watches} fs watches ≥ ${budgets.inotifyPerProcWarn} — watch balloon (2026-07-10 meltdown class: find the recursive/unbounded watcher)`);
  }
  if (inotifyTotal !== null && inotifyLimit !== null && inotifyTotal >= inotifyLimit * budgets.inotifyLimitWarnFrac) {
    warn.push(`inotify watches ${inotifyTotal} ≥ ${Math.round(budgets.inotifyLimitWarnFrac * 100)}% of max_user_watches ${inotifyLimit}`);
  }
  if (psiCpu !== null && psiCpu >= budgets.psiCpuSomeWarn) warn.push(`PSI cpu some avg60 ${psiCpu} ≥ ${budgets.psiCpuSomeWarn} — sustained CPU starvation pressure`);
  for (const [label, n] of [
    ['session-claude owner dirs', sessionDirs?.claudeOwnerDirs],
    ['codex per-session homes', sessionDirs?.codexHomes],
  ] as const) {
    if (typeof n === 'number' && n >= budgets.sessionDirsWarn) {
      warn.push(
        `${n} ${label} ≥ ${budgets.sessionDirsWarn} — archive-at-death lifecycle stalled (check the session-archive exit hook + hourly reconciler; session-db-archive-retire-dirs P-007)`,
      );
    }
  }
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
