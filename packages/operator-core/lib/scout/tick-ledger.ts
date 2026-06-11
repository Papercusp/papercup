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
       ${input.budgetUsedUsd ?? null}, ${JSON.stringify(input.detail ?? null)}::text::jsonb)`;
  // Push the Learning tab's Scout view (learning.scout shows the last tick).
  // Fire-and-forget via a lazy import so the PG seam (+ its tests) never
  // statically depends on the SSE layer; a missing SSE bus is a no-op.
  void import('../sync-sse')
    .then((m) => m.notifySyncInvalidate('learning.scout'))
    .catch(() => {});
}

/**
 * One tick row read back from the ledger — the camelCase mirror of the
 * migration-208 columns. Extends {@link ScoutTickRecord} so a read row IS a
 * valid pure-core tick snapshot (quality-metrics consumes exactly this shape).
 */
export interface ScoutTickRow extends ScoutTickRecord {
  /** The harness the tick ran for, when recorded. */
  installSlug?: string;
  /** ISO timestamp of the tick. */
  tickAt: string;
}

/** Read scope for {@link readScoutTicks}. */
export interface ReadScoutTicksOpts {
  /** Override the active workspace (tests). */
  workspaceId?: string;
  /** Filter to one harness's ticks. */
  installSlug?: string;
  /** Max rows, newest-first. Default 500 — the standing-quality window. */
  limit?: number;
}

interface TickRow {
  install_slug: string | null;
  tick_at: string | Date;
  status: string;
  gate: string | null;
  ideas_generated: number | null;
  ideas_routed: number | null;
  ideas_deduped: number | null;
  budget_used_usd: string | number | null;
  detail: Record<string, unknown> | null;
}

/**
 * Read the last N tick rows (newest-first) for a workspace — the read seam the
 * Scout standing quality-metrics module (quality-metrics.ts) snapshots its tick
 * window from. Mirrors {@link readRoutedIdeas} in routed-ledger.ts: thin SQL,
 * camelCase mapping, no derivation (the pure math lives in quality-metrics.ts).
 */
export async function readScoutTicks(opts: ReadScoutTicksOpts = {}): Promise<ScoutTickRow[]> {
  const { sql } = getOrgPg();
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const limit = opts.limit ?? 500;
  const rows = await sql<TickRow[]>`
    SELECT install_slug, tick_at, status, gate, ideas_generated, ideas_routed,
           ideas_deduped, budget_used_usd, detail
      FROM harness_shared.scout_ticks
     WHERE workspace_id = ${ws}
       ${opts.installSlug ? sql`AND install_slug = ${opts.installSlug}` : sql``}
     ORDER BY tick_at DESC
     LIMIT ${limit}`;
  return rows.map((r) => {
    const spend = r.budget_used_usd == null ? null : Number(r.budget_used_usd);
    return {
      status: r.status as ScoutTickStatus,
      ...(r.gate ? { gate: r.gate } : {}),
      ideasGenerated: r.ideas_generated ?? 0,
      ideasRouted: r.ideas_routed ?? 0,
      ideasDeduped: r.ideas_deduped ?? 0,
      ...(spend != null && Number.isFinite(spend) ? { budgetUsedUsd: spend } : {}),
      ...(r.detail && typeof r.detail === 'object' ? { detail: r.detail } : {}),
      ...(r.install_slug ? { installSlug: r.install_slug } : {}),
      tickAt: r.tick_at instanceof Date ? r.tick_at.toISOString() : new Date(r.tick_at).toISOString(),
    };
  });
}
