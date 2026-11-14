/**
 * Host-only foreground liveness reader.
 *
 * Keep this module out of testing-core.worker's import graph: task-manager/store
 * imports terminal-event handling, which reaches the host DBOS workflow graph.
 * Worker-safe testing-run-store callers inject this reader only on host status
 * surfaces that need an independent process-liveness verdict.
 */

import { REPO_ROOT } from './agent-tools/docs/_repo-paths';
import { classifyForegroundKernelEvidence, type ForegroundKernelVerdict } from './testing-run-store';
import { reconcileTick } from './task-manager/reconcile-tick';
import { defaultForeignSignature } from './task-manager/scan';
import { listTasks } from './task-manager/store';

/** Read fresh kernel truth for just this task through the shared dry-run reconciler. */
export async function readForegroundKernelVerdict(
  taskId: string,
  workspaceId: string,
): Promise<ForegroundKernelVerdict> {
  let currentTaskState: string | null | undefined;
  const tick = await reconcileTick({
    dryRun: true,
    workspaceId,
    listLive: async (targetWorkspaceId) => {
      const rows = await listTasks({
        workspaceId: targetWorkspaceId ?? workspaceId,
        taskId,
        includeEnded: true,
        limit: 2,
      });
      currentTaskState = rows.length === 1 ? rows[0]!.state : null;
      return rows;
    },
    scanOptions: { foreignSignature: defaultForeignSignature(REPO_ROOT) },
  });

  // Degraded, ambiguous, or unclassified evidence stays unknown. In particular,
  // absence from an incomplete scan must never turn a stored running row into LOST.
  const alive = tick.result.alive.filter((row) => row.taskId === taskId).length;
  const stranded = tick.result.stranded.filter((row) => row.taskId === taskId).length;
  const endedUnobserved = tick.result.endedUnobserved.filter((row) => row.taskId === taskId).length;
  return classifyForegroundKernelEvidence({
    degraded: tick.degraded,
    taskState: currentTaskState,
    aliveCount: alive,
    strandedCount: stranded,
    endedUnobservedCount: endedUnobserved,
    unresolved: tick.result.unresolved.some((row) => row.taskId === taskId),
    tooYoung: tick.result.tooYoung.includes(taskId),
  });
}
