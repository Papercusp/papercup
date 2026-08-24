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
import type {
  BulkResolverCarryMode,
  LaunchAgentBackend,
  ModelEffort,
} from '../agent-config-constants';

/** Lifecycle of a run. `review` means the agent is done and the owner has
 *  recommendations waiting; `complete` means nothing is left to act on. */
export type BulkRunPhase = 'pending' | 'running' | 'review' | 'complete' | 'failed';

/**
 * What KIND of bulk run this row is (migration 937, cleanup-report-flows P-002).
 * 'inbox-resolve' is the original 912 behavior — membership in the
 * attention_bulk_run_items snapshot. 'plan-cleanup' seeds from `seedRefs` (the
 * plan slugs the Plans pane was rendering at click time) and records outcomes
 * in plan_cleanup_run_findings (plan-cleanup/run-store.ts) instead of the items
 * table. Single-flight is per (workspace, kind): one of EACH may run at once,
 * never two of a kind.
 */
export type BulkRunKind = 'inbox-resolve' | 'plan-cleanup';

export const BULK_RUN_KINDS: readonly BulkRunKind[] = ['inbox-resolve', 'plan-cleanup'] as const;

/** The pre-937 rows' kind, and the default everywhere a caller does not say —
 *  which is what keeps every existing inbox call site's behavior unchanged. */
