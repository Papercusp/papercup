/**
 * The task-inventory read model — ONE implementation, two callers.
 *
 * (task-manager-no-escape-2026-07-27, WI-6475.)
 *
 * The pane originally lived only behind `GET /api/admin/tasks/inventory`, which the
 * client polled with a bare `fetch`. That 403'd in the desktop webview: a native
 * webview fetch does not ride the sys:http IPC bridge that injects the loopback-
 * superuser bearer, so it resolves `unverified-loopback` and a VT-gated admin route
 * refuses it (the mechanism is written up verbatim in
 * `endpoint-route/__tests__/auth-posture.test.ts`, EI-338). The pane now reads
 * through the sync layer like every sibling rail tab, whose transport
 * (`/zero-harness/rest-query`) is `auth:'loopback'` and is therefore admitted.
 *
 * The HTTP route is kept — it is a legitimate non-UI surface (curl, external probes,
 * the `/admin/tasks` page's own contract) — so this module exists to guarantee the
 * two callers can never drift into reporting different numbers for the same box.
 */
import { listTasks } from './store';
import { reconcileTick } from './reconcile-tick';
import { defaultForeignSignature } from './scan';
import type { ExemptReason, ProcessScope } from './scope-class';
import { REPO_ROOT } from '../agent-tools/docs/_repo-paths';

export type TaskInventoryRow = {
  taskId: string;
  parentTaskId: string | null;
  rootTaskId: string;
  class: string;
  title: string;
  state: string;
  launchedBy: string;
  workItemId: string | null;
  planSlug: string | null;
  startedAt: string;
  endedAt: string | null;
  confined: boolean;
  scopeUnit: string | null;
  rssBytes: number | null;
  peakRssBytes: number | null;
  cpuUsec: number | null;
  pids: number | null;
  memoryMaxBytes: number | null;
  deadlineAt: string | null;
  exitCode: number | null;
  exitReason: string | null;
  logPath: string | null;
};

/**
 * A process the kernel scan SAW but the ledger does not own.
 *
 * Owner-reported (WI-6475): "the task manager is showing no tasks, obviously we have
 * running tasks". Both facts were true at once, and that is the bug. Only three seams
 * enrol (orchestrator agent turns, backgrounded bash jobs, headless fleet members),
 * each of them SHORT-LIVED, so at any given instant almost nothing enrolled is
 * mid-flight — while ~400 real processes run on the box. The pane rendered an empty
 * table next to its own line reading "400 process(es) scanned", which is not a
 * subtle failure: it reads as broken.
 *
 * The scan already collects pid + cmdline + cgroup for every one of these. Showing
 * them costs nothing and makes the pane answer the question its own tooltip promises
 * ("every process running right now") instead of "what our three seams enrolled in
 * the last minute".
 */
export type LiveProcessRow = {
  pid: number;
  cmdline: string | null;
  cgroupPath: string;
  /** true = inside our slice (enrolled lineage); false = signature-matched, unenrolled. */
  owned: boolean;
  /**
   * `owned:false` split into the two populations a reader must not confuse:
   * `exempt` (a lifetime we deliberately do not own — the owner's terminal, a
   * systemd unit) and `unaccounted` (a genuine escape). Rendering both as one
   * "UNENROLLED" group is the defect this field exists to fix — it presented ~98%
   * of the box as a coverage hole (EI-19325095302441792).
   */
  scope: ProcessScope;
  /** Non-null exactly when `scope === 'exempt'` — the reason to show the reader. */
  exemptReason: ExemptReason | null;
};

/**
 * Fleet-wide resource totals, folded over the SAME row set as `total`/`byState`.
 *
 * WHY THIS IS COMPUTED HERE AND NOT IN THE VIEW (WI-7371): the panes filter by
 * state/class, so their `rows` is a PROJECTION. A `rows.reduce()` in a component
 * would total only what is currently visible while presenting itself as a system
 * total — a number that answers a narrower question than its label claims. Folding
 * it next to `byState` also means the header pill and the panel it opens read one
 * field and cannot disagree, which is the WI-6844 bug this file already carries a
 * warning about.
 *
 * ⚠ `rssBytes` is a GAUGE (sum is meaningful) but double-counts pages SHARED between
 * processes — a naive RSS sum over postgres backends on this box reads ~403 GB on a
 * 257 GB machine. Present it as an upper bound, never as "memory in use".
 *
 * ⚠ `cpuUsec` is a MONOTONIC CUMULATIVE counter (cgroup `cpu.stat usage_usec`), so
 * its sum is lifetime CPU-time, NOT "cpu usage". A usage RATE needs two samples;
 * `sampledAtMs` is emitted for exactly that, and `cpuBusyPercent()` derives it.
 * Labelling the raw sum "usage" would be wrong.
 */
