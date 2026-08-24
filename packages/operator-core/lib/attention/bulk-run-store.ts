/**
 * bulk-run-store — the durable record of an Inbox BULK RESOLVE run
 * (inbox-bulk-resolve-2026-08-23, P-001; migration 912).
 *
 * The owner clicks the Inbox pane's command strip; one resolver agent (D-002)
 * works the exact set of attention items the pane was displaying, auto-resolving
 * what it can settle and pre-recommending the rest for a one-click review pass.
 * This module is the whole persistence surface for that: the run's phase +
 * counters, and one outcome row per item.
 *
 * Two properties are load-bearing and easy to lose, so they live here rather
 * than in a caller:
 *
 *  - **Membership is a SNAPSHOT, never a re-derived query.** `plans.attention`
 *    is a live SSE-invalidated feed, so re-running the owner's filter would
 *    resolve against a set that has moved since they looked. `createRun` takes
 *    the concrete item list the client was rendering; `filterSnapshot` is
 *    human-readable provenance only.
 *  - **Counters are derived from the item rows, never incremented blind.**
 *    `reportOutcomes` recomputes them inside the same statement batch, so a
 *    retried or re-reported item cannot double-count (the resolver reports at
 *    least once per item and may re-report after a consult reply lands).
 *
 * Access mirrors triage-store.ts: plain `getOrgPg().sql` with an explicit
 * workspace_id predicate. The org PG handle connects as the table owner, so the
 * RLS policy is enforced for the runtime app role and bypassed here, exactly as
 * every other operator-state table does it.
 */

import { randomUUID } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import type { Sql, TransactionSql } from 'postgres';
import { activeWorkspaceId } from '../workspace-registry';

/** Lifecycle of a run. `review` means the agent is done and the owner has
 *  recommendations waiting; `complete` means nothing is left to act on. */
export type BulkRunPhase = 'pending' | 'running' | 'review' | 'complete' | 'failed';

/** Per-item terminal disposition. `pending` is the pre-report state — an item
 *  still carrying it when a run ends was never reached (Requirement 2 makes
 *  that visible rather than silently absent). */
export type BulkItemOutcome = 'pending' | 'auto_resolved' | 'recommended' | 'skipped' | 'failed';

/** Non-terminal phases — a run in one of these is still the pane's current run. */
export const ACTIVE_PHASES: readonly BulkRunPhase[] = ['pending', 'running', 'review'] as const;

/** Terminal phases — nothing further will be written by the resolver. */
export const TERMINAL_PHASES: readonly BulkRunPhase[] = ['complete', 'failed'] as const;

/**
 * Phases in which a run is EXCLUSIVE — an agent is acting, or is about to.
 * `review` is deliberately absent: a run in review is waiting on the OWNER, not
 * working, so it must not block a new run behind a review list the owner may
 * never return to. Migration 915's partial unique index is keyed on exactly
 * this set; keep the two in step.
 */
export const RUNNING_PHASES: readonly BulkRunPhase[] = ['pending', 'running'] as const;

/**
 * Phases in which the resolver's outcome reports are still accepted. Same set
 * as RUNNING_PHASES today, but named separately because it answers a different
 * question ("may this write land?" rather than "may a new run start?") and the
 * two are free to diverge.
 */
const ACCEPTING_REPORTS: readonly BulkRunPhase[] = RUNNING_PHASES;

/**
 * WI-41012 — a start was refused because a run is already pending/running in
 * this workspace. Typed rather than a bare Error so the route can answer with a
 * useful `run_already_active` (naming the run already in flight) instead of a
 * 500, and so the pre-check and the DB rail are indistinguishable to a caller.
 */
export class BulkRunAlreadyActiveError extends Error {
  readonly code = 'run_already_active';
  constructor(
    readonly activeRunId: string | null,
    readonly activePhase: BulkRunPhase | null,
  ) {
    super(
      activeRunId
        ? `a bulk-resolve run is already active (${activeRunId}, phase ${activePhase ?? 'unknown'})`
        : 'a bulk-resolve run is already active in this workspace',
    );
    this.name = 'BulkRunAlreadyActiveError';
  }
}

