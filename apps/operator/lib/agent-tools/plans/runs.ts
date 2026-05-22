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

/** A `plan_runs` row, camelCased. Returned by `getPlanRun`. */
export interface PlanRunRow {
  id: number;
  planSlug: string;
  planContentHash: string;
  sessionId: string;
  note: string | null;
  launchedBy: string;
  launchedAt: number;
  status: PlanRunStatus;
  title: string | null;
  updatedAt: number;
}

/** Fetch a single run by id, or `null` when no such run exists. Used
 *  by resume (P-013) to recover a run's `session_id` + `plan_slug`. */
export async function getPlanRun(runId: number): Promise<PlanRunRow | null> {
  await ensurePlanRunsTable();
  return withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
    const rows = await tx<
      {
        id: number;
        plan_slug: string;
        plan_content_hash: string;
        session_id: string;
        note: string | null;
        launched_by: string;
        launched_at: number;
        status: PlanRunStatus;
        title: string | null;
        updated_at: number;
      }[]
    >`
      SELECT id, plan_slug, plan_content_hash, session_id, note,
             launched_by, launched_at, status, title, updated_at
      FROM harness_shared.plan_runs
      WHERE id = ${runId}
    `;
    const r = rows[0];
    if (!r) return null;
    return {
      id: Number(r.id),
      planSlug: r.plan_slug,
      planContentHash: r.plan_content_hash,
      sessionId: r.session_id,
      note: r.note,
      launchedBy: r.launched_by,
      launchedAt: Number(r.launched_at),
      status: r.status,
      title: r.title,
      updatedAt: Number(r.updated_at),
    };
  });
}

/**
 * Mark a run `running` and re-stamp its `plan_content_hash` — called
 * by resume (P-013) at the start of a continuation. The hash is
 * updated because the resumed turn is re-seeded with the *current*
 * plan (the bundle is re-sent as the system prompt every spawn), so
 * `plan_content_hash` always means "the plan as the run last saw it" —
 * which keeps P-023's stale-version badge honest.
 */
export async function markPlanRunResumed(
  runId: number,
  planContentHash: string,
): Promise<void> {
  await ensurePlanRunsTable();
  await withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
    await tx`
      UPDATE harness_shared.plan_runs
      SET status = 'running',
          plan_content_hash = ${planContentHash},
          updated_at = ${Date.now()}
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