export type TaskResourceTotals = {
  /** Σ rssBytes over rows that reported one. Upper bound — shared pages double-count. */
  rssBytesTotal: number;
  /** Σ cpuUsec — CUMULATIVE cpu-microseconds, not a rate. */
  cpuUsecTotal: number;
  /** When this fold was taken; the other half of a rate calculation. */
  sampledAtMs: number;
  /** How many rows actually reported each metric — the rest are `null`. */
  rssBytesKnown: number;
  cpuUsecKnown: number;
  /** Row count the fold ran over, so a view can say "M of N reported". */
  rowsConsidered: number;
};

export type TaskInventory = {
  enabled: boolean;
  summary: {
    total: number;
    byState: Record<string, number>;
    byClass: Record<string, number>;
    resources: TaskResourceTotals;
  };
  live: unknown;
  rows: TaskInventoryRow[];
  /**
   * What is ACTUALLY running, independent of the ledger. Populated only when the
   * caller asks for the live view (it comes from the same dry-run scan). Capped so a
   * busy box cannot ship an unbounded payload to a sidebar pane.
   */
  liveProcesses: LiveProcessRow[];
};

export type TaskInventoryOptions = {
  state?: string | null;
  cls?: string | null;
  includeEnded?: boolean;
  /**
   * With `live`, run the scan but ship NO per-process rows — the totals in `live`
   * only. For the header pill, which must state a true count of running processes
   * without carrying the process table onto every tab.
   */
  countsOnly?: boolean;
  live?: boolean;
};

/** Zeroed totals for the disabled/empty payload. `sampledAtMs: 0` marks "never sampled". */
export function emptyResourceTotals(): TaskResourceTotals {
  return {
    rssBytesTotal: 0,
    cpuUsecTotal: 0,
    sampledAtMs: 0,
    rssBytesKnown: 0,
    cpuUsecKnown: 0,
    rowsConsidered: 0,
  };
}

/**
 * Fold resource totals over rows. PURE — no clock, no I/O — so the aggregation is
 * unit-testable and `nowMs` is injected rather than read.
 *
 * Nulls are SKIPPED, not coerced to 0, and counted separately: `rssBytes`/`cpuUsec`
 * are `number | null`, and treating "did not report" as zero would silently understate
 * the total while looking like a complete answer.
 */
export function foldResourceTotals(
  rows: ReadonlyArray<Pick<TaskInventoryRow, 'rssBytes' | 'cpuUsec'>>,
  nowMs: number,
): TaskResourceTotals {
  const out = { ...emptyResourceTotals(), sampledAtMs: nowMs, rowsConsidered: rows.length };
  for (const r of rows) {
    if (typeof r.rssBytes === 'number' && Number.isFinite(r.rssBytes)) {
      out.rssBytesTotal += r.rssBytes;
      out.rssBytesKnown += 1;
    }
    if (typeof r.cpuUsec === 'number' && Number.isFinite(r.cpuUsec)) {
      out.cpuUsecTotal += r.cpuUsec;
      out.cpuUsecKnown += 1;
    }
  }
  return out;
}

/**
 * Derive CPU BUSY PERCENT from two cumulative samples — the only honest way to turn
 * `cpuUsecTotal` into a "usage" figure. 100% = one core saturated; a 16-core box can
 * legitimately read 1600%.
 *
 * Returns `null` (never 0) when it cannot be computed: no previous sample, a
 * non-advancing or backwards clock, or a counter that went BACKWARDS — which happens
 * legitimately whenever a task ends and leaves the row set, so it must not render as
 * "0% busy". Zero and unknown are different answers and this codebase has been burned
 * repeatedly by conflating them.
 */