/** Is this error the single-flight index (migration 915) refusing a second run? */
function isSingleFlightViolation(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (code !== '23505') return false;
  const detail = `${(e as { constraint_name?: unknown } | null)?.constraint_name ?? ''} ${
    e instanceof Error ? e.message : ''
  }`;
  return detail.includes('one_active_per_workspace');
}

/** The filters in force when the owner clicked — provenance for the record and
 *  the review header, never the source of membership. */
export interface BulkRunFilterSnapshot {
  /** The tier chip (`opci`): needs | alerts | all. */
  tier?: string | null;
  /** Selected kind facets (`opck`). */
  kinds?: string[];
  /** The text search (`opcq`). */
  query?: string | null;
  /** What the pane said it was showing — cross-checked against items.length. */
  shownCount?: number | null;
}

/** One item as the client was displaying it at click time. */
export interface BulkRunSeedItem {
  itemId: string;
  kind?: string | null;
  title?: string | null;
  /** The item's dispatch coordinates (msgId / slug+itemId / issueId / …).
   *  Attention items are projections with no row to reference, so re-dispatch
   *  later depends entirely on this snapshot. */
  ref?: Record<string, unknown> | null;
  ownerAgentId?: string | null;
}

export interface BulkRunRow {
  runId: string;
  workspaceId: string;
  harnessSlug: string | null;
  requestedBy: string | null;
  resolverOwner: string | null;
  phase: BulkRunPhase;
  filterSnapshot: BulkRunFilterSnapshot;
  totalItems: number;
  autoResolved: number;
  recommended: number;
  skipped: number;
  failed: number;
  error: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface BulkRunItemRow {
  runId: string;
  itemId: string;
  position: number;
  kind: string | null;
  title: string | null;
  ref: Record<string, unknown>;
  ownerAgentId: string | null;
  outcome: BulkItemOutcome;
  actionId: string | null;
  rationale: string | null;
  draftAnswer: string | null;
  confidence: 'low' | 'high' | null;
  consulted: boolean;
  consultReply: string | null;
  error: string | null;
  decidedAt: string | null;
}

/** What the resolver reports back for one item. */
export interface BulkOutcomeReport {
  itemId: string;
  outcome: Exclude<BulkItemOutcome, 'pending'>;
  actionId?: string | null;
  rationale?: string | null;
  draftAnswer?: string | null;
  confidence?: 'low' | 'high' | null;
  consulted?: boolean;
  consultReply?: string | null;
  error?: string | null;
}

function iso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** Postgres `jsonb` comes back parsed by the driver, but a legacy/text column
 *  or a hand-written row can still hand us a string — normalize both. */
function asObject(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through to {} */
    }
  }
  return {};
}

interface RawRunRow {
  run_id: string;
  workspace_id: string;
  harness_slug: string | null;
  requested_by: string | null;
  resolver_owner: string | null;
  phase: BulkRunPhase;
  filter_snapshot: unknown;
  total_items: number | string;
  auto_resolved: number | string;
  recommended: number | string;
  skipped: number | string;
  failed: number | string;
  error: string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
}

function mapRun(r: RawRunRow): BulkRunRow {
  return {
    runId: r.run_id,
    workspaceId: r.workspace_id,
    harnessSlug: r.harness_slug,
    requestedBy: r.requested_by,
    resolverOwner: r.resolver_owner,
    phase: r.phase,
    filterSnapshot: asObject(r.filter_snapshot) as BulkRunFilterSnapshot,
    totalItems: Number(r.total_items ?? 0),
    autoResolved: Number(r.auto_resolved ?? 0),
    recommended: Number(r.recommended ?? 0),
    skipped: Number(r.skipped ?? 0),
    failed: Number(r.failed ?? 0),
    error: r.error,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
  };
}

