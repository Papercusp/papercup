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

// The PURE, dependency-free slice of this model lives in the CLIENT-SAFE `./inventory-shared`
// (WI-8191). A `'use client'` hook value-importing `cpuBusyPercent` from HERE dragged this
// module's server graph (store / reconcile-tick / scan / _repo-paths, and their node: builtins)
// into the SPA's browser-eager bundle, where it throws at module-init and white-screens the
// route. Everything below is re-exported so server callers — and this module's own tests —
// import from either path and still get ONE definition.
//
// ⚠ Adding a new pure type or constant here that a client needs? Put it in `./inventory-shared`
// instead. Re-exporting is safe (a client importing THIS file still pulls the server graph);
// what matters is that the CLIENT's import specifier points at the shared file.
import {
  emptyResourceTotals,
  foldResourceTotals,
  RESOURCE_TOTALS_FILTER,
  RESOURCE_TOTALS_LIMIT,
  type TaskInventoryRow,
  type TaskResourceTotals,
} from './inventory-shared';

export {
  cpuBusyPercent,
  emptyResourceTotals,
  foldResourceTotals,
  RESOURCE_TOTALS_FILTER,
  RESOURCE_TOTALS_LIMIT,
} from './inventory-shared';
export type { TaskInventoryRow, TaskResourceTotals } from './inventory-shared';

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

/** Just enough of a store row to fold; keeps the seam below narrow and injectable. */
type ResourceSourceRow = { lastMemoryBytes?: number | null; cpuUsec?: number | null };
type ResourceLister = (filter: typeof RESOURCE_TOTALS_FILTER) => Promise<ResourceSourceRow[]>;

/**
 * Fetch the live tracked set and fold it — the ONE path that produces `summary.resources`.
 *
 * `lister` is injected so the filter-independence claim is testable without a database:
 * a fake lister records the filter it was handed, and the guard test asserts no caller
 * filter ever reaches it.
 *
 * ⚠ The mapping `lastMemoryBytes -> rssBytes` is load-bearing. The store row names the
 * field differently from the wire row, so folding a store row through the wire row's
 * `Pick<..., 'rssBytes'>` shape reads `undefined` on every row and yields a confident `0`
 * total that is indistinguishable from "nothing reported".
 */
export async function computeResourceTotals(
  nowMs: number,
  lister: ResourceLister = listTasks as unknown as ResourceLister,
): Promise<TaskResourceTotals> {
  const rows = await lister(RESOURCE_TOTALS_FILTER);
  const folded = foldResourceTotals(
    rows.map((r) => ({ rssBytes: r.lastMemoryBytes ?? null, cpuUsec: r.cpuUsec ?? null })),
    nowMs,
  );
  return { ...folded, truncated: rows.length >= RESOURCE_TOTALS_LIMIT };
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

  // WI-7371: the totals run over their OWN unfiltered fetch, NOT `mappedRows`. `rows`
  // above already has the caller's state/class/includeEnded applied, so folding it would
  // put the pane's filter inside a figure labelled as a system total — the same defect as
  // a client-side `rows.reduce()`, just relocated to the server where it reads as
  // authoritative. See RESOURCE_TOTALS_FILTER and its guard test.
  const resources = await computeResourceTotals(Date.now());

  return {
    enabled: true,
    summary: {
      total: rows.length,
      byState,
      byClass,
      resources,
    },
    live,
    liveProcesses,
    rows: mappedRows,
  };
}
