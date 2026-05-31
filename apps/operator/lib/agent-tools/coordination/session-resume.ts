/**
 * P-070 — psu role-launch resume hardening (liveness-driven, crash-safe).
 *
 * The single source of truth for "what did we launch and is it still alive"
 * is the `harness_shared.spawned_agents` table (libs/papercusp/libs/db/sql/
 * 049-spawned-agents.sql). Each spawn row carries the full launch spec
 * (role/feature), the plan-run binding (plan_run_id), the coord identity
 * (sid), the OS pid, and the liveness clock (last_seen_at). Because the
 * launch spec, plan-run binding, and heartbeat all live on one row keyed by
 * sid, resume is a single-row read + a liveness check — no in-memory or
 * file-only state is consulted (AC1).
 *
 * resumeSession(sid):
 *   - loads the persisted spawn row from PG (AC1)
 *   - getHeartbeat(sid) -> last_seen_at; decideResume(...) classifies it
 *   - fresh  -> RE-ATTACH: reattached=true, return existing binding   (AC4)
 *   - stale/absent -> RE-LAUNCH: UPDATE the existing single row in place
 *                     (refresh started_at/updated_at, status='running',
 *                     clear the dead pid) keeping the SAME sid + plan_run_id;
 *                     it never INSERTs a second row                    (AC3)
 *
 * Idempotency (AC2): identity is keyed by sid and relaunch is an in-place
 * UPDATE of the one spawn row, so calling resumeSession twice for the same
 * sid never mints a second coord identity nor a second spawned_agents row.
 *
 * This module is Pool-injectable for tests via configureSpawnPool(); in
 * production it resolves the embedded-pg admin pool lazily.
 */
import type { Pool } from 'pg';
import { decideResume, type ResumeAction } from './resume-decision';
import { SID_HEARTBEAT_TTL_MS } from './heartbeat';

let injectedPool: Pool | null = null;

/** Test seam: inject the pg Pool the resume helpers run against. */
export function configureSpawnPool(pool: Pool | null): void {
	injectedPool = pool;
}

async function spawnPool(): Promise<Pool> {
	if (injectedPool) return injectedPool;
	// Lazy import so unit/pure tests never pull the embedded-pg admin path.
	const mod = await import('../../harness-pg-pool');
	const getHarnessAdminPool =
		(mod as any).getHarnessAdminPool ?? (mod as any).default;
	return getHarnessAdminPool();
}

export interface SpawnRow {
	spawnId: string;
	sid: string;
	harnessSlug: string;
	role: string;
	feature: string | null;
	planRunId: string | null;
	status: string;
	pid: number | null;
	lastSeenAt: Date | string | null;
}

export interface ResumeResult {
	sid: string;
	reattached: boolean;
	planRunId: string | null;
	spawnId: string | null;
	role: string | null;
	feature: string | null;
	/** What the liveness check decided. */
	action: ResumeAction;
	/** Why it decided that. */
	reason: string;
}

function rowToSpawn(r: any): SpawnRow {
	return {
		spawnId: r.spawn_id,
		sid: r.sid,
		harnessSlug: r.harness_slug,
		role: r.role,
		feature: r.feature ?? null,
		planRunId: r.plan_run_id ?? null,
		status: r.status,
		pid: r.pid ?? null,
		lastSeenAt: r.last_seen_at ?? null,
	};
}

/** Load the single spawn row bound to a sid (the persisted launch spec). */
async function loadSpawnBySid(pool: Pool, sid: string): Promise<SpawnRow | null> {
	const { rows } = await pool.query(
		`SELECT spawn_id, sid, harness_slug, role, feature, plan_run_id,
		        status, pid, last_seen_at
		   FROM harness_shared.spawned_agents
		  WHERE sid = $1
		  ORDER BY started_at DESC
		  LIMIT 1`,
		[sid],
	);
	return rows.length ? rowToSpawn(rows[0]) : null;
}

/**
 * Resume a coordination session by sid. See module doc for the AC mapping.
 */
export async function resumeSession(input: { sid: string }): Promise<ResumeResult> {
	const pool = await spawnPool();
	const spawn = await loadSpawnBySid(pool, input.sid);

	if (!spawn) {
		return {
			sid: input.sid,
			reattached: false,
			planRunId: null,
			spawnId: null,
			role: null,
			feature: null,
			action: 'relaunch',
			reason: 'unknown-sid',
		};
	}

	// AC3 / AC4: liveness from the persisted heartbeat (last_seen_at).
	const decision = decideResume({
		lastSeenAt: spawn.lastSeenAt,
		ttlMs: SID_HEARTBEAT_TTL_MS,
	});

	if (decision.action === 'reattach') {
		return {
			sid: spawn.sid,
			reattached: true,
			planRunId: spawn.planRunId,
			spawnId: spawn.spawnId,
			role: spawn.role,
			feature: spawn.feature,
			action: 'reattach',
			reason: decision.reason,
		};
	}

	// RE-LAUNCH. The coord identity (sid) and plan-run binding already exist
	// and are preserved untouched. Refresh the SAME spawn row in place rather
	// than inserting a second one (AC2/AC3): bump the lifecycle clocks, mark it
	// running again, and clear the dead pid.
	await pool.query(
		`UPDATE harness_shared.spawned_agents
		    SET status = 'running',
		        pid = NULL,
		        started_at = now(),
		        updated_at = now()
		  WHERE spawn_id = $1`,
		[spawn.spawnId],
	);

	return {
		sid: spawn.sid,
		reattached: false,
		planRunId: spawn.planRunId,
		spawnId: spawn.spawnId,
		role: spawn.role,
		feature: spawn.feature,
		action: 'relaunch',
		reason: decision.reason,
	};
}

export interface ResumableSession {
	sid: string;
	spawnId: string;
	harnessSlug: string;
	role: string;
	feature: string | null;
	planRunId: string | null;
}

/**
 * List the resumable (non-terminal) spawns for a harness — candidates a
 * restart should sweep through and resumeSession() one by one. Read-only.
 */
export async function findResumableSessions(input: {
	harnessSlug: string;
}): Promise<ResumableSession[]> {
	const pool = await spawnPool();
	const { rows } = await pool.query(
		`SELECT spawn_id, sid, harness_slug, role, feature, plan_run_id
		   FROM harness_shared.spawned_agents
		  WHERE harness_slug = $1
		    AND status NOT IN ('exited', 'killed', 'done')
		  ORDER BY started_at DESC`,
		[input.harnessSlug],
	);
	return rows.map((r) => ({
		sid: r.sid,
		spawnId: r.spawn_id,
		harnessSlug: r.harness_slug,
		role: r.role,
		feature: r.feature ?? null,
		planRunId: r.plan_run_id ?? null,
	}));
}