interface RawItemRow {
  run_id: string;
  item_id: string;
  position: number | string;
  item_kind: string | null;
  item_title: string | null;
  item_ref: unknown;
  owner_agent_id: string | null;
  outcome: BulkItemOutcome;
  action_id: string | null;
  rationale: string | null;
  draft_answer: string | null;
  confidence: 'low' | 'high' | null;
  consulted: boolean;
  consult_reply: string | null;
  error: string | null;
  decided_at: Date | string | null;
}

function mapItem(r: RawItemRow): BulkRunItemRow {
  return {
    runId: r.run_id,
    itemId: r.item_id,
    position: Number(r.position ?? 0),
    kind: r.item_kind,
    title: r.item_title,
    ref: asObject(r.item_ref),
    ownerAgentId: r.owner_agent_id,
    outcome: r.outcome,
    actionId: r.action_id,
    rationale: r.rationale,
    draftAnswer: r.draft_answer,
    confidence: r.confidence,
    consulted: r.consulted === true,
    consultReply: r.consult_reply,
    error: r.error,
    decidedAt: iso(r.decided_at),
  };
}

const RUN_COLUMNS = `run_id, workspace_id, harness_slug, requested_by, resolver_owner, phase,
                     filter_snapshot, total_items, auto_resolved, recommended, skipped, failed,
                     error, created_at, updated_at, started_at, finished_at`;

const ITEM_COLUMNS = `run_id, item_id, position, item_kind, item_title, item_ref, owner_agent_id,
                      outcome, action_id, rationale, draft_answer, confidence, consulted,
                      consult_reply, error, decided_at`;

type BulkSql = Sql | TransactionSql;

async function recomputeCounters(sql: BulkSql, runId: string, workspaceId: string): Promise<void> {
  await sql`
    UPDATE harness_shared.attention_bulk_runs r
       SET auto_resolved = c.auto_resolved,
           recommended = c.recommended,
           skipped = c.skipped,
           failed = c.failed,
           updated_at = now()
      FROM (
        SELECT
          COUNT(*) FILTER (WHERE outcome = 'auto_resolved')::int AS auto_resolved,
          COUNT(*) FILTER (WHERE outcome = 'recommended')::int  AS recommended,
          COUNT(*) FILTER (WHERE outcome = 'skipped')::int      AS skipped,
          COUNT(*) FILTER (WHERE outcome = 'failed')::int       AS failed
          FROM harness_shared.attention_bulk_run_items
         WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
      ) c
     WHERE r.workspace_id = ${workspaceId} AND r.run_id = ${runId}
  `;
}

/**
 * Execute one irreversible terminal action while holding the run's revocable
 * authority token. Stop/settle takes the same row lock, so exactly one ordering
 * wins: either the action (including audit + outcome + counters) commits first,
 * or Stop commits first and the callback is never entered.
 */
