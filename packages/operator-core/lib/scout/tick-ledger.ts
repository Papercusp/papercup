/**
 * tick-ledger.ts — Scout tick observability (learning-system-audit-improvements
 * P-034): the thin PG seam over `harness_shared.scout_ticks` (migration 208).
 *
 * The `scout-cycle` routine ticks frequently and SELF-GATES (idle-capacity /
 * friction cadence → autoloop circuit → budget), so the common tick is a silent
 * no-op — before this ledger there was no durable record of WHY each tick
 * withheld, and an always-gated Scout was indistinguishable from a dead one.
 * One row per tick, mirroring `watchdog_ticks` (migration 202): `gated` rows
 * name the self-gate that stopped the tick; `ran` rows carry the cycle's
 * generated/routed/deduped counts + spend; `error` rows carry the failure.
 *
 * Best-effort by contract: the scheduler swallows recording failures
 * (observability must never fail the tick). The recorder is injected into
 * {@link ScoutTickDeps.recordTick} so the tick composition unit-tests with a
 * fake (the watchdog recordTick pattern); THIS module is the production PG
 * edge, using the same access pattern as routed-ledger.ts.
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';

/** Why a tick ended: a full cycle ran, a self-gate withheld it, or the cycle threw. */
export type ScoutTickStatus = 'ran' | 'gated' | 'error';

/**
 * One tick's outcome, as the scheduler reports it (pure data — no PG types).
 * `gate` names the self-gate that stopped a 'gated' tick:
 * 'min-interval' | 'no-trigger' (cadence) | 'circuit' (autoloop fire-gate).
 */
export interface ScoutTickRecord {
  status: ScoutTickStatus;
  gate?: string;
  /** Ideas the ideators produced (full cycle only). */
  ideasGenerated?: number;
  /** Routed-idea provenance rows persisted (full cycle only). */
  ideasRouted?: number;
  /** Ideas the critics pruned — scored − survivors (full cycle only). */
  ideasDeduped?: number;
  /** LLM spend of the cycle (USD); omitted when no cycle ran. */
  budgetUsedUsd?: number;
  /** Free-form extras: { reason, cycleId, stop, retryAfterSec, error, ... }. */
  detail?: Record<string, unknown>;
}

export interface RecordScoutTickInput extends ScoutTickRecord {
  /** The harness the tick ran for (the routine's install slug). */
  installSlug?: string;
  /** Override the active workspace (tests). */
  workspaceId?: string;
}

/** Persist one tick row. Callers treat this as best-effort (errors swallowed upstream). */
export async function recordScoutTick(input: RecordScoutTickInput): Promise<void> {
  const { sql } = getOrgPg();
  const ws = input.workspaceId ?? activeWorkspaceId();
  await sql`
    INSERT INTO harness_shared.scout_ticks
      (workspace_id, install_slug, status, gate,
       ideas_generated, ideas_routed, ideas_deduped, budget_used_usd, detail)
    VALUES
      (${ws}, ${input.installSlug ?? null}, ${input.status}, ${input.gate ?? null},
       ${input.ideasGenerated ?? 0}, ${input.ideasRouted ?? 0}, ${input.ideasDeduped ?? 0},
       ${input.budgetUsedUsd ?? null}, ${sql.json(input.detail ?? null)})`;
}
