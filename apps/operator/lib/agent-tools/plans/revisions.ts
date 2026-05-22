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
 *  `plans:revision-transcript` (P-008) knows which store to read.
 *  `git_backfill` is the one value with no live session: a revision
 *  reconstructed from a past git commit (P-005). */
export type PlanRevisionSessionKind =
  | 'plan_run'
  | 'operator_chat'
  | 'agent_chat'
  | 'git_backfill';

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

// ── Reading the revision chain (P-004) ─────────────────────────────

/** Longest-common-subsequence length over two line arrays. Rolling
 *  1-D DP — O(min·max) time, O(n) space; the length is all the
 *  diff-stat needs. Plans are small, so this is effectively instant. */
function lcsLength(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return 0;
  let prev = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1).fill(0);
    for (let j = 1; j <= n; j++) {
      cur[j] =
        a[i - 1] === b[j - 1]
          ? (prev[j - 1] ?? 0) + 1
          : Math.max(prev[j] ?? 0, cur[j - 1] ?? 0);
    }
    prev = cur;
  }
  return prev[n] ?? 0;
}

/**
 * Line-level add/remove counts between two plan snapshots — the
 * `+N/-N` shown per row in the Revisions panel. `removed`/`added` are
 * the lines of `before`/`after` not on the longest common
 * subsequence. For the first revision `before` is empty, so the stat
 * is the whole plan added.
 */
export function revisionDiffStat(
  before: string,
  after: string,
): { added: number; removed: number } {
  const a = before.length > 0 ? before.split('\n') : [];
  const b = after.length > 0 ? after.split('\n') : [];
  const lcs = lcsLength(a, b);
  return { added: b.length - lcs, removed: a.length - lcs };
}

/** One row of the revision chain as returned by `plans:revisions` —
 *  metadata + diff-stat, never the (heavy) content snapshot itself. */
export interface PlanRevisionRow {
  seq: number;
  contentHash: string;
  rationale: string | null;
  authorKind: PlanRevisionAuthorKind;
  authorId: string;
  sessionId: string | null;
  sessionKind: PlanRevisionSessionKind | null;
  createdAt: number;
  /** Lines changed vs the previous revision (vs empty for seq 1). */
  diffStat: { added: number; removed: number };
}

interface PlanRevisionDbRow {
  seq: number;
  content_hash: string;
  content_snapshot: string;
  rationale: string | null;
  author_kind: string;
  author_id: string;
  session_id: string | null;
  session_kind: string | null;
  created_at: string;
}

/**
 * The full revision chain for a plan, newest-first. Diff-stats are
 * computed server-side from adjacent snapshot pairs; the snapshots
 * themselves are not returned (a single revision's body is fetched
 * on demand). A plan with no recorded revisions returns `[]` — not
 * an error. Throws on a genuine DB failure so the caller can surface
 * "revisions unavailable" rather than a misleading empty chain.
 */
export async function listPlanRevisions(planSlug: string): Promise<PlanRevisionRow[]> {
  await ensurePlanRevisionsTable();
  const rows = await withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
    return tx<PlanRevisionDbRow[]>`
      SELECT seq, content_hash, content_snapshot, rationale,
             author_kind, author_id, session_id, session_kind, created_at
      FROM harness_shared.plan_revisions
      WHERE plan_slug = ${planSlug}
      ORDER BY seq ASC
    `;
  });

  // Walk oldest→newest so each row diffs against its predecessor,
  // then reverse for the newest-first contract.
  const chain: PlanRevisionRow[] = [];
  let prevSnapshot = '';
  for (const r of rows) {
    chain.push({
      seq: Number(r.seq),
      contentHash: r.content_hash,
      rationale: r.rationale,
      authorKind: r.author_kind as PlanRevisionAuthorKind,
      authorId: r.author_id,
      sessionId: r.session_id,
      sessionKind: r.session_kind as PlanRevisionSessionKind | null,
      createdAt: Number(r.created_at),
      diffStat: revisionDiffStat(prevSnapshot, r.content_snapshot),
    });
    prevSnapshot = r.content_snapshot;
  }
  chain.reverse();
  return chain;
}

// ── Git-history backfill (P-005) ───────────────────────────────────

/**
 * Count of recorded revisions for a plan. The backfill (P-005) uses
 * this for idempotency — a plan with any rows is left untouched, so
 * the backfill never collides with or renumbers live revisions.
 */
export async function countPlanRevisions(planSlug: string): Promise<number> {
  await ensurePlanRevisionsTable();
  return withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
    const rows = await tx<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
      FROM harness_shared.plan_revisions
      WHERE plan_slug = ${planSlug}
    `;
    return Number(rows[0]?.n ?? 0);
  });
}

/** One synthetic revision built from a past git commit (P-005). */
export interface BackfillRevisionInput {
  /** `hashPlanContent()` of the snapshot. */
  contentHash: string;
  /** The plan markdown at that commit. */
  content: string;
  /** The commit subject — a weak rationale (D-015). `null` when the
   *  commit had an empty subject. */
  rationale: string | null;
  /** The git commit author. */
  authorId: string;
  /** The commit's author date, epoch ms. */
  createdAt: number;
}

/**
 * Insert a plan's backfilled revisions in one transaction, `seq`
 * 1..N in array order (oldest commit first — the caller reverses
 * git's newest-first log). The caller MUST have verified the plan has
 * zero existing revisions and MUST hold the plan-file lock — backfill
 * is a one-time migration (D-015), and explicit `seq` is safe only
 * against an empty starting state.
 *
 * Every backfilled row carries `author_kind = 'human'` (a git commit
 * is nominally person-authored — even an agent's commit is attributed
 * to a person here), `session_id = NULL`, and `session_kind =
 * 'git_backfill'` as the provenance marker. `withWorkspace` wraps the
 * loop in one transaction, so a mid-loop failure rolls the whole plan
 * back and a retry re-backfills cleanly. Returns the row count.
 */
export async function insertBackfillRevisions(
  planSlug: string,
  revisions: BackfillRevisionInput[],
): Promise<number> {
  if (revisions.length === 0) return 0;
  await ensurePlanRevisionsTable();
  return withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
    let seq = 0;
    for (const r of revisions) {
      seq += 1;
      await tx`
        INSERT INTO harness_shared.plan_revisions (
          plan_slug, seq, content_hash, content_snapshot, rationale,
          author_kind, author_id, session_id, session_kind, created_at
        ) VALUES (
          ${planSlug}, ${seq}, ${r.contentHash}, ${r.content}, ${r.rationale},
          'human', ${r.authorId}, NULL, 'git_backfill', ${r.createdAt}
        )
      `;
    }
    return seq;
  });
}