export async function executeBulkRunAction<T>(input: {
  runId: string;
  itemId: string;
  actionId: string;
  rationale: string;
  draftAnswer?: string | null;
  confidence?: 'low' | 'high' | null;
  consulted?: boolean;
  consultReply?: string | null;
  workspaceId?: string;
  execute: () => Promise<T>;
  /**
   * REQUIRED, not optional. The audit write joins this transaction, so a
   * failure rolls the run outcome back instead of reporting a clean, unaudited
   * success — that rollback IS the fix for WI-41023, and it only holds if the
   * callback is actually supplied.
   *
   * Optional would have made the guarantee rest on every future caller
   * REMEMBERING to pass it, which is the convention-tier enforcement WI-41023
   * was filed about in the first place (its swallowed `catch {}` was the same
   * bug one layer down). Requiring it moves the rule to the structural tier:
   * a caller that omits the audit does not compile. A terminal action that
   * genuinely needs no audit row must say so explicitly with a no-op.
   */
  audit: (sql: TransactionSql) => Promise<void>;
}): Promise<{
  actionResult: T | null;
  item: BulkRunItemRow | null;
  run: BulkRunRow | null;
  refused:
    | { reason: 'run_authority_revoked'; phase: BulkRunPhase }
    | { reason: 'run_not_found'; phase: null }
    | { reason: 'item_not_in_run'; phase: BulkRunPhase }
    | null;
}> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();

  return await sql.begin(async (tx) => {
    const runRows = await tx<RawRunRow[]>`
      SELECT ${tx.unsafe(RUN_COLUMNS)}
        FROM harness_shared.attention_bulk_runs
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
       FOR UPDATE
    `;
    const run = runRows[0] ? mapRun(runRows[0]) : null;
    if (!run) return { actionResult: null, item: null, run: null, refused: { reason: 'run_not_found' as const, phase: null } };
    if (!ACCEPTING_REPORTS.includes(run.phase)) {
      return {
        actionResult: null,
        item: null,
        run,
        refused: { reason: 'run_authority_revoked' as const, phase: run.phase },
      };
    }

    const itemRows = await tx<RawItemRow[]>`
      SELECT ${tx.unsafe(ITEM_COLUMNS)}
        FROM harness_shared.attention_bulk_run_items
       WHERE workspace_id = ${ws} AND run_id = ${input.runId} AND item_id = ${input.itemId}
       FOR UPDATE
    `;
    if (!itemRows[0]) {
      return {
        actionResult: null,
        item: null,
        run,
        refused: { reason: 'item_not_in_run' as const, phase: run.phase },
      };
    }

    const actionResult = await input.execute();
    // No `?.` — the audit is part of the success contract (see the type above).
    await input.audit(tx);
    const updatedRows = await tx<RawItemRow[]>`
      UPDATE harness_shared.attention_bulk_run_items
         SET outcome = 'auto_resolved',
             action_id = ${input.actionId},
             rationale = ${input.rationale},
             draft_answer = ${input.draftAnswer ?? null},
             confidence = ${input.confidence ?? null},
             consulted = ${input.consulted === true},
             consult_reply = ${input.consultReply ?? null},
             error = NULL,
             decided_at = now(),
             updated_at = now()
       WHERE workspace_id = ${ws} AND run_id = ${input.runId} AND item_id = ${input.itemId}
      RETURNING ${tx.unsafe(ITEM_COLUMNS)}
    `;
    await recomputeCounters(tx, input.runId, ws);
    const afterRows = await tx<RawRunRow[]>`
      SELECT ${tx.unsafe(RUN_COLUMNS)}
        FROM harness_shared.attention_bulk_runs
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
    `;
    return {
      actionResult,
      item: updatedRows[0] ? mapItem(updatedRows[0]) : null,
      run: afterRows[0] ? mapRun(afterRows[0]) : null,
      refused: null,
    };
  });
}

/**
 * Create a run from the owner's SNAPSHOT of filtered items. Returns the created
 * run row. An empty item list is rejected: a run over nothing is always a caller
 * bug (the strip is disabled at zero), and creating one would leave the pane in
 * a `review` state with nothing to review.
 */
