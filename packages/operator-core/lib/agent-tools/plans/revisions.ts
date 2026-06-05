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

import { withWorkspace } from '@papercusp/db-org';
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
  /**
   * Harness scope for this revision. Default = 'papercup' (preserves
   * the pre-per-harness-plans-and-docs behavior where every revision
   * lived under the papercup harness). Per-harness write tools pass
   * the resolved ctx.harnessSlug; cross-harness writes pass the
   * target explicitly.
   */
  harnessSlug?: string;
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
    const contentHash = hashPlanContent(args.content);
    const authorKind = classifyAuthor(args.identity);
    const createdAt = Date.now();

    const harnessSlug = args.harnessSlug?.trim() || 'papercup';
    const seq = await withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
      // INSERT … SELECT against the same table: the aggregate
      // sub-select always yields exactly one row (COALESCE(MAX,0)+1 is
      // 1 when the plan has no prior revisions), so exactly one row is
      // inserted whether or not the plan already has revisions.
      // seq is per (harness_slug, plan_slug) so two harnesses with the
      // same plan slug have independent revision spines.
      const rows = await tx<{ seq: number }[]>`
        INSERT INTO harness_shared.plan_revisions (
          harness_slug, plan_slug, seq, content_hash, content_snapshot, rationale,
          author_kind, author_id, session_id, session_kind, created_at
        )
        SELECT
          ${harnessSlug},
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
        WHERE harness_slug = ${harnessSlug} AND plan_slug = ${args.planSlug}
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
 * Loose structural ctx subset carrying the plan-run provenance — the
 * one field `resolvePlanSessionRef` reads. Defined locally (mirrors
 * `ResolveIdentityCtx`) so the write verbs stay free of the
 * cross-package `UnifiedToolContext` type bridge; the real MCP ctx
 * carries `planRunSessionId` as an optional field.
 */
export interface PlanSessionCtx {
  /** `runAgentChat` session id of the plan-run this call belongs to,
   *  threaded by the MCP transport from `?plan_run=`. Null for every
   *  non-plan-run caller (P-006). */
  planRunSessionId?: string | null;
}

/** Ctx subset a `plans:*` write verb hands to `planRevisionCapture` —
 *  identity (who) + plan-run provenance (which conversation). The real
 *  `UnifiedToolContext` satisfies it structurally. */
export type PlanRevisionCtx = ResolveIdentityCtx & PlanSessionCtx;

/** Resolved conversation a plan write belongs to. */
export interface PlanSessionRef {
  sessionId: string | null;
  sessionKind: PlanRevisionSessionKind | null;
}

/**
 * Resolve the conversation a plan write belongs to from the call ctx.
 * Only the `plan_run` kind is threaded (P-006): a plan-run agent's MCP
 * calls carry `planRunSessionId` via `?plan_run=` on the MCP URL.
 * Every other write — an SU engineer session, a browser `/admin/plans`
 * save, a git backfill — has no threaded conversation, so this returns
 * `{ null, null }` and the revision's session columns stay null (the
 * "direct edit" case, P-019). `operator_chat` / `agent_chat` linkage
 * would each need their own surface to thread a session id and is not
 * in P-006's scope.
 */
export function resolvePlanSessionRef(ctx: PlanSessionCtx): PlanSessionRef {
  const planRun = ctx.planRunSessionId;
  if (typeof planRun === 'string' && planRun.length > 0) {
    return { sessionId: planRun, sessionKind: 'plan_run' };
  }
  return { sessionId: null, sessionKind: null };
}

/**
 * Build the revision-capture hook for a `plans:*` write verb: resolve
 * the caller identity and the plan-run conversation once, and return
 * an `afterWrite` that appends one `plan_revisions` row per write plus
 * a `recorded` cell to read the result from. Every write verb wires
 * revision capture through this one helper so the behaviour is
 * identical (P-002 / P-003).
 *
 * The conversation a write belongs to is resolved from the call ctx
 * itself (`resolvePlanSessionRef`, P-006) — the verb does not pass it.
 * A launched plan-run agent's writes carry `session_kind = 'plan_run'`
 * + its run id; every other writer records null session columns.
 */
export function planRevisionCapture(
  ctx: PlanRevisionCtx,
  slug: string,
  rationale: string | null | undefined,
  opts: { harnessSlug?: string } = {},
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
  const sessionRef = resolvePlanSessionRef(ctx);
  const recorded: { current: RecordedRevision | null } = { current: null };

  const afterWrite = id
    ? async (writtenBody: string): Promise<void> => {
        recorded.current = await recordPlanRevision({
          planSlug: slug,
          ...(opts.harnessSlug ? { harnessSlug: opts.harnessSlug } : {}),
          content: writtenBody,
          rationale: rationale ?? null,
          identity: id,
          sessionId: sessionRef.sessionId,
          sessionKind: sessionRef.sessionKind,
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
  /** Global `plan_revisions` PK — the stable id `plans:revision-transcript`
   *  (P-008) is addressed by. `seq` is the human-facing per-plan number. */
  id: number;
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
  id: number | string;
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
export async function listPlanRevisions(
  planSlug: string,
  opts: { harnessSlug?: string } = {},
): Promise<PlanRevisionRow[]> {
  const harnessSlug = opts.harnessSlug?.trim() || 'papercup';
  const rows = await withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
    return tx<PlanRevisionDbRow[]>`
      SELECT id, seq, content_hash, content_snapshot, rationale,
             author_kind, author_id, session_id, session_kind, created_at
      FROM harness_shared.plan_revisions
      WHERE harness_slug = ${harnessSlug} AND plan_slug = ${planSlug}
      ORDER BY seq ASC
    `;
  });

  // Walk oldest→newest so each row diffs against its predecessor,
  // then reverse for the newest-first contract.
  const chain: PlanRevisionRow[] = [];
  let prevSnapshot = '';
  for (const r of rows) {
    chain.push({
      id: Number(r.id),
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

/** A revision identified for transcript routing + rationale work —
 *  what `plans:revision-transcript` (P-008) and the rationale
 *  auto-summary (P-007) need about a single revision. */
export interface PlanRevisionRef {
  id: number;
  planSlug: string;
  seq: number;
  rationale: string | null;
  sessionId: string | null;
  sessionKind: PlanRevisionSessionKind | null;
  createdAt: number;
}

/**
 * Fetch one revision by its global `plan_revisions` id — or `null`
 * when no such revision exists. Used by `plans:revision-transcript`
 * (P-008) to route to the right transcript store, and by P-007's
 * rationale auto-summary. Throws on a genuine DB failure.
 */
export async function getPlanRevisionById(
  revisionId: number,
): Promise<PlanRevisionRef | null> {
  return withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
    const rows = await tx<
      {
        id: number | string;
        plan_slug: string;
        seq: number;
        rationale: string | null;
        session_id: string | null;
        session_kind: string | null;
        created_at: string | number;
      }[]
    >`
      SELECT id, plan_slug, seq, rationale, session_id, session_kind, created_at
      FROM harness_shared.plan_revisions
      WHERE id = ${revisionId}
    `;
    const r = rows[0];
    if (!r) return null;
    return {
      id: Number(r.id),
      planSlug: r.plan_slug,
      seq: Number(r.seq),
      rationale: r.rationale,
      sessionId: r.session_id,
      sessionKind: r.session_kind as PlanRevisionSessionKind | null,
      createdAt: Number(r.created_at),
    };
  });
}

/**
 * Fetch the snapshot pair around one revision — the revision itself
 * (`newer`) and its immediate predecessor (`older`, or `null` for seq 1)
 * — in one query. Used by `plans:revision-diff` (P-018) to render a
 * unified diff without an additional round-trip. Throws on a genuine
 * DB failure; returns `null` when the revision id is unknown.
 */
export interface PlanRevisionPair {
  newer: {
    id: number;
    planSlug: string;
    seq: number;
    contentSnapshot: string;
    createdAt: number;
  };
  /** Null when `newer.seq === 1`. */
  older: { seq: number; contentSnapshot: string; createdAt: number } | null;
}

export async function getPlanRevisionPairById(
  revisionId: number,
): Promise<PlanRevisionPair | null> {
  return withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
    const rows = await tx<
      {
        id: number | string;
        plan_slug: string;
        seq: number;
        content_snapshot: string;
        created_at: string | number;
        is_target: boolean;
      }[]
    >`
      WITH target AS (
        SELECT harness_slug, plan_slug, seq
        FROM harness_shared.plan_revisions
        WHERE id = ${revisionId}
      )
      SELECT r.id, r.plan_slug, r.seq, r.content_snapshot, r.created_at,
             (r.seq = (SELECT seq FROM target)) AS is_target
      FROM harness_shared.plan_revisions r, target t
      WHERE r.harness_slug = t.harness_slug
        AND r.plan_slug = t.plan_slug
        AND r.seq IN (t.seq, t.seq - 1)
      ORDER BY r.seq DESC
    `;
    const newerRow = rows.find((r) => r.is_target);
    if (!newerRow) return null;
    const olderRow = rows.find((r) => !r.is_target);
    return {
      newer: {
        id: Number(newerRow.id),
        planSlug: newerRow.plan_slug,
        seq: Number(newerRow.seq),
        contentSnapshot: newerRow.content_snapshot,
        createdAt: Number(newerRow.created_at),
      },
      older: olderRow
        ? {
            seq: Number(olderRow.seq),
            contentSnapshot: olderRow.content_snapshot,
            createdAt: Number(olderRow.created_at),
          }
        : null,
    };
  });
}

/**
 * Fill in a revision's `rationale` — used by P-007's auto-summary to
 * cache a generated rationale back onto the row. The `rationale IS NULL`
 * guard means an authored rationale (or a concurrent fill) is never
 * clobbered. Returns whether a row was actually updated.
 */
export async function setPlanRevisionRationale(
  revisionId: number,
  rationale: string,
): Promise<boolean> {
  return withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
    const rows = await tx<{ id: number }[]>`
      UPDATE harness_shared.plan_revisions
      SET rationale = ${rationale}
      WHERE id = ${revisionId} AND rationale IS NULL
      RETURNING id
    `;
    return rows.length > 0;
  });
}

// ── Git-history backfill (P-005) ───────────────────────────────────

/**
 * Count of recorded revisions for a plan. The backfill (P-005) uses
 * this for idempotency — a plan with any rows is left untouched, so
 * the backfill never collides with or renumbers live revisions.
 */
export async function countPlanRevisions(
  planSlug: string,
  opts: { harnessSlug?: string } = {},
): Promise<number> {
  const harnessSlug = opts.harnessSlug?.trim() || 'papercup';
  return withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
    const rows = await tx<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
      FROM harness_shared.plan_revisions
      WHERE harness_slug = ${harnessSlug} AND plan_slug = ${planSlug}
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
  opts: { harnessSlug?: string } = {},
): Promise<number> {
  if (revisions.length === 0) return 0;
  const harnessSlug = opts.harnessSlug?.trim() || 'papercup';
  return withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
    let seq = 0;
    for (const r of revisions) {
      seq += 1;
      await tx`
        INSERT INTO harness_shared.plan_revisions (
          harness_slug, plan_slug, seq, content_hash, content_snapshot, rationale,
          author_kind, author_id, session_id, session_kind, created_at
        ) VALUES (
          ${harnessSlug}, ${planSlug}, ${seq}, ${r.contentHash}, ${r.content}, ${r.rationale},
          'human', ${r.authorId}, NULL, 'git_backfill', ${r.createdAt}
        )
      `;
    }
    return seq;
  });
}