export function cpuBusyPercent(
  prev: Pick<TaskResourceTotals, 'cpuUsecTotal' | 'sampledAtMs'> | null | undefined,
  next: Pick<TaskResourceTotals, 'cpuUsecTotal' | 'sampledAtMs'>,
): number | null {
  if (!prev || !prev.sampledAtMs || !next.sampledAtMs) return null;
  const wallUsec = (next.sampledAtMs - prev.sampledAtMs) * 1000;
  if (wallUsec <= 0) return null;
  const deltaCpu = next.cpuUsecTotal - prev.cpuUsecTotal;
  if (deltaCpu < 0) return null;
  return (deltaCpu / wallUsec) * 100;
}

/** The disabled-flag payload. Shared so both callers render the same empty state. */
export function disabledInventory(): TaskInventory {
  return {
    enabled: false,
    summary: { total: 0, byState: {}, byClass: {}, resources: emptyResourceTotals() },
    rows: [],
    live: null,
    liveProcesses: [],
  };
}

/** Cap on live-process rows shipped to the pane. */
const MAX_LIVE_PROCESS_ROWS = 4000;

/**
 * Row priority under the cap: ours, then real escapes, then dead-window residue,
 * then exempt lifetimes.
 *
 * `abandoned-window` outranks `exempt` because it is residue a human should see,
 * and ranks below `unaccounted` because it is not a chokepoint bypass — a human
 * did legitimately own it, right up until they closed the window (D-018).
 */
function scopeRank(scope: ProcessScope): number {
  if (scope === 'owned') return 0;
  if (scope === 'unaccounted') return 1;
  return scope === 'abandoned-window' ? 2 : 3;
}

/**
 * SHARED TTL memo for the live scan (owner-directed 2026-08-02).
 *
 * The scan is a cgroup-tree walk, so it used to be affordable only for a pane you
 * had deliberately opened. That constraint is what made the header pill report the
 * LEDGER count — "3 tasks" on a box running 131 agents, which the owner correctly
 * called impossible. The pill is mounted on every tab, so it could not have paid
 * for a scan per render.
 *
 * Memoising the scan removes that trade-off: the pill, the open panel and the
 * /admin/tasks page now share ONE walk per TTL no matter how many readers there
 * are, so the pill can afford to show the true number instead of a cheap wrong one.
 *
 * In-flight calls share the SAME promise, not just the settled value — otherwise N
 * simultaneous mounts on a fresh cache each start their own walk, which is exactly
 * the stampede the memo exists to prevent.
 */
const LIVE_SCAN_TTL_MS = 5_000;
let liveScanMemo: { at: number; promise: Promise<LiveScanResult> } | null = null;

type LiveScanResult = { live: unknown; liveProcesses: LiveProcessRow[] };

/** Test seam — drop the memo so a test never reads another test's scan. */
export function resetLiveScanMemoForTest(): void {
  liveScanMemo = null;
}

function scanLive(now: number): Promise<LiveScanResult> {
  if (liveScanMemo && now - liveScanMemo.at < LIVE_SCAN_TTL_MS) return liveScanMemo.promise;
  const promise = runLiveScan();
  liveScanMemo = { at: now, promise };
  // A rejected scan must not be cached as the answer for the whole TTL — but
  // runLiveScan already converts a fault into a `{ error }` payload rather than
  // throwing, so this only guards a genuinely unexpected throw.
  void promise.catch(() => { liveScanMemo = null; });
  return promise;
}

async function runLiveScan(): Promise<LiveScanResult> {
  // Never let a scan fault take the PANE down — a task manager that goes blank
  // exactly when the box is unhealthy is worse than one that renders the ledger
  // with a "live view unavailable" note.
  try {
    const tick = await reconcileTick({
      dryRun: true,
      scanOptions: { foreignSignature: defaultForeignSignature(REPO_ROOT) },
    });
    return {
      live: {
        ...tick.summary,
        degraded: tick.degraded,
        degradedReason: tick.degradedReason,
        scan: tick.scan,
        unaccounted: tick.result.unaccounted.map((g) => ({
          cgroupPath: g.cgroupPath,
          pids: g.pids,
          sample: g.sampleCmdline.slice(0, 200),
        })),
      },
      // Owned first (enrolled lineage), then the genuine escapes, then the
      // deliberately-exempt lifetimes; within each, by pid so the order is stable
      // across the 5s refresh and rows do not jump under the reader's cursor.
      //
      // Ranking `unaccounted` ABOVE `exempt` is what makes the cap safe rather than
      // lucky: exempt rows are the large population (157 terminal processes on this
      // box, against ~13 real escapes), so a pid-ordered cut could drop precisely
      // the rows that carry the alarm and leave the pane reporting a clean gap it
      // simply could not see. The cap is not biting today at 4000 — this keeps the
      // property true if it ever does (EI-19325095302441792).
      liveProcesses: tick.scannedProcesses
        .slice()
        .sort((a, b) => scopeRank(a.scope) - scopeRank(b.scope) || a.pid - b.pid)
        .slice(0, MAX_LIVE_PROCESS_ROWS)
        .map((p) => ({
          pid: p.pid,
          cmdline: p.cmdline ? p.cmdline.slice(0, 300) : null,
          cgroupPath: p.cgroupPath,
          owned: p.owned,
          scope: p.scope,
          exemptReason: p.exemptReason,
        })),
    };
  } catch (e) {
    return { live: { error: (e as Error).message.slice(0, 300) }, liveProcesses: [] };
  }
}

