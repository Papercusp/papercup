/**
 * Learning-governor STORE (self-learning-frontier-2026-06-12 P-003 / FB-01) —
 * SQL over migration 244 (harness_shared.learning_governor_loops +
 * learning_spend_events). Helpers take an injected `Sql` (the live operator
 * admin pool), control-plane style, so the routine-action glue and tests share
 * one core; SQL is covered by store.integration.test.ts, decisions by the pure
 * core (core.ts).
 *
 * The two write modes registrants use:
 *   - register: upsert preserving omitted fields (setAutoloop semantics) —
 *     spent_usd is PRESERVED unless explicitly passed (mirror mode overwrites
 *     it from the loop's own source of truth, e.g. gym_autoloop_config).
 *   - recordLearningSpend: append one ledger event; accumulate:true (default)
 *     also bumps the registration's spent_usd atomically — the path for loops
 *     whose ONLY spend store is the governor (scout, every frontier loop).
 *     accumulate:false ledgers the event only (gym: the row's spent mirrors
 *     gym_autoloop_config, so accumulating here would double-count).
 */
import type { Sql, TransactionSql } from 'postgres';
import {
  checkLoopVerdict,
  LEARNING_GOVERNOR_BUDGET_FLOOR_USD,
  type GovernorVerdict,
  type LearningBudgetKind,
  type LearningEnforcement,
  type LearningLoopRegistration,
} from './core';

type Row = Record<string, unknown>;
const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const ts = (v: unknown): number => new Date(v as string | Date).getTime();

function mapLoop(r: Row): LearningLoopRegistration {
  return {
    workspaceId: str(r.workspace_id),
    loopId: str(r.loop_id),
    displayName: str(r.display_name),
    budgetKind: str(r.budget_kind) as LearningBudgetKind,
    budgetUsd: numOrNull(r.budget_usd),
    spentUsd: Number(r.spent_usd ?? 0),
    priority: Number(r.priority ?? 100),
    enabled: r.enabled === true || r.enabled === 't',
    enforcement: str(r.enforcement) as LearningEnforcement,
    meta: (r.meta as Record<string, unknown> | null) ?? null,
    registeredAt: ts(r.registered_at),
    updatedAt: ts(r.updated_at),
  };
}

export interface LearningSpendEvent {
  id: string;
  workspaceId: string;
  loopId: string;
  costUsd: number;
  signalOrigin: string;
  runRef: string | null;
  note: string | null;
  createdAt: number;
}

