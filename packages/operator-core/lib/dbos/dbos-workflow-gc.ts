/**
 * dbos-workflow-gc — prune old TERMINAL DBOS system rows
 * (infra-self-healing-supervision-2026-06-19, R4-5; EI-1607 defense-in-depth).
 *
 * `dbos.workflow_status` grew to 325k+ rows (operation_outputs 484k) with NO retention —
 * every completed workflow accrues forever, bloating the system DB and slowing the
 * scheduler/recovery scans that walk it (a contributor to routinesTick latency). DBOS
 * 4.18 ships no built-in GC, so this mirrors the codebase's existing hand-rolled GC
 * workflows (coordNotifyGc, outboxBackstopGc): delete workflows in a TERMINAL status
 * older than a generous retention window, plus their operation_outputs.
 *
 * SAFETY: only the terminal statuses are ever matched — PENDING / ENQUEUED (in-flight)
 * rows are NEVER touched, so DBOS recovery (which resumes only non-terminal workflows)
 * is unaffected. operation_outputs are deleted FIRST (FK order). Batched (LIMIT) to
 * bound the transaction/lock. DEFAULT-OFF (arm with PAPERCUSP_DBOS_WORKFLOW_GC=1): a
 * DELETE on DBOS's own system tables is opt-in until validated; retention is env-tunable
 * (PAPERCUSP_DBOS_WORKFLOW_GC_DAYS, default 14).
 *
 * NOTE on the EI-1607 "bounded catch-up (run-latest-only)" half: DBOS scheduled workflows
 * already register `skip-missed` (periodic-workflows.ts header: "default skip-missed mode,
 * D-009 — no backfill storm after a long-closed desktop"), so the missed-cron storm is
 * already bounded at the scheduler. This GC addresses the remaining half — the unbounded
 * ACCUMULATION of terminal rows. The live routinesTick freeze was separately root-caused
 * to bg-host loop saturation (not the catch-up), so this is hygiene/defense-in-depth.
 */
import { getOrgPg } from '@papercusp/db-org';

export const DBOS_TERMINAL_STATUSES = [
  'SUCCESS',
  'ERROR',
  'MAX_RECOVERY_ATTEMPTS_EXCEEDED',
  'CANCELLED',
] as const;

const DEFAULT_RETENTION_DAYS = 2; // keep ~2d of terminal history — small enough that a daily GC holds workflow_status far under the ~300k freeze threshold (re-bloat prevention; owner durable-stability directive 2026-06-19). Tune via PAPERCUSP_DBOS_WORKFLOW_GC_DAYS.
const DEFAULT_BATCH_LIMIT = 5000;
const MAX_BATCHES = 2000; // hard backstop: ≤ 2000 × 5000 = 10M rows/run

export function dbosWorkflowGcEnabled(): boolean {
  return process.env.PAPERCUSP_DBOS_WORKFLOW_GC === '1';
}

export function dbosWorkflowGcRetentionDays(): number {
  const d = Number(process.env.PAPERCUSP_DBOS_WORKFLOW_GC_DAYS);
  return Number.isFinite(d) && d > 0 ? d : DEFAULT_RETENTION_DAYS;
}

/** Injectable query seams (sql-backed in production; faked in tests). */
export interface DbosGcDeps {
  /** Terminal workflow_uuids with updated_at < cutoff, up to `limit`. */
  selectTerminalVictims: (cutoffMs: number, limit: number) => Promise<string[]>;
  /** Delete operation_outputs for these workflow_uuids; returns rows deleted. */
  deleteOutputs: (ids: string[]) => Promise<number>;
  /** Delete workflow_status for these workflow_uuids; returns rows deleted. */
  deleteWorkflows: (ids: string[]) => Promise<number>;
}

export interface DbosWorkflowGcResult {
  skipped: boolean;
  deletedWorkflows: number;
  deletedOutputs: number;
  cutoffMs: number | null;
  batches: number;
}

type SqlLike = <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;

/** Build the production sql-backed query seams. */
function sqlDeps(sql: SqlLike): DbosGcDeps {
  const statuses = [...DBOS_TERMINAL_STATUSES];
  return {
    selectTerminalVictims: async (cutoffMs, limit) => {
      const rows = await sql<Array<{ workflow_uuid: string }>>`
        SELECT workflow_uuid FROM dbos.workflow_status
         WHERE status = ANY(${statuses})
           AND updated_at < ${cutoffMs}
         LIMIT ${limit}`;
      return rows.map((r) => r.workflow_uuid);
    },
    deleteOutputs: async (ids) => {
      if (ids.length === 0) return 0;
      const rows = await sql<Array<{ n: number }>>`
        WITH d AS (DELETE FROM dbos.operation_outputs WHERE workflow_uuid = ANY(${ids}) RETURNING 1)
        SELECT count(*)::int AS n FROM d`;
      return rows[0]?.n ?? 0;
    },
    deleteWorkflows: async (ids) => {
      if (ids.length === 0) return 0;
      const rows = await sql<Array<{ n: number }>>`
        WITH d AS (DELETE FROM dbos.workflow_status WHERE workflow_uuid = ANY(${ids}) RETURNING 1)
        SELECT count(*)::int AS n FROM d`;
      return rows[0]?.n ?? 0;
    },
  };
}

/**
 * Prune old terminal DBOS rows. No-op (skipped) unless armed. Batched to bound the
 * lock; deletes operation_outputs before workflow_status; never matches in-flight rows.
 */
export async function runDbosWorkflowGcOnce(
  opts: {
    enabled?: boolean;
    retentionDays?: number;
    batchLimit?: number;
    nowMs?: number;
    deps?: DbosGcDeps;
  } = {},
): Promise<DbosWorkflowGcResult> {
  const enabled = opts.enabled ?? dbosWorkflowGcEnabled();
  if (!enabled) return { skipped: true, deletedWorkflows: 0, deletedOutputs: 0, cutoffMs: null, batches: 0 };

  const days = opts.retentionDays ?? dbosWorkflowGcRetentionDays();
  const batchLimit = opts.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoffMs = nowMs - days * 86_400_000;
  const deps = opts.deps ?? sqlDeps(getOrgPg().sql as SqlLike);

  let deletedWorkflows = 0;
  let deletedOutputs = 0;
  let batches = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const ids = await deps.selectTerminalVictims(cutoffMs, batchLimit);
    if (ids.length === 0) break;
    batches += 1;
    // operation_outputs first (FK order), then the workflow rows.
    deletedOutputs += await deps.deleteOutputs(ids);
    deletedWorkflows += await deps.deleteWorkflows(ids);
    if (ids.length < batchLimit) break;
  }
  return { skipped: false, deletedWorkflows, deletedOutputs, cutoffMs, batches };
}
