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
};

export type TaskInventory = {
  enabled: boolean;
  summary: { total: number; byState: Record<string, number>; byClass: Record<string, number> };
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
  live?: boolean;
};

/** The disabled-flag payload. Shared so both callers render the same empty state. */
export function disabledInventory(): TaskInventory {
  return { enabled: false, summary: { total: 0, byState: {}, byClass: {} }, rows: [], live: null, liveProcesses: [] };
}

/** Cap on live-process rows shipped to the pane. Well above the ~400 this box runs. */
const MAX_LIVE_PROCESS_ROWS = 800;

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
    // Never let a scan fault take the PANE down — a task manager that goes blank
    // exactly when the box is unhealthy is worse than one that renders the ledger
    // with a "live view unavailable" note.
    try {
      const tick = await reconcileTick({
        dryRun: true,
        scanOptions: { foreignSignature: defaultForeignSignature(REPO_ROOT) },
      });
      live = {
        ...tick.summary,
        degraded: tick.degraded,
        degradedReason: tick.degradedReason,
        scan: tick.scan,
        unaccounted: tick.result.unaccounted.map((g) => ({
          cgroupPath: g.cgroupPath,
          pids: g.pids,
          sample: g.sampleCmdline.slice(0, 200),
        })),
      };
      // Owned first (enrolled lineage), then the signature-matched strangers; within
      // each, by pid so the order is stable across the 5s refresh and rows do not
      // jump under the reader's cursor.
      liveProcesses = tick.scannedProcesses
        .slice()
        .sort((a, b) => Number(b.owned) - Number(a.owned) || a.pid - b.pid)
        .slice(0, MAX_LIVE_PROCESS_ROWS)
        .map((p) => ({
          pid: p.pid,
          cmdline: p.cmdline ? p.cmdline.slice(0, 300) : null,
          cgroupPath: p.cgroupPath,
          owned: p.owned,
        }));
    } catch (e) {
      live = { error: (e as Error).message.slice(0, 300) };
    }
  }

  return {
    enabled: true,
    summary: { total: rows.length, byState, byClass },
    live,
    liveProcesses,
    // `?? null` on every nullable field is load-bearing, not defensive noise: the
    // store types these as `T | null | undefined`, and `JSON.stringify` DROPS an
    // undefined-valued key entirely. Left alone, a task with no work-item would ship
    // a row with no `workItemId` key at all rather than an explicit null, so the
    // client could not distinguish "not attributed" from "field missing" — and the
    // sync layer's row-delta negotiation diffs on key presence. Normalising here is
    // what makes the wire shape total.
    rows: rows.map((r) => ({
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
    })),
  };
}
