import { defineTool } from '@papercusp/agent-mcp';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { listTasks } from '../../../task-manager/store';
import { reconcileTick } from '../../../task-manager/reconcile-tick';
import { defaultForeignSignature } from '../../../task-manager/scan';
import { REPO_ROOT } from '../../../agent-tools/docs/_repo-paths';

/**
 * Admin task inventory — the read side of the Task Manager pane
 * (task-manager-no-escape-2026-07-27, P-017).
 *
 * Mirrors `/admin/schedules/inventory` exactly, including its posture: a
 * self-fetching client hits this, it shares the SAME store the `processes:list`
 * MCP tool reads, and it is READ-ONLY. Control verbs live on the MCP tools, which
 * are separately capability-gated (`processes:kill` / `processes:control`) — a
 * dashboard fetch must not be able to kill anything.
 *
 * `live=1` runs a dry-run reconcile so the pane can show kernel truth (unaccounted
 * groups, degraded scans) alongside the ledger. Still writes nothing.
 */
export default defineTool({
  method: 'GET',
  path: '/admin/tasks/inventory',
  auth: { trust: ['verified', 'trusted'] },
  async handler(req): Promise<Response> {
    const enabled = await getFlag(FLAGS.TASK_MANAGER, 'admin:task-manager').catch(() => true);
    if (!enabled) {
      return Response.json({ enabled: false, summary: { total: 0, byState: {}, byClass: {} }, rows: [], live: null });
    }

    const url = new URL(req.url);
    const state = url.searchParams.get('state');
    const cls = url.searchParams.get('class');
    const includeEnded = url.searchParams.get('includeEnded') === '1';
    const wantLive = url.searchParams.get('live') === '1';

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

    return Response.json({
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
    });
  },
});