export const DEFAULT_RUN_KIND: BulkRunKind = 'inbox-resolve';

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
    readonly runKind: BulkRunKind = DEFAULT_RUN_KIND,
  ) {
    super(
      activeRunId
        ? `a ${runKind} bulk run is already active (${activeRunId}, phase ${activePhase ?? 'unknown'})`
        : `a ${runKind} bulk run is already active in this workspace`,
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

/**
 * The effective resolver launch settings AS LAUNCHED, captured once when the run
 * row is created (migration 943).
 *
 * This is deliberately a snapshot rather than a join to the owner's stored
 * per-kind profile: `resolverProfiles` is mutable, so re-reading it would render
 * last week's run with today's defaults — the same drift `filterSnapshot`
 * already prevents for membership.
 *
 * `backend` is the CLI backend derived from `model` at click time. Recording it
 * does not contradict the rule that backend is derived from the model and never
 * a second independently editable truth: that governs the mutable PROFILE, while
 * this row is an immutable record of what actually ran.
 *
 * Every field is optional because a run created before 943 — or by an older
 * deployed release that does not post launch settings — stores `{}`. Readers
 * MUST treat an absent field as "inherit the launcher default", never as an
 * assertion that the run used `null`.
 */
export interface BulkRunLaunchSnapshot {
  model?: string | null;
  effort?: ModelEffort | null;
  account?: string | null;
  carry?: BulkResolverCarryMode | null;
  backend?: LaunchAgentBackend | null;
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
  runKind: BulkRunKind;
  /** Click-time membership snapshot for kinds without an items list — for
   *  'plan-cleanup', the plan slugs the pane was rendering. '[]' for inbox. */
  seedRefs: string[];
  filterSnapshot: BulkRunFilterSnapshot;
  /** Click-time snapshot of the effective launch settings (migration 943).
   *  `{}` for runs created before 943 or by a release that posts no settings. */
  launchSnapshot: BulkRunLaunchSnapshot;
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
  /**
   * Last liveness report from the resolver process owning this run (migration 945).
   *
   * `null` means NEVER REPORTED — a run created before 945, or one that has not begun
   * executing yet. That is deliberately distinguishable from "reported, but long ago":
   * the two warrant different owner-facing language, and collapsing them is exactly the
   * conflation a stored `stale` flag would force. Staleness is DERIVED from this value
   * (see {@link classifyRunLiveness}), never persisted.
   */
  heartbeatAt: string | null;
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

/** seed_refs normalizer — a jsonb string[] (parsed or still-serialized). */
function asStringArray(v: unknown): string[] {
  const arr = Array.isArray(v)
    ? v
    : typeof v === 'string'
      ? (() => {
          try {
            const parsed = JSON.parse(v);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })()
      : [];
  return arr.filter((x): x is string => typeof x === 'string' && x !== '');
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
  run_kind: BulkRunKind | null;
  seed_refs: unknown;
  filter_snapshot: unknown;
  launch_snapshot: unknown;
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
  heartbeat_at: Date | string | null;
}

function mapRun(r: RawRunRow): BulkRunRow {
  return {
    runId: r.run_id,
    workspaceId: r.workspace_id,
    harnessSlug: r.harness_slug,
    requestedBy: r.requested_by,
    resolverOwner: r.resolver_owner,
    phase: r.phase,
    runKind: r.run_kind ?? DEFAULT_RUN_KIND,
    seedRefs: asStringArray(r.seed_refs),
    filterSnapshot: asObject(r.filter_snapshot) as BulkRunFilterSnapshot,
    launchSnapshot: asObject(r.launch_snapshot) as BulkRunLaunchSnapshot,
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
    heartbeatAt: iso(r.heartbeat_at),
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
                     run_kind, seed_refs, filter_snapshot, launch_snapshot,
                     total_items, auto_resolved, recommended, skipped, failed,
                     error, created_at, updated_at, started_at, finished_at, heartbeat_at`;

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
  /** When present, the irreversible action is accepted only from the resolver
   * currently named on the run. Restart rotates that owner before spawning the
   * replacement, so a late prior resolver cannot act on the new generation. */
  resolverOwner?: string | null;
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
    | { reason: 'resolver_owner_mismatch'; phase: BulkRunPhase }
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
    if (input.resolverOwner && run.resolverOwner !== input.resolverOwner) {
      return {
        actionResult: null,
        item: null,
        run,
        refused: { reason: 'resolver_owner_mismatch' as const, phase: run.phase },
      };
    }
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
  /** Which machinery this run rides (migration 937). Defaults to the original
   *  inbox behavior so every existing call site is unchanged. */
  runKind?: BulkRunKind;
  /** REQUIRED for 'plan-cleanup': the click-time membership snapshot (the plan
   *  slugs the pane was rendering). Ignored for 'inbox-resolve', whose
   *  membership is the `items` snapshot. */
  seedRefs?: string[];
  /** The effective launch settings this run was started with (migration 943).
   *  Optional so every existing call site is unchanged: omitting it stores `{}`,
   *  which readers render as "launcher default", exactly as before. */
  launchSnapshot?: BulkRunLaunchSnapshot;
}): Promise<BulkRunRow> {
  const runKind = input.runKind ?? DEFAULT_RUN_KIND;
  const items = input.items ?? [];
  const seedRefs = [...new Set((input.seedRefs ?? []).filter((s) => typeof s === 'string' && s !== ''))];
  // Same "a run over nothing is a caller bug" rule, per kind: an inbox run needs
  // its item snapshot; a plan-cleanup run needs its plan-slug snapshot.
  if (runKind === 'inbox-resolve' && items.length === 0) {
    throw new Error('createRun: refusing to create a bulk run with zero items');
  }
  if (runKind === 'plan-cleanup' && seedRefs.length === 0) {
    throw new Error('createRun: refusing to create a plan-cleanup run with zero seed plan slugs');
  }

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
  const live = await getRunningRun(ws, runKind);
  if (live) throw new BulkRunAlreadyActiveError(live.runId, live.phase, runKind);

  // De-dupe defensively: the client builds this list from a virtualized render,
  // and a duplicate id would violate the (workspace, run, item) key mid-insert
  // and abort the whole seed.
  const seen = new Set<string>();
  const unique = items.filter((i) => {
    if (!i?.itemId || seen.has(i.itemId)) return false;
    seen.add(i.itemId);
    return true;
  });
  if (runKind === 'inbox-resolve' && unique.length === 0) {
    throw new Error('createRun: no valid item ids in the snapshot');
  }
  // total_items: the run's unit count for the strip — items for inbox runs,
  // seed plans for plan-cleanup (its findings accrue during the run and are
  // counted on their own table, plan-cleanup/run-store.ts).
  const totalItems = runKind === 'plan-cleanup' ? seedRefs.length : unique.length;

  let rows: RawRunRow[];
  try {
    // The run row and its complete membership snapshot are one durable unit.
    // If any item seed fails, rolling back the transaction prevents a pending
    // run with a partial manifest from occupying the single-flight slot.
    rows = await sql.begin(async (tx) => {
      const inserted = await tx<RawRunRow[]>`
        INSERT INTO harness_shared.attention_bulk_runs
          (workspace_id, run_id, harness_slug, requested_by, phase, run_kind, seed_refs,
           filter_snapshot, launch_snapshot, total_items)
        VALUES (${ws}, ${runId}, ${input.harnessSlug ?? null}, ${input.requestedBy ?? null},
                'pending', ${runKind}, ${JSON.stringify(seedRefs)}::jsonb,
                ${JSON.stringify(input.filterSnapshot ?? {})}::jsonb,
                ${JSON.stringify(input.launchSnapshot ?? {})}::jsonb, ${totalItems})
        RETURNING ${tx.unsafe(RUN_COLUMNS)}
      `;

      for (let i = 0; i < unique.length; i += 1) {
        const it = unique[i]!;
        await tx`
          INSERT INTO harness_shared.attention_bulk_run_items
            (workspace_id, run_id, item_id, position, item_kind, item_title, item_ref, owner_agent_id, outcome)
          VALUES (${ws}, ${runId}, ${it.itemId}, ${i}, ${it.kind ?? null}, ${it.title ?? null},
                  ${JSON.stringify(it.ref ?? {})}::jsonb, ${it.ownerAgentId ?? null}, 'pending')
          ON CONFLICT (workspace_id, run_id, item_id) DO NOTHING
        `;
      }

      return inserted;
    });
  } catch (e) {
    // The rail firing (migration 916→937) means a concurrent start won the race
    // between our check above and this insert. Re-read and report it as the
    // SAME typed refusal, so the caller cannot tell the two paths apart and a
    // race never surfaces to the owner as a 500.
    if (isSingleFlightViolation(e)) {
      const live = await getRunningRun(ws, runKind);
      throw new BulkRunAlreadyActiveError(live?.runId ?? null, live?.phase ?? null, runKind);
    }
    throw e;
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
export async function getLatestRun(
  workspaceId?: string,
  kind: BulkRunKind | null = DEFAULT_RUN_KIND,
): Promise<BulkRunRow | null> {
  const { sql } = getOrgPg();
  const ws = workspaceId ?? activeWorkspaceId();
  const rows = await sql<RawRunRow[]>`
    SELECT ${sql.unsafe(RUN_COLUMNS)}
      FROM harness_shared.attention_bulk_runs
     WHERE workspace_id = ${ws}
       AND (${kind ?? null}::text IS NULL OR run_kind = ${kind ?? null})
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
export async function getRunningRun(
  workspaceId?: string,
  kind: BulkRunKind | null = DEFAULT_RUN_KIND,
): Promise<BulkRunRow | null> {
  const { sql } = getOrgPg();
  const ws = workspaceId ?? activeWorkspaceId();
  const rows = await sql<RawRunRow[]>`
    SELECT ${sql.unsafe(RUN_COLUMNS)}
      FROM harness_shared.attention_bulk_runs
     WHERE workspace_id = ${ws} AND phase IN ('pending', 'running')
       AND (${kind ?? null}::text IS NULL OR run_kind = ${kind ?? null})
     ORDER BY created_at DESC
     LIMIT 1
  `;
  return rows[0] ? mapRun(rows[0]) : null;
}

export async function getActiveRun(
  workspaceId?: string,
  kind: BulkRunKind | null = DEFAULT_RUN_KIND,
): Promise<BulkRunRow | null> {
  const { sql } = getOrgPg();
  const ws = workspaceId ?? activeWorkspaceId();
  const rows = await sql<RawRunRow[]>`
    SELECT ${sql.unsafe(RUN_COLUMNS)}
      FROM harness_shared.attention_bulk_runs
     WHERE workspace_id = ${ws} AND phase IN ('pending', 'running', 'review')
       AND (${kind ?? null}::text IS NULL OR run_kind = ${kind ?? null})
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
           resolver_owner = COALESCE(resolver_owner, ${input.resolverOwner ?? null}),
           error = ${input.error.slice(0, 4000)},
           finished_at = now(),
           updated_at = now()
     WHERE workspace_id = ${ws}
       AND run_id = ${input.runId}
       AND phase IN ('pending', 'running')
       AND (${input.resolverOwner ?? null}::text IS NULL
            OR resolver_owner IS NULL
            OR resolver_owner = ${input.resolverOwner ?? null})
    RETURNING ${sql.unsafe(RUN_COLUMNS)}
  `;
  return rows[0] ? mapRun(rows[0]) : null;
}

/**
 * How long a run may go without evidence of life before it reads as stale.
 *
 * Deliberately generous relative to any sane heartbeat cadence: the cost of calling a
 * working resolver stale (an owner restarts a run that was fine, losing in-flight work)
 * is far higher than the cost of noticing a dead one a minute later.
 */
export const RUN_HEARTBEAT_STALE_MS = 5 * 60_000;

export type RunLiveness =
  /** Terminal, or `review` — the run is not executing, so liveness is not a question. */
  | { state: 'not-executing'; phase: BulkRunPhase }
  /** Executing and reporting. */
  | { state: 'live'; ageMs: number; measuredFrom: 'heartbeat' }
  /** Executing, but nothing has reported for longer than the threshold. */
  | { state: 'stale'; ageMs: number; measuredFrom: 'heartbeat' | 'start' };

/**
 * DERIVE whether an executing run is still alive. Never stored — see migration 945.
 *
 * ⚠ The subtlety worth keeping: staleness is measured from the last EVIDENCE OF LIFE,
 * which is `heartbeat_at` when the resolver has reported and the run's own start time
 * when it has not. Measuring a never-reported run from `heartbeat_at` alone would make
 * it either permanently stale (NULL reads as infinitely old) or permanently live (NULL
 * skipped) — the first restarts a run that launched two seconds ago and has not had a
 * chance to beat yet, the second never notices a resolver that died before its first
 * heartbeat. Both are real failures; COALESCE across the two is what avoids each.
 *
 * `measuredFrom` is reported rather than inferred so a caller (and an owner-facing
 * diagnostic) can say "never reported since launch" instead of the much weaker "stale",
 * which is the distinction the nullable column exists to preserve.
 */
export function classifyRunLiveness(
  run: Pick<BulkRunRow, 'phase' | 'heartbeatAt' | 'startedAt' | 'createdAt'>,
  nowMs: number = Date.now(),
  staleAfterMs: number = RUN_HEARTBEAT_STALE_MS,
): RunLiveness {
  if (!RUNNING_PHASES.includes(run.phase)) return { state: 'not-executing', phase: run.phase };

  const measuredFrom = run.heartbeatAt ? 'heartbeat' : 'start';
  const since = run.heartbeatAt ?? run.startedAt ?? run.createdAt;
  // No timestamp at all is not something a live row can produce (created_at is NOT
  // NULL); treat it as stale rather than inventing liveness we cannot evidence.
  if (!since) return { state: 'stale', ageMs: Number.POSITIVE_INFINITY, measuredFrom };

  const ageMs = nowMs - Date.parse(since);
  if (!Number.isFinite(ageMs)) return { state: 'stale', ageMs: Number.POSITIVE_INFINITY, measuredFrom };
  return ageMs > staleAfterMs
    ? { state: 'stale', ageMs, measuredFrom }
    : { state: 'live', ageMs, measuredFrom: 'heartbeat' };
}

/**
 * Record that the resolver owning this run is alive.
 *
 * Conditional on an EXECUTING phase, exactly like {@link failRunIfExecuting}: a
 * heartbeat arriving after the owner pressed Stop, or after the run settled, must not
 * resurrect any part of it. Returns `null` when it did not apply, which is the signal
 * the caller should stop — it means the run is no longer theirs.
 *
 * ⚠ Deliberately does NOT touch `updated_at`. A heartbeat is liveness, not a state
 * change, and `updated_at` is what readers key on to decide something happened; bumping
 * it every cadence would turn a silent keep-alive into a steady stream of spurious
 * "this run changed" signals through the sync layer.
 */
export async function recordRunHeartbeat(input: {
  runId: string;
  resolverOwner?: string | null;
  workspaceId?: string;
}): Promise<BulkRunRow | null> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();
  const rows = await sql<RawRunRow[]>`
    UPDATE harness_shared.attention_bulk_runs
       SET heartbeat_at = now(),
           resolver_owner = COALESCE(resolver_owner, ${input.resolverOwner ?? null})
     WHERE workspace_id = ${ws}
       AND run_id = ${input.runId}
       AND phase IN ('pending', 'running')
       AND (${input.resolverOwner ?? null}::text IS NULL
            OR resolver_owner IS NULL
            OR resolver_owner = ${input.resolverOwner ?? null})
    RETURNING ${sql.unsafe(RUN_COLUMNS)}
  `;
  return rows[0] ? mapRun(rows[0]) : null;
}

export type RestartRunResult =
  | { ok: true; run: BulkRunRow; preservedOutcomes: number }
  | { ok: false; reason: 'run_not_found' | 'not_restartable'; phase: BulkRunPhase | null };

/**
 * Hand a stranded run to a fresh resolver WITHOUT losing what the previous one achieved.
 *
 * Three guarantees, each of which is a way this could go wrong:
 *
 * 1. ONLY a stale-executing or failed run is restartable. A healthy executing run is
 *    refused — restarting one would race a resolver that is still working and produce
 *    two agents acting on the same items. The staleness test lives INSIDE the UPDATE's
 *    WHERE clause rather than in a preceding read, so a resolver that beats between a
 *    check and a write wins the race and the restart cleanly does nothing.
 * 2. COMPLETED OUTCOMES ARE NEVER RESET. This function does not write to
 *    `attention_bulk_run_items` at all. Counters are recomputed from the surviving item
 *    rows by {@link reportCountersOnly}, so already-resolved items stay resolved and
 *    stay counted; only `outcome = 'pending'` items are left for the new resolver.
 * 3. MEMBERSHIP IS NEVER WIDENED — for the same reason `reportOutcomes` ignores unknown
 *    item ids: the run must keep acting on exactly what the owner saw when they clicked.
 *
 * The launch settings are NOT re-derived from current defaults: `launch_snapshot` stays
 * on the row untouched (D-003), so the restarted run relaunches with the owner's
 * click-time configuration rather than whatever the defaults happen to be now.
 */
export async function restartRun(input: {
  runId: string;
  resolverOwner?: string | null;
  workspaceId?: string;
  staleAfterMs?: number;
}): Promise<RestartRunResult> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();
  const staleSecs = Math.max(0, input.staleAfterMs ?? RUN_HEARTBEAT_STALE_MS) / 1000;

  const rows = await sql<RawRunRow[]>`
    UPDATE harness_shared.attention_bulk_runs
       SET phase = 'pending',
           resolver_owner = ${input.resolverOwner ?? null},
           error = NULL,
           finished_at = NULL,
           heartbeat_at = NULL,
           updated_at = now()
     WHERE workspace_id = ${ws}
       AND run_id = ${input.runId}
       AND (
             phase = 'failed'
             OR (
                  phase IN ('pending', 'running')
                  -- last evidence of life: the heartbeat, else when the run started.
                  -- Same COALESCE as classifyRunLiveness, and it must stay in step.
                  AND COALESCE(heartbeat_at, started_at, created_at)
                        < now() - make_interval(secs => ${staleSecs})
                )
           )
    RETURNING ${sql.unsafe(RUN_COLUMNS)}
  `;

  if (!rows[0]) {
    // Distinguish "no such run" from "refused because it is healthy" — an owner-facing
    // diagnostic must not report a live run as missing.
    const current = await getRun(input.runId, ws);
    return current
      ? { ok: false, reason: 'not_restartable', phase: current.phase }
      : { ok: false, reason: 'run_not_found', phase: null };
  }

  // Counters are DERIVED from the surviving item rows, so this both preserves completed
  // outcomes and re-states them correctly on the restarted run.
  await reportCountersOnly(input.runId, ws);
  const refreshed = (await getRun(input.runId, ws)) ?? mapRun(rows[0]);
  const items = await getRunItems(input.runId, ws);
  return {
    ok: true,
    run: refreshed,
    preservedOutcomes: items.filter((i) => i.outcome !== 'pending').length,
  };
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
  resolverOwner?: string | null;
  workspaceId?: string;
}): Promise<{
  updated: string[];
  unknown: string[];
  run: BulkRunRow | null;
  refused:
    | { reason: 'run_not_accepting_reports'; phase: BulkRunPhase | null }
    | { reason: 'resolver_owner_mismatch'; phase: BulkRunPhase }
    | null;
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
    if (before && input.resolverOwner && before.resolverOwner !== input.resolverOwner) {
      return {
        updated: [],
        unknown: (input.outcomes ?? []).map((o) => o?.itemId).filter((id): id is string => !!id),
        run: before,
        refused: { reason: 'resolver_owner_mismatch' as const, phase: before.phase },
      };
    }
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
    const lockedRun = mapRun(locked[0]);
    if (input.resolverOwner && lockedRun.resolverOwner !== input.resolverOwner) {
      return null;
    }
    // Kind-aware "is anything still waiting on the OWNER?": inbox runs derive
    // from their item rows; plan-cleanup runs from their findings rows
    // (migration 937 — same recommended/pending semantics, different table).
    const runKind = locked[0].run_kind ?? DEFAULT_RUN_KIND;
    const states =
      runKind === 'plan-cleanup'
        ? await tx<{ outcome: string }[]>`
            SELECT outcome
              FROM harness_shared.plan_cleanup_run_findings
             WHERE workspace_id = ${ws} AND run_id = ${input.runId}
          `
        : await tx<{ outcome: string }[]>`
            SELECT outcome
              FROM harness_shared.attention_bulk_run_items
             WHERE workspace_id = ${ws} AND run_id = ${input.runId}
          `;
    const awaitingOwner = states.some((i) => i.outcome === 'recommended' || i.outcome === 'pending');
    const phase: BulkRunPhase = awaitingOwner ? 'review' : 'complete';
    const rows = await tx<RawRunRow[]>`
      UPDATE harness_shared.attention_bulk_runs
         SET phase = ${phase},
             resolver_owner = COALESCE(resolver_owner, ${input.resolverOwner ?? null}),
             error = NULL,
             finished_at = CASE WHEN ${phase === 'complete'} THEN now() ELSE finished_at END,
             updated_at = now()
       WHERE workspace_id = ${ws} AND run_id = ${input.runId}
      RETURNING ${tx.unsafe(RUN_COLUMNS)}
    `;
    return rows[0] ? mapRun(rows[0]) : null;
  });
}
