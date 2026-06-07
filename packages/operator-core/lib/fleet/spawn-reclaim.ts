/**
 * fleet/spawn-reclaim — reclaim orphaned `spawned_agents` rows
 * (unify-agent-spawn-chokepoint-2026-06-06, P-011).
 *
 * A 'running'/'restarting' nursery row whose launching operator host died was
 * never reclaimed — it counted forever against the global concurrency ceiling
 * (the `operator-spawn.ts` "lease/timeout reclaims them" comment was aspirational;
 * no such mechanism existed). The live host now heartbeats `heartbeat_at` for its
 * own in-flight spawns (`heartbeatSpawns`); a row whose heartbeat goes stale
 * beyond `RECLAIM_STALE_MS` is presumed orphaned (host dead) and reclaimed to
 * 'failed' (`reclaimOrphanedSpawns`), freeing the ceiling.
 *
 * This is the deterministic SAFETY-floor half of the spawn chokepoint
 * (Phase 2 / durability-by-class): fail-loud + free. Re-running an autonomous
 * spawn idempotently on crash is the durable-spawn-wrapper's job (P-010); this
 * sweep only un-wedges the concurrency ceiling.
 *
 * Migration 174 adds `heartbeat_at` + the partial sweep index.
 */
import type { Sql, TransactionSql } from 'postgres';

/** A query handle — a pooled client or an open transaction. */
type Db = Sql | TransactionSql;

/** Cadence the live host bumps `heartbeat_at` for its in-flight spawns. */
export const SPAWN_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * A running row un-heartbeated for longer than this is presumed orphaned
 * (launching host dead). Generously larger than the heartbeat interval so a
 * live spawn whose host was briefly paused (GC, restart-in-progress) is not
 * reclaimed out from under itself.
 */
export const RECLAIM_STALE_MS = 5 * 60_000;

/** Bump `heartbeat_at` for the given live spawnIds (only while still active). */
export async function heartbeatSpawns(sql: Db, spawnIds: string[]): Promise<void> {
  if (spawnIds.length === 0) return;
  await sql`
    UPDATE harness_shared.spawned_agents
       SET heartbeat_at = now()
     WHERE spawn_id = ANY(${spawnIds}::text[])
       AND status IN ('running', 'restarting')`;
}

export interface ReclaimResult {
  reclaimed: number;
  spawnIds: string[];
  /** Distinct workspaces whose ceiling the reclaim freed slots in — callers
   *  announce `spawn-slot:freed:<ws>` per entry so over-ceiling waiters wake
   *  (D-004 queue+await; the announce lives at the call sites, this module
   *  stays a pure sql unit). */
  workspaces: string[];
}

/**
 * Reclaim active rows whose heartbeat went stale (host presumed dead): flip to
 * 'failed' with a clear reason + a terminal `finished_at`/`duration_ms`, freeing
 * the concurrency ceiling. Workspace-agnostic — one sweep covers every workspace
 * on the org PG. Idempotent (a row already terminal is skipped). Best-effort:
 * callers swallow errors (a missed sweep just defers the reclaim to the next one
 * or to the opportunistic reclaim on the next spawn).
 */
export async function reclaimOrphanedSpawns(
  sql: Db,
  opts: { staleMs?: number } = {},
): Promise<ReclaimResult> {
  const staleSec = Math.max(1, Math.round((opts.staleMs ?? RECLAIM_STALE_MS) / 1000));
  const rows = await sql<{ spawn_id: string; workspace_id: string }[]>`
    UPDATE harness_shared.spawned_agents
       SET status = 'failed',
           finished_at = now(),
           duration_ms = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::bigint,
           error_message = COALESCE(
             error_message,
             'reclaimed: spawn heartbeat stale > ' || ${staleSec}::text
               || 's (launching operator host presumed dead) — concurrency ceiling freed by the P-011 reclaim sweep'
           )
     WHERE status IN ('running', 'restarting')
       AND heartbeat_at < now() - ${staleSec}::int * interval '1 second'
    RETURNING spawn_id, workspace_id`;
  return {
    reclaimed: rows.length,
    spawnIds: rows.map((r) => r.spawn_id),
    workspaces: [...new Set(rows.map((r) => r.workspace_id).filter(Boolean))],
  };
}
