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
 * EI-108: When reclaiming a spawn with a parent, also wake the parent.
 */
import { hostname } from 'node:os';
import { readFileSync } from 'node:fs';
import type { Sql, TransactionSql } from 'postgres';
import { wakeParentOnChildDeath } from './parent-wake';

/** A query handle — a pooled client or an open transaction. */
type Db = Sql | TransactionSql;

/** Cadence the live host bumps `heartbeat_at` for its in-flight spawns. */
export const SPAWN_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Record the child OS pid + this launcher host on a nursery row (EI-85). The
 * reclaim sweep uses these to /proc-liveness-check a stale-heartbeat row on the
 * SAME host before reclaiming it — so a child that is actually still alive (its
 * launching host was only briefly paused, not dead) is not reclaimed out from
 * under itself, and a dead one is reclaimed with an accurate reason. Best-effort.
 */
export async function recordSpawnPid(sql: Db, spawnId: string, pid: number): Promise<void> {
  await sql`
    UPDATE harness_shared.spawned_agents
       SET pid = ${pid}, launcher_host = ${hostname()}
     WHERE spawn_id = ${spawnId} AND status IN ('running', 'restarting')`;
}

/**
 * Is the recorded child process still alive on THIS host (EI-85)? Linux /proc
 * check, hardened against PID reuse: the pid must exist AND its cmdline must
 * name the invoke-once entrypoint (a reused pid running something else reads as
 * dead). Returns false on any non-Linux / unreadable case, so the caller falls
 * back to the heartbeat-stale reclaim — never a false "alive" that strands a
 * ceiling slot.
 */
export function isSpawnProcessAlive(pid: number): boolean {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 1) return false;
  try {
    // cmdline is NUL-separated; the spawn is `node <tsx> .../invoke-once(.ts|.mjs)`.
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmdline.includes('invoke-once');
  } catch {
    return false; // /proc/<pid> gone (dead) or unreadable → treat as dead
  }
}

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
  opts: { staleMs?: number; isAlive?: (pid: number) => boolean } = {},
): Promise<ReclaimResult> {
  const staleSec = Math.max(1, Math.round((opts.staleMs ?? RECLAIM_STALE_MS) / 1000));
  const isAlive = opts.isAlive ?? isSpawnProcessAlive; // injectable for tests

  // EI-85: a stale heartbeat no longer blindly reclaims. First gather the
  // candidates with their recorded pid + launcher host; a candidate that is
  // SAME-HOST and whose child process is still alive (/proc) is NOT reclaimed —
  // its host was only briefly paused, the child survived (e.g. spawned into its
  // own systemd scope). Such rows get their heartbeat bumped so this host keeps
  // them fresh. Everything else (child confirmed dead, no pid, or a different
  // host we can't liveness-check) is reclaimed — with a reason that says which.
  const candidates = await sql<
    { spawn_id: string; workspace_id: string; pid: number | null; launcher_host: string | null }[]
  >`
    SELECT spawn_id, workspace_id, pid, launcher_host
      FROM harness_shared.spawned_agents
     WHERE status IN ('running', 'restarting')
       AND heartbeat_at < now() - ${staleSec}::int * interval '1 second'`;
  if (candidates.length === 0) {
    return { reclaimed: 0, spawnIds: [], workspaces: [] };
  }

  const me = hostname();
  const alive: string[] = [];
  const deadChild: string[] = [];
  const hostGone: string[] = [];
  for (const c of candidates) {
    const sameHost = c.launcher_host != null && c.launcher_host === me;
    if (sameHost && c.pid != null) {
      if (isAlive(c.pid)) alive.push(c.spawn_id);
      else deadChild.push(c.spawn_id);
    } else {
      // Different host (can't liveness-check), or a row predating pid recording.
      hostGone.push(c.spawn_id);
    }
  }

  // Keep the live-but-host-paused children: bump their heartbeat so neither this
  // sweep nor the next reclaims them (their own host will resume heartbeating).
  if (alive.length > 0) await heartbeatSpawns(sql, alive);

  const reclaimable = [...deadChild, ...hostGone];
  if (reclaimable.length === 0) {
    return { reclaimed: 0, spawnIds: [], workspaces: [] };
  }

  // Reclaim the confirmed-dead + unverifiable rows. The status guard keeps it
  // idempotent + race-safe against a concurrent sweep on another host. The
  // reason distinguishes a child we PROVED dead from a host we merely presume
  // dead — accurate diagnosis (EI-85's mislabel was exactly this).
  const rows = await sql<{ spawn_id: string; workspace_id: string }[]>`
    UPDATE harness_shared.spawned_agents
       SET status = 'failed',
           finished_at = now(),
           duration_ms = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::bigint,
           error_message = COALESCE(
             error_message,
             CASE
               WHEN spawn_id = ANY(${deadChild}::text[])
                 THEN 'reclaimed: child process (pid ' || COALESCE(pid::text, '?')
                      || ') confirmed dead on ' || COALESCE(launcher_host, '?')
                      || ' — concurrency ceiling freed by the P-011 reclaim sweep (EI-85)'
               ELSE 'reclaimed: spawn heartbeat stale > ' || ${staleSec}::text
                      || 's (launching operator host presumed dead) — concurrency ceiling freed by the P-011 reclaim sweep'
             END
           )
     WHERE status IN ('running', 'restarting')
       AND spawn_id = ANY(${reclaimable}::text[])
    RETURNING spawn_id, workspace_id`;

  // EI-108: Wake parents of reclaimed spawns (best-effort, concurrent, no await)
  for (const row of rows) {
    void wakeParentOnChildDeath(sql as Sql, row.spawn_id, row.workspace_id, 'failed').catch(
      () => { /* best-effort — logged inside wakeParentOnChildDeath */ },
    );
  }

  return {
    reclaimed: rows.length,
    spawnIds: rows.map((r) => r.spawn_id),
    workspaces: [...new Set(rows.map((r) => r.workspace_id).filter(Boolean))],
  };
}