export async function getTaskInventory(opts: TaskInventoryOptions = {}): Promise<TaskInventory> {
  const { state, cls, includeEnded = false, live: wantLive = false } = opts;

  const rows = await listTasks({
    states: state ? [state as never] : undefined,
    classes: cls ? [cls] : undefined,
    includeEnded,
    limit: 500,
  });

  const byState: Record<string, number> = {};
  const byClass: Record<string, number> = {};
  for (const r of rows) {
    byState[r.state] = (byState[r.state] ?? 0) + 1;
    byClass[r.class] = (byClass[r.class] ?? 0) + 1;
  }

  let live: unknown = null;
  let liveProcesses: LiveProcessRow[] = [];
  if (wantLive) {
    const scanned = await scanLive(Date.now());
    live = scanned.live;
    // `countsOnly` is the HEADER PILL's arm: it needs the live TOTALS to state a
    // true process count, but shipping 4000 cmdlines to a control that renders one
    // short string would put the whole process table behind every tab of the app.
    // Same memoised scan either way — this drops only the payload.
    liveProcesses = opts.countsOnly ? [] : scanned.liveProcesses;
  }

  // `?? null` on every nullable field is load-bearing, not defensive noise: the
  // store types these as `T | null | undefined`, and `JSON.stringify` DROPS an
  // undefined-valued key entirely. Left alone, a task with no work-item would ship
  // a row with no `workItemId` key at all rather than an explicit null, so the
  // client could not distinguish "not attributed" from "field missing" — and the
  // sync layer's row-delta negotiation diffs on key presence. Normalising here is
  // what makes the wire shape total.
  //
  // WI-7371: hoisted out of the return so the resource fold runs over the MAPPED rows.
  // The raw store row names these `lastMemoryBytes` / `cpuUsec`; folding the raw rows
  // reads `rssBytes: undefined` on every one and yields a silent `0` total that looks
  // exactly like "nothing reported". Folding the shipped shape makes the totals and the
  // rows structurally incapable of describing different data.
  const mappedRows: TaskInventoryRow[] = rows.map((r) => ({
      taskId: r.taskId,
      parentTaskId: r.parentTaskId ?? null,
      rootTaskId: r.rootTaskId,
      class: r.class,
      title: r.title,
      state: r.state,
      launchedBy: r.launchedBy,
      workItemId: r.workItemId ?? null,
      planSlug: r.planSlug ?? null,
      startedAt: r.startedAt,
      endedAt: r.endedAt ?? null,
      confined: r.confined,
      scopeUnit: r.scopeUnit ?? null,
      rssBytes: r.lastMemoryBytes ?? null,
      peakRssBytes: r.peakMemoryBytes ?? null,
      cpuUsec: r.cpuUsec ?? null,
      pids: r.pidsCurrent ?? null,
      memoryMaxBytes: r.memoryMaxBytes ?? null,
      deadlineAt: r.deadlineAt ?? null,
      exitCode: r.exitCode ?? null,
      exitReason: r.exitReason ?? null,
      logPath: r.logPath ?? null,
    }));

  return {
    enabled: true,
    summary: {
      total: rows.length,
      byState,
      byClass,
      resources: foldResourceTotals(mappedRows, Date.now()),
    },
    live,
    liveProcesses,
    rows: mappedRows,
  };
}