export async function createRun(input: {
  items: BulkRunSeedItem[];
  filterSnapshot?: BulkRunFilterSnapshot;
  requestedBy?: string | null;
  harnessSlug?: string | null;
  workspaceId?: string;
  runId?: string;
}): Promise<BulkRunRow> {
  const items = input.items ?? [];
  if (items.length === 0) throw new Error('createRun: refusing to create a bulk run with zero items');

  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();
  const runId = input.runId ?? `bulk-${randomUUID()}`;

  // WI-41012 — single-flight. Starting a run LAUNCHES A REAL HEADLESS AGENT with
  // terminal authority over the owner's attention items, so two live runs means
  // two agents racing on overlapping items: the same item resolved twice, its
  // asker woken twice, two audit trails for one owner intention. This check is
  // the friendly half; migration 915's partial unique index is the rail that
  // makes it TRUE rather than likely (a check-then-insert races exactly as wide
  // as its own round trip, which is where a double-click lands).
  const live = await getRunningRun(ws);
  if (live) throw new BulkRunAlreadyActiveError(live.runId, live.phase);

  // De-dupe defensively: the client builds this list from a virtualized render,
  // and a duplicate id would violate the (workspace, run, item) key mid-insert
  // and abort the whole seed.
  const seen = new Set<string>();
  const unique = items.filter((i) => {
    if (!i?.itemId || seen.has(i.itemId)) return false;
    seen.add(i.itemId);
    return true;
  });
  if (unique.length === 0) throw new Error('createRun: no valid item ids in the snapshot');

  let rows: RawRunRow[];
  try {
    rows = await sql<RawRunRow[]>`
      INSERT INTO harness_shared.attention_bulk_runs
        (workspace_id, run_id, harness_slug, requested_by, phase, filter_snapshot, total_items)
      VALUES (${ws}, ${runId}, ${input.harnessSlug ?? null}, ${input.requestedBy ?? null},
              'pending', ${JSON.stringify(input.filterSnapshot ?? {})}::jsonb, ${unique.length})
      RETURNING ${sql.unsafe(RUN_COLUMNS)}
    `;
  } catch (e) {
    // The rail firing (migration 915) means a concurrent start won the race
    // between our check above and this insert. Re-read and report it as the
    // SAME typed refusal, so the caller cannot tell the two paths apart and a
    // race never surfaces to the owner as a 500.
    if (isSingleFlightViolation(e)) {
      const live = await getRunningRun(ws);
      throw new BulkRunAlreadyActiveError(live?.runId ?? null, live?.phase ?? null);
    }
    throw e;
  }

  for (let i = 0; i < unique.length; i += 1) {
    const it = unique[i]!;
    await sql`
      INSERT INTO harness_shared.attention_bulk_run_items
        (workspace_id, run_id, item_id, position, item_kind, item_title, item_ref, owner_agent_id, outcome)
      VALUES (${ws}, ${runId}, ${it.itemId}, ${i}, ${it.kind ?? null}, ${it.title ?? null},
              ${JSON.stringify(it.ref ?? {})}::jsonb, ${it.ownerAgentId ?? null}, 'pending')
      ON CONFLICT (workspace_id, run_id, item_id) DO NOTHING
    `;
  }

  return mapRun(rows[0]!);
}

/** Read one run (no items). Null when it does not exist in this workspace. */
export async function getRun(runId: string, workspaceId?: string): Promise<BulkRunRow | null> {
  const { sql } = getOrgPg();
  const ws = workspaceId ?? activeWorkspaceId();
  const rows = await sql<RawRunRow[]>`
    SELECT ${sql.unsafe(RUN_COLUMNS)}
      FROM harness_shared.attention_bulk_runs
     WHERE workspace_id = ${ws} AND run_id = ${runId}
  `;
  return rows[0] ? mapRun(rows[0]) : null;
}

/** One run's items, in the order the owner was looking at them. */
export async function getRunItems(runId: string, workspaceId?: string): Promise<BulkRunItemRow[]> {
  const { sql } = getOrgPg();
  const ws = workspaceId ?? activeWorkspaceId();
  const rows = await sql<RawItemRow[]>`
    SELECT ${sql.unsafe(ITEM_COLUMNS)}
      FROM harness_shared.attention_bulk_run_items
     WHERE workspace_id = ${ws} AND run_id = ${runId}
     ORDER BY position ASC
  `;
  return rows.map(mapItem);
}

/**
 * The pane's opening question: the workspace's most recent run, if any. The
 * strip renders idle when this is null or terminal, and running/review from its
 * phase otherwise — which is what makes a run survive a reload (Requirement 7).
 */
