/**
 * harness_shared.plan_revisions helpers — the plan revision spine.
 *
 * plan-agent-launch-2026-05-21, Phase 1 (P-002 / D-003 / D-009).
 *
 * One row per semantic plan write. `recordPlanRevision()` is called by
 * the `plans:*` write verbs *after* a successful file write, from the
 * `withPlanLock` `afterWrite` hook — so it runs while the plan-file
 * lock is still held and `seq` allocation (max+1) is race-free for a
 * given `plan_slug`.
 *
 * Recording is BEST-EFFORT (D-014): the `.md` file is the canonical
 * artifact (the FS is canonical for plan *content*), and a transient
 * DB outage must not block a plan write. A failed append is logged
 * and leaves a gap that P-005's git backfill can later recover.
 * `recordPlanRevision()` therefore never throws — it returns `null`
 * on failure and the caller proceeds.
 */

import { withWorkspace } from '@restart/db-org';
import { ensurePlanRevisionsTable } from '../../ensure-schema';
import { DEFAULT_WORKSPACE_ID } from '../../workspace-registry';
import { hashPlanContent } from './content-hash';
import type { AgentIdentity } from '../coordination/identity';

/** Who authored a revision. `human` = a person driving the
 *  `/admin/plans` editor or operator chat; `agent` = an agent's own
 *  MCP session. */
export type PlanRevisionAuthorKind = 'agent' | 'human';

/** Which kind of session produced a revision — recorded so
 *  `plans:revision-transcript` (P-008) knows which store to read. */
export type PlanRevisionSessionKind = 'plan_run' | 'operator_chat' | 'agent_chat';

export interface RecordPlanRevisionArgs {
  /** The plan whose write this revision records. */
  planSlug: string;
  /** The full markdown written to disk at this revision (D-011 — the
   *  snapshot is self-contained, never a hash-only reference). */
  content: string;
  /** Optional "why" — D-009; supplied by the writer in the same call
   *  that wrote the content. */
  rationale?: string | null;
  /** Resolved identity of the writer. */
  identity: AgentIdentity;
  /** The conversation that produced the write. Phase 2 (P-006)
   *  threads these through the call ctx; until then they are `null`
   *  — a direct editor save and a git backfill also have no session. */
  sessionId?: string | null;
  sessionKind?: PlanRevisionSessionKind | null;
}

export interface RecordedRevision {
  /** 1-based per-plan revision number. */
  seq: number;
  /** `hashPlanContent()` of the snapshot — matches `plans:get`. */
  contentHash: string;
}

/**
 * Classify the writer. `principal` identities are the in-process
 * callers — the `/admin/plans` editor route proxy and operator chat
 * — i.e. a human is driving. Every other identity source
 * (`power-user-token` / `omp-hook-session` / `static-client`) is an
 * agent's own MCP session. P-006 refines this once the full session
 * context is threaded onto the call ctx.
 */
export function classifyAuthor(identity: AgentIdentity): PlanRevisionAuthorKind {
  return identity.source === 'principal' ? 'human' : 'agent';
}

/**
 * Append one `plan_revisions` row. Allocates `seq` as `max+1` for the
 * plan in a single `INSERT … SELECT` — race-free because the caller
 * holds the plan-file lock, with `UNIQUE (plan_slug, seq)` as the
 * backstop. Best-effort: never throws; returns `null` on any failure.
 */
export async function recordPlanRevision(
  args: RecordPlanRevisionArgs,
): Promise<RecordedRevision | null> {
  try {
    await ensurePlanRevisionsTable();
    const contentHash = hashPlanContent(args.content);
    const authorKind = classifyAuthor(args.identity);
    const createdAt = Date.now();

    const seq = await withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
      // INSERT … SELECT against the same table: the aggregate
      // sub-select always yields exactly one row (COALESCE(MAX,0)+1 is
      // 1 when the plan has no prior revisions), so exactly one row is
      // inserted whether or not the plan already has revisions.
      const rows = await tx<{ seq: number }[]>`
        INSERT INTO harness_shared.plan_revisions (
          plan_slug, seq, content_hash, content_snapshot, rationale,
          author_kind, author_id, session_id, session_kind, created_at
        )
        SELECT
          ${args.planSlug},
          COALESCE(MAX(seq), 0) + 1,
          ${contentHash},
          ${args.content},
          ${args.rationale ?? null},
          ${authorKind},
          ${args.identity.ownerId},
          ${args.sessionId ?? null},
          ${args.sessionKind ?? null},
          ${createdAt}
        FROM harness_shared.plan_revisions
        WHERE plan_slug = ${args.planSlug}
        RETURNING seq
      `;
      return Number(rows[0].seq);
    });

    return { seq, contentHash };
  } catch (err) {
    console.warn(
      `[plan_revisions] failed to record revision for ${args.planSlug}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return null;
  }
}