function mapEvent(r: Row): LearningSpendEvent {
  return {
    id: str(r.id),
    workspaceId: str(r.workspace_id),
    loopId: str(r.loop_id),
    costUsd: Number(r.cost_usd),
    signalOrigin: str(r.signal_origin),
    runRef: strOrNull(r.run_ref),
    note: strOrNull(r.note),
    createdAt: ts(r.created_at),
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface RegisterLearningLoopInput {
  workspaceId: string;
  loopId: string;
  /** Defaults to loopId on first registration; preserved when omitted thereafter. */
  displayName?: string;
  budgetKind?: LearningBudgetKind;
  /** number sets a cap; null clears it (⇒ refuses unattended); undefined preserves. */
  budgetUsd?: number | null;
  /** Mirror mode: overwrite spent from the loop's own source of truth. Omitted = preserved. */
  spentUsd?: number;
  priority?: number;
  enabled?: boolean;
  enforcement?: LearningEnforcement;
  meta?: Record<string, unknown> | null;
}

/** Upsert a loop registration; omitted fields are preserved (setAutoloop semantics). */
export async function registerLearningLoop(
  sql: Sql,
  q: RegisterLearningLoopInput,
): Promise<LearningLoopRegistration> {
  const existing = await getLearningLoop(sql, { workspaceId: q.workspaceId, loopId: q.loopId });
  const merged = {
    workspaceId: q.workspaceId,
    loopId: q.loopId,
    displayName: q.displayName ?? existing?.displayName ?? q.loopId,
    budgetKind: q.budgetKind ?? existing?.budgetKind ?? 'lifetime',
    budgetUsd: q.budgetUsd !== undefined ? q.budgetUsd : existing?.budgetUsd ?? null,
    spentUsd: q.spentUsd ?? existing?.spentUsd ?? 0,
    priority: q.priority ?? existing?.priority ?? 100,
    enabled: q.enabled ?? existing?.enabled ?? true,
    enforcement: q.enforcement ?? existing?.enforcement ?? 'governor',
    meta: q.meta !== undefined ? q.meta : existing?.meta ?? null,
  };
  const rows = (await sql`
    INSERT INTO harness_shared.learning_governor_loops
      (workspace_id, loop_id, display_name, budget_kind, budget_usd, spent_usd, priority, enabled, enforcement, meta)
    VALUES (${merged.workspaceId}, ${merged.loopId}, ${merged.displayName}, ${merged.budgetKind}, ${merged.budgetUsd},
      ${merged.spentUsd}, ${merged.priority}, ${merged.enabled}, ${merged.enforcement}, ${merged.meta as never})
    ON CONFLICT (workspace_id, loop_id) DO UPDATE SET
      display_name = EXCLUDED.display_name, budget_kind = EXCLUDED.budget_kind, budget_usd = EXCLUDED.budget_usd,
      spent_usd = EXCLUDED.spent_usd, priority = EXCLUDED.priority, enabled = EXCLUDED.enabled,
      enforcement = EXCLUDED.enforcement, meta = EXCLUDED.meta, updated_at = now()
    RETURNING *`) as Row[];
  return mapLoop(rows[0]);
}

export async function getLearningLoop(
  sql: Sql,
  q: { workspaceId: string; loopId: string },
): Promise<LearningLoopRegistration | null> {
  const rows = (await sql`
    SELECT * FROM harness_shared.learning_governor_loops
     WHERE workspace_id = ${q.workspaceId} AND loop_id = ${q.loopId} LIMIT 1`) as Row[];
  return rows.length ? mapLoop(rows[0]) : null;
}

/** Every registered loop in the workspace, priority order (the ledger view + summarize input). */
export async function listLearningLoops(
  sql: Sql,
  q: { workspaceId: string },
): Promise<LearningLoopRegistration[]> {
  const rows = (await sql`
    SELECT * FROM harness_shared.learning_governor_loops
     WHERE workspace_id = ${q.workspaceId}
     ORDER BY priority ASC, loop_id ASC`) as Row[];
  return rows.map(mapLoop);
}

/**
 * Deregister a loop — drop its registration row (the lifecycle inverse of
 * registerLearningLoop). Used by pot:dissolve to remove the per-hive
 * `gym:<hive>` / `scout:<hive>` registrants so a dissolved hive's loop leaves no
 * stranded governor row. Idempotent (a missing row is a no-op); returns whether
 * a row was deleted. The spend-event ledger is left as the durable audit trail.
 */
export async function deleteLearningLoop(
  sql: Sql,
  q: { workspaceId: string; loopId: string },
): Promise<{ deleted: boolean }> {
  const rows = (await sql`
    DELETE FROM harness_shared.learning_governor_loops
     WHERE workspace_id = ${q.workspaceId} AND loop_id = ${q.loopId}
     RETURNING loop_id`) as Row[];
  return { deleted: rows.length > 0 };
}

/**
 * THE unattended-refusal check (D-004): look up the registration and apply the
 * generalized gym rule. Frontier loops call the flag-aware wrapper
 * (registrants.ts learningGovernorPreflight) — this is the PG-level core.
 */
export async function governorCheck(
  sql: Sql,
  q: { workspaceId: string; loopId: string; floorUsd?: number },
): Promise<GovernorVerdict> {
  const reg = await getLearningLoop(sql, { workspaceId: q.workspaceId, loopId: q.loopId });
  return checkLoopVerdict(reg, q.floorUsd ?? LEARNING_GOVERNOR_BUDGET_FLOOR_USD);
}

// ---------------------------------------------------------------------------
// Spend ledger
// ---------------------------------------------------------------------------

export interface RecordLearningSpendInput {
  workspaceId: string;
  loopId: string;
  costUsd: number;
  /** Provenance (P-002/D-002 vocabulary). Default 'organic'. */
  signalOrigin?: 'organic' | 'drill' | 'replay' | 'shadow';
  runRef?: string | null;
  note?: string | null;
  /**
   * true (default): also bump the registration's spent_usd — the path for
   * loops whose only spend store is the governor. false: ledger the event
   * only (mirror-mode loops whose row spent syncs from their own store).
   */
  accumulate?: boolean;
}

/** Append one spend event (+ optionally accumulate onto the registration row, atomically). */
export async function recordLearningSpend(sql: Sql, q: RecordLearningSpendInput): Promise<LearningSpendEvent> {
  if (!Number.isFinite(q.costUsd) || q.costUsd < 0) {
    throw new Error(`learning-governor: costUsd must be a non-negative finite number, got ${q.costUsd}`);
  }
  const run = async (tx: Sql | TransactionSql): Promise<LearningSpendEvent> => {
    const rows = (await tx`
      INSERT INTO harness_shared.learning_spend_events
        (workspace_id, loop_id, cost_usd, signal_origin, run_ref, note)
      VALUES (${q.workspaceId}, ${q.loopId}, ${q.costUsd}, ${q.signalOrigin ?? 'organic'},
        ${q.runRef ?? null}, ${q.note ?? null})
      RETURNING *`) as Row[];
    if (q.accumulate !== false) {
      await tx`
        UPDATE harness_shared.learning_governor_loops
           SET spent_usd = spent_usd + ${q.costUsd}, updated_at = now()
         WHERE workspace_id = ${q.workspaceId} AND loop_id = ${q.loopId}`;
    }
    return mapEvent(rows[0]);
  };
  // Event + accumulate must land together. Open our own transaction when handed a
  // top-level client; inside a caller's TransactionSql (no `.begin`) run directly.
  const begin = (sql as unknown as { begin?: unknown }).begin;
  return typeof begin === 'function' ? ((await sql.begin(run)) as LearningSpendEvent) : run(sql);
}

export async function listLearningSpendEvents(
  sql: Sql,
  q: { workspaceId: string; loopId?: string; limit?: number },
): Promise<LearningSpendEvent[]> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
  const rows = (await sql`
    SELECT * FROM harness_shared.learning_spend_events
     WHERE workspace_id = ${q.workspaceId}
       ${q.loopId ? sql`AND loop_id = ${q.loopId}` : sql``}
     ORDER BY created_at DESC
     LIMIT ${limit}`) as Row[];
  return rows.map(mapEvent);
}