export async function getLatestRun(workspaceId?: string): Promise<BulkRunRow | null> {
  const { sql } = getOrgPg();
  const ws = workspaceId ?? activeWorkspaceId();
  const rows = await sql<RawRunRow[]>`
    SELECT ${sql.unsafe(RUN_COLUMNS)}
      FROM harness_shared.attention_bulk_runs
     WHERE workspace_id = ${ws}
     ORDER BY created_at DESC
     LIMIT 1
  `;
  return rows[0] ? mapRun(rows[0]) : null;
}

/**
 * The run that currently OWNS the workspace: pending or running — i.e. one an
 * agent is acting on. Distinct from getActiveRun, which also counts `review`
 * (owner-waiting) and answers "what should the pane show". This one answers
 * "may a new run start" and "is this run still accepting the resolver's work",
 * and is keyed on the same set as migration 915's single-flight index.
 */
export async function getRunningRun(workspaceId?: string): Promise<BulkRunRow | null> {
  const { sql } = getOrgPg();
  const ws = workspaceId ?? activeWorkspaceId();
  const rows = await sql<RawRunRow[]>`
    SELECT ${sql.unsafe(RUN_COLUMNS)}
      FROM harness_shared.attention_bulk_runs
     WHERE workspace_id = ${ws} AND phase IN ('pending', 'running')
     ORDER BY created_at DESC
     LIMIT 1
  `;
  return rows[0] ? mapRun(rows[0]) : null;
}

export async function getActiveRun(workspaceId?: string): Promise<BulkRunRow | null> {
  const { sql } = getOrgPg();
  const ws = workspaceId ?? activeWorkspaceId();
  const rows = await sql<RawRunRow[]>`
    SELECT ${sql.unsafe(RUN_COLUMNS)}
      FROM harness_shared.attention_bulk_runs
     WHERE workspace_id = ${ws} AND phase IN ('pending', 'running', 'review')
     ORDER BY created_at DESC
     LIMIT 1
  `;
  return rows[0] ? mapRun(rows[0]) : null;
}

/**
 * Move a run's phase. `started_at` is stamped on the first transition into
 * `running` and `finished_at` on any terminal phase, so duration is derivable
 * without the caller tracking it.
 */
export async function setRunPhase(input: {
  runId: string;
  phase: BulkRunPhase;
  resolverOwner?: string | null;
  error?: string | null;
  workspaceId?: string;
}): Promise<BulkRunRow | null> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();
  const terminal = TERMINAL_PHASES.includes(input.phase);
  const rows = await sql<RawRunRow[]>`
    UPDATE harness_shared.attention_bulk_runs
       SET phase = ${input.phase},
           resolver_owner = COALESCE(${input.resolverOwner ?? null}, resolver_owner),
           error = ${input.error ?? null},
           started_at = CASE WHEN ${input.phase === 'running'} AND started_at IS NULL
                             THEN now() ELSE started_at END,
           finished_at = CASE WHEN ${terminal} THEN now() ELSE finished_at END,
           updated_at = now()
     WHERE workspace_id = ${ws} AND run_id = ${input.runId}
    RETURNING ${sql.unsafe(RUN_COLUMNS)}
  `;
  return rows[0] ? mapRun(rows[0]) : null;
}

/**
 * Fail a run because its resolver process ended, but ONLY while that process
 * can still own the run. The phase guard is the important part: a headless psu
 * normally outlives its first turn, so an eventual clean process exit may race
 * with `settleRunPhase`. A stale exit observer must never turn an already
 * reviewed/completed run back into `failed`.
 *
 * Returns the failed row when this call won, otherwise null (missing run or a
 * resolver/owner already settled it). This is intentionally one conditional
 * UPDATE rather than getRun → setRunPhase; the latter has a check/write race.
 */
