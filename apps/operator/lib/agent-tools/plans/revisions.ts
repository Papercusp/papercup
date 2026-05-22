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
import {
  resolveAgentIdentity,
  type AgentIdentity,
  type ResolveIdentityCtx,
} from '../coordination/identity';

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

export interface PlanRevisionCapture {
  /**
   * Pass straight to `withPlanLock`'s `afterWrite`. Appends one
   * `plan_revisions` row for the write. A no-op when the call ctx
   * carries no attributable identity — best-effort (D-014).
   */
  afterWrite: (writtenBody: string) => Promise<void>;
  /**
   * Mutable cell — `afterWrite` writes the recorded revision (or
   * `null` on a best-effort miss) here. Read it *after* `withPlanLock`
   * returns. A ref object rather than a closed-over `let` so the
   * post-call type survives control-flow analysis.
   */
  recorded: { current: RecordedRevision | null };
}

/**
 * Build the revision-capture hook for a `plans:*` write verb: resolve
 * the caller identity once, and return an `afterWrite` that appends
 * one `plan_revisions` row per write plus a `recorded` cell to read
 * the result from. Every write verb wires revision capture through
 * this one helper so the behaviour is identical (P-002 / P-003).
 *
 * `sessionRef` is the conversation that produced the write — Phase 2
 * (P-006) threads it through the call ctx; until then verbs pass
 * nothing and the revision's session columns stay `null`.
 */
export function planRevisionCapture(
  ctx: ResolveIdentityCtx,
  slug: string,
  rationale: string | null | undefined,
  sessionRef?: {
    sessionId?: string | null;
    sessionKind?: PlanRevisionSessionKind | null;
  },
): PlanRevisionCapture {
  let identity: AgentIdentity | null = null;
  try {
    identity = resolveAgentIdentity(ctx);
  } catch {
    // No attributable identity — record nothing rather than fail the
    // write (D-014). `id` stays null → `afterWrite` is a no-op.
    identity = null;
  }
  const id = identity;
  const recorded: { current: RecordedRevision | null } = { current: null };

  const afterWrite = id
    ? async (writtenBody: string): Promise<void> => {
        recorded.current = await recordPlanRevision({
          planSlug: slug,
          content: writtenBody,
          rationale: rationale ?? null,
          identity: id,
          sessionId: sessionRef?.sessionId ?? null,
          sessionKind: sessionRef?.sessionKind ?? null,
        });
      }
    : async (): Promise<void> => {
        /* no identity — best-effort skip */
      };

  return { afterWrite, recorded };
}
