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

export type TaskInventory = {
  enabled: boolean;
  summary: { total: number; byState: Record<string, number>; byClass: Record<string, number> };
  live: unknown;
  rows: TaskInventoryRow[];
};

export type TaskInventoryOptions = {
  state?: string | null;
  cls?: string | null;
  includeEnded?: boolean;
  live?: boolean;
};

/** The disabled-flag payload. Shared so both callers render the same empty state. */
export function disabledInventory(): TaskInventory {
  return { enabled: false, summary: { total: 0, byState: {}, byClass: {} }, rows: [], live: null };
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
    } catch (e) {
      live = { error: (e as Error).message.slice(0, 300) };
    }
  }

  return {
    enabled: true,
    summary: { total: rows.length, byState, byClass },
    live,
    rows: rows.map((r) => ({
      taskId: r.taskId,
      parentTaskId: r.parentTaskId,
      rootTaskId: r.rootTaskId,
      class: r.class,
      title: r.title,
      state: r.state,
      launchedBy: r.launchedBy,
      workItemId: r.workItemId,
      planSlug: r.planSlug,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      confined: r.confined,
      scopeUnit: r.scopeUnit,
      rssBytes: r.lastMemoryBytes,
      peakRssBytes: r.peakMemoryBytes,
      cpuUsec: r.cpuUsec,
      pids: r.pidsCurrent,
      memoryMaxBytes: r.memoryMaxBytes,
      deadlineAt: r.deadlineAt,
      exitCode: r.exitCode,
      exitReason: r.exitReason,
      logPath: r.logPath,
    })),
  };
}