export async function failRunIfExecuting(input: {
  runId: string;
  error: string;
  resolverOwner?: string | null;
  workspaceId?: string;
}): Promise<BulkRunRow | null> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();
  const rows = await sql<RawRunRow[]>`
    UPDATE harness_shared.attention_bulk_runs
       SET phase = 'failed',
           resolver_owner = COALESCE(${input.resolverOwner ?? null}, resolver_owner),
           error = ${input.error.slice(0, 4000)},
           finished_at = now(),
           updated_at = now()
     WHERE workspace_id = ${ws}
       AND run_id = ${input.runId}
       AND phase IN ('pending', 'running')
    RETURNING ${sql.unsafe(RUN_COLUMNS)}
  `;
  return rows[0] ? mapRun(rows[0]) : null;
}

/**
 * Record the resolver's outcomes for one or more items, then RECOMPUTE the run's
 * counters from the item rows.
 *
 * The recompute (rather than an increment) is the point: the resolver reports at
 * least once per item and may legitimately re-report one — an item first marked
 * `recommended` becomes `auto_resolved` when a consulted asker answers in time.
 * Incrementing would double-count that; deriving cannot.
 *
 * Unknown item ids are ignored rather than inserted: an outcome for an item that
 * is not in this run's snapshot is a resolver bug, and silently widening the run
 * would break the "acts on exactly what the owner saw" guarantee.
 */
export async function reportOutcomes(input: {
  runId: string;
  outcomes: BulkOutcomeReport[];
  workspaceId?: string;
}): Promise<{
  updated: string[];
  unknown: string[];
  run: BulkRunRow | null;
  refused: { reason: 'run_not_accepting_reports'; phase: BulkRunPhase | null } | null;
}> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();
  // WI-41013/WI-41022 — the stop rail. The owner's Stop settles the run; the resolver is
  // a separate process and may not have noticed yet. Refuse its writes rather
  // than letting them land, so a stopped run cannot keep growing.
  //
  // REFUSE, never silently drop: the resolver has usually ALREADY performed the
  // terminal action it is reporting, so swallowing the write would leave it
  // believing the action was recorded when the record shows nothing. A refusal
  // it can read is what lets it stop instead of continuing down the manifest.
  //
  // This is a backstop, not the whole fix: it bounds the DAMAGE (no further
  // writes) but cannot un-take an action already taken, which is why the
  // manifest also reports `stopped` so a well-behaved resolver halts first.
  return await sql.begin(async (tx) => {
    const updated: string[] = [];
    const unknown: string[] = [];
    const runRows = await tx<RawRunRow[]>`
      SELECT ${tx.unsafe(RUN_COLUMNS)}
        FROM harness_shared.attention_bulk_runs
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
       FOR UPDATE
    `;
    const before = runRows[0] ? mapRun(runRows[0]) : null;
    if (before && !ACCEPTING_REPORTS.includes(before.phase)) {
      return {
        updated: [],
        unknown: (input.outcomes ?? []).map((o) => o?.itemId).filter((id): id is string => !!id),
        run: before,
        refused: { reason: 'run_not_accepting_reports' as const, phase: before.phase },
      };
    }

    for (const o of input.outcomes ?? []) {
      if (!o?.itemId) continue;
      const rows = await tx<{ item_id: string }[]>`
      UPDATE harness_shared.attention_bulk_run_items
         SET outcome = ${o.outcome},
             action_id = ${o.actionId ?? null},
             rationale = ${o.rationale ?? null},
             draft_answer = ${o.draftAnswer ?? null},
             confidence = ${o.confidence ?? null},
             consulted = ${o.consulted === true},
             consult_reply = ${o.consultReply ?? null},
             error = ${o.error ?? null},
             decided_at = now(),
             updated_at = now()
       WHERE workspace_id = ${ws} AND run_id = ${input.runId} AND item_id = ${o.itemId}
      RETURNING item_id
    `;
      if (rows[0]) updated.push(rows[0].item_id);
      else unknown.push(o.itemId);
    }

    await recomputeCounters(tx, input.runId, ws);
    const afterRows = await tx<RawRunRow[]>`
      SELECT ${tx.unsafe(RUN_COLUMNS)}
        FROM harness_shared.attention_bulk_runs
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
    `;
    return { updated, unknown, run: afterRows[0] ? mapRun(afterRows[0]) : null, refused: null };
  });
}

