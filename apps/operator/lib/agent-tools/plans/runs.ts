/**
 * harness_shared.plan_runs + plan_run_turns data access — the launched
 * plan-agent run store. plan-agent-launch-2026-05-21, Phase 3.
 *
 * `plan_runs` — one row per agent launched from a plan (P-012,
 * launches-only — the plan's origin is `plan_revisions` seq 1, D-006).
 * `plan_run_turns` — the run transcript, one row per turn.
 *
 * A thin DAL over the `harness_shared` tables P-010 created, in the
 * shape of `revisions.ts`. Used by `plans:launch` (P-012), resume
 * (P-013), and `plans:runs` (P-015). Unlike `recordPlanRevision`
 * (best-effort — the `.md` file is canonical), these rows ARE the
 * canonical record of a launch, so the writes throw on failure; the
 * caller decides what is fatal (a missing transcript turn is not — the
 * run already streamed to the user).
 */

import { withWorkspace } from '@restart/db-org';
import {
  ensurePlanRunsTable,
  ensurePlanRunTurnsTable,
} from '../../ensure-schema';
import { DEFAULT_WORKSPACE_ID } from '../../workspace-registry';

/** A run's lifecycle status. `running` while a turn streams; `idle`
 *  when a turn finished and the run can be resumed (D-010); `failed`
 *  when the agent backend errored. `archived` / `done` are P-016. */
export type PlanRunStatus = 'running' | 'idle' | 'archived' | 'done' | 'failed';

/** Transcript turn author. */
export type PlanRunTurnRole = 'user' | 'assistant';

export interface InsertPlanRunArgs {
  planSlug: string;
  /** `hashPlanContent` of the plan doc that seeded the launch — P-023's
   *  stale-version badge compares it against the plan's current hash. */
  planContentHash: string;
  /** The run's `runAgentChat` session id (also the `?plan_run=` value). */
  sessionId: string;
  /** Optional free-text launch instruction. */
  note: string | null;
  /** Resolved identity of whoever launched the run. */
  launchedBy: string;
  /** Human-readable run label for the runs list. */
  title: string | null;
  /** Initial status — `running` at launch. */
  status: PlanRunStatus;
}

/** Insert a `plan_runs` row; returns its id. Throws on DB failure — a
 *  launch with no run record genuinely failed. */
export async function insertPlanRun(args: InsertPlanRunArgs): Promise<number> {
  await ensurePlanRunsTable();
  const now = Date.now();
  return withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
    const rows = await tx<{ id: number }[]>`
      INSERT INTO harness_shared.plan_runs (
        plan_slug, plan_content_hash, session_id, note,
        launched_by, launched_at, status, title, updated_at
      ) VALUES (
        ${args.planSlug}, ${args.planContentHash}, ${args.sessionId},
        ${args.note}, ${args.launchedBy}, ${now}, ${args.status},
        ${args.title}, ${now}
      )
      RETURNING id
    `;
    return Number(rows[0].id);
  });
}

/** Update a run's status (and bump `updated_at`). */
export async function setPlanRunStatus(
  runId: number,
  status: PlanRunStatus,
): Promise<void> {
  await ensurePlanRunsTable();
  await withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
    await tx`
      UPDATE harness_shared.plan_runs
      SET status = ${status}, updated_at = ${Date.now()}
      WHERE id = ${runId}
    `;
  });
}

export interface AppendPlanRunTurnArgs {
  planRunId: number;
  role: PlanRunTurnRole;
  content: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
}

/**
 * Append a transcript turn. `seq` is allocated `max+1` per run in a
 * single `INSERT … SELECT` — `plans:launch` serialises its two turns
 * (user then assistant), and `UNIQUE (plan_run_id, seq)` is the
 * backstop. Returns the allocated `seq`. Throws on DB failure; the
 * caller treats a lost transcript turn as non-fatal (the run already
 * streamed to the user).
 */
export async function appendPlanRunTurn(
  args: AppendPlanRunTurnArgs,
): Promise<number> {
  await ensurePlanRunTurnsTable();
  const now = Date.now();
  return withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
    const rows = await tx<{ seq: number }[]>`
      INSERT INTO harness_shared.plan_run_turns (
        plan_run_id, seq, role, content,
        tokens_in, tokens_out, cost_usd, created_at
      )
      SELECT
        ${args.planRunId},
        COALESCE(MAX(seq), 0) + 1,
        ${args.role}, ${args.content},
        ${args.tokensIn ?? null}, ${args.tokensOut ?? null},
        ${args.costUsd ?? null}, ${now}
      FROM harness_shared.plan_run_turns
      WHERE plan_run_id = ${args.planRunId}
      RETURNING seq
    `;
    return Number(rows[0].seq);
  });
}
