/**
 * Spawn-liveness heartbeat helpers (P-070).
 *
 * A spawned agent records a heartbeat by bumping `last_seen_at` on its
 * `harness_shared.spawned_agents` row (the same single source of truth used
 * by session-resume). Resume reads that timestamp and compares it to the TTL
 * to decide reattach-vs-relaunch.
 *
 * The TTL lives here (next to the read/write helpers) and is re-exported by
 * the decision + resume modules so the boundary value is defined once.
 */
import type { Pool } from 'pg';

/**
 * How long a spawn's heartbeat stays "fresh". A spawn whose `last_seen_at`
 * is within this window of now is presumed alive (RE-ATTACH); older or
 * absent means dead (RE-LAUNCH). 90s tolerates a couple of missed beats
 * without holding a crashed process's identity open for long.
 */
export const SID_HEARTBEAT_TTL_MS = 90_000;

let injectedPool: Pool | null = null;

/** Test seam: inject the pg Pool the heartbeat helpers run against. */
export function configureHeartbeatPool(pool: Pool | null): void {
	injectedPool = pool;
}

async function hbPool(): Promise<Pool> {
	if (injectedPool) return injectedPool;
	const mod = await import('../../harness-pg-pool');
	const getHarnessAdminPool =
		(mod as any).getHarnessAdminPool ?? (mod as any).default;
	return getHarnessAdminPool();
}

export interface HeartbeatRow {
	sid: string;
	last_seen_at: Date | string | null;
	pid: number | null;
}

/** Read the latest heartbeat for a sid, or null if the spawn is unknown. */
export async function getHeartbeat(input: { sid: string }): Promise<HeartbeatRow | null> {
	const pool = await hbPool();
	const { rows } = await pool.query(
		`SELECT sid, last_seen_at, pid
		   FROM harness_shared.spawned_agents
		  WHERE sid = $1
		  ORDER BY started_at DESC
		  LIMIT 1`,
		[input.sid],
	);
	if (!rows.length) return null;
	return {
		sid: rows[0].sid,
		last_seen_at: rows[0].last_seen_at ?? null,
		pid: rows[0].pid ?? null,
	};
}

/** Bump last_seen_at (and optionally pid) for a sid's spawn row. */
export async function recordHeartbeat(input: { sid: string; pid?: number | null }): Promise<void> {
	const pool = await hbPool();
	await pool.query(
		`UPDATE harness_shared.spawned_agents
		    SET last_seen_at = now(),
		        pid = COALESCE($2, pid),
		        updated_at = now()
		  WHERE sid = $1`,
		[input.sid, input.pid ?? null],
	);
}