/**
 * Items still awaiting the OWNER: everything the resolver recommended (and did
 * not resolve itself). This is exactly what the review list renders.
 */
export async function getPendingReviewItems(
  runId: string,
  workspaceId?: string,
): Promise<BulkRunItemRow[]> {
  const items = await getRunItems(runId, workspaceId);
  return items.filter((i) => i.outcome === 'recommended');
}

/**
 * Mark one recommended item as accepted by the owner — it becomes
 * `auto_resolved` with the audit trail naming the owner as the actor, because
 * from the record's point of view the resolution did happen, and hiding who
 * performed it would defeat the audit requirement.
 */
export async function markItemAccepted(input: {
  runId: string;
  itemId: string;
  actionId: string;
  note?: string | null;
  workspaceId?: string;
}): Promise<BulkRunItemRow | null> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();
  const rows = await sql<RawItemRow[]>`
    UPDATE harness_shared.attention_bulk_run_items
       SET outcome = 'auto_resolved',
           action_id = ${input.actionId},
           rationale = COALESCE(${input.note ?? null}, rationale),
           decided_at = now(),
           updated_at = now()
     WHERE workspace_id = ${ws} AND run_id = ${input.runId} AND item_id = ${input.itemId}
    RETURNING ${sql.unsafe(ITEM_COLUMNS)}
  `;
  if (!rows[0]) return null;
  // Keep the run counters honest after an owner-side acceptance.
  await reportCountersOnly(input.runId, ws);
  return mapItem(rows[0]);
}

/** Recompute a run's counters from its item rows without reporting an outcome. */
export async function reportCountersOnly(runId: string, workspaceId?: string): Promise<void> {
  const { sql } = getOrgPg();
  const ws = workspaceId ?? activeWorkspaceId();
  await recomputeCounters(sql, runId, ws);
}

/**
 * Close out a run: `review` when recommendations are waiting for the owner,
 * `complete` when nothing is left to act on. Derived from the item rows rather
 * than trusted from the caller, so a resolver that miscounts cannot park the
 * pane in a review state with an empty list (or, worse, mark a run complete
 * while items still need the owner).
 */
export async function settleRunPhase(input: {
  runId: string;
  resolverOwner?: string | null;
  workspaceId?: string;
}): Promise<BulkRunRow | null> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();
  return await sql.begin(async (tx) => {
    const locked = await tx<RawRunRow[]>`
      SELECT ${tx.unsafe(RUN_COLUMNS)}
        FROM harness_shared.attention_bulk_runs
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
       FOR UPDATE
    `;
    if (!locked[0]) return null;
    const states = await tx<{ outcome: BulkItemOutcome }[]>`
      SELECT outcome
        FROM harness_shared.attention_bulk_run_items
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
    `;
    const awaitingOwner = states.some((i) => i.outcome === 'recommended' || i.outcome === 'pending');
    const phase: BulkRunPhase = awaitingOwner ? 'review' : 'complete';
    const rows = await tx<RawRunRow[]>`
      UPDATE harness_shared.attention_bulk_runs
         SET phase = ${phase},
             resolver_owner = COALESCE(${input.resolverOwner ?? null}, resolver_owner),
             error = NULL,
             finished_at = CASE WHEN ${phase === 'complete'} THEN now() ELSE finished_at END,
             updated_at = now()
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
      RETURNING ${tx.unsafe(RUN_COLUMNS)}
    `;
    return rows[0] ? mapRun(rows[0]) : null;
  });
}
