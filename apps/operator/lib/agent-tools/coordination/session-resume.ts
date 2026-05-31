import { coordPool } from './identity-pg';
import { getHeartbeat, SID_HEARTBEAT_TTL_MS } from './heartbeat';
import { getSpawnBinding } from './spawn-binding-pg';
import { decideResume, type ResumeAction } from './resume-decision';

export interface ResumeResult {
	sid: string;
	reattached: boolean;
	planRunId: string | null;
	spawnId: string | null;
	role: string | null;
	feature: string | null;
	/** What the liveness check decided to do. */
	action?: ResumeAction;
	/** Why it decided that. */
	reason?: string;
}

/**
 * Resume a coordination session by sid (P-070, liveness-driven).
 *
 * The coord layer stores the launch spec (role/feature), the plan-run
 * binding, and the spawn binding (spawn_id/pid) all on a single
 * coord_sessions row keyed by sid — so the session row IS the spawn row.
 *
 * Loads that row entirely from Postgres (AC1), then checks the spawn's
 * heartbeat against the TTL:
 *   - fresh heartbeat  -> RE-ATTACH (return existing binding, reattached=true)  (AC4)
 *   - stale/absent     -> RE-LAUNCH: UPDATE the *existing* coord_sessions row in
 *                         place (refresh updated_at/status, clear pid) keeping the
 *                         same sid + plan_run_id; it never inserts a new row.    (AC3)
 *
 * Idempotent: identity is keyed by sid and relaunch is an in-place UPDATE of the
 * single coord_sessions row, so calling resumeSession twice for the same sid
 * never mints a second coord identity nor creates a second spawn binding (AC2).
 */
export async function resumeSession(input: { sid: string }): Promise<ResumeResult> {
	const pool = await coordPool();
	const { rows } = await pool.query(
		`SELECT sid, harness_slug, role, feature, plan_run_id
		   FROM coord_sessions
		  WHERE sid = $1
		  LIMIT 1`,
		[input.sid],
	);
	if (rows.length === 0) {
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
	const row = rows[0];
	const binding = await getSpawnBinding({ sid: input.sid });

	// AC3 / AC4: decide reattach vs relaunch from spawn liveness (heartbeat).
	const hb = await getHeartbeat({ sid: input.sid });
	const decision = decideResume({
		lastSeenAt: hb?.last_seen_at ?? null,
		ttlMs: SID_HEARTBEAT_TTL_MS,
	});

	if (decision.action === 'reattach') {
		return {
			sid: input.sid,
			reattached: true,
			planRunId: row.plan_run_id ?? null,
			spawnId: binding?.spawnId ?? null,
			role: row.role ?? null,
			feature: row.feature ?? null,
			action: 'reattach',
			reason: decision.reason,
		};
	}

	// RE-LAUNCH. The coord identity already exists (keyed by sid) so it is
	// reused as-is — no new identity is minted. Refresh the existing single
	// coord_sessions row in place rather than inserting a second one (AC2/AC3).
	// The old pid is cleared because the prior process is presumed dead; the
	// sid + plan_run_id binding are preserved untouched.
	const spawnId = binding?.spawnId ?? null;
	await pool.query(
		`UPDATE coord_sessions
		    SET status = 'active',
		        pid = NULL,
		        updated_at = now()
		  WHERE sid = $1`,
		[input.sid],
	);

	return {
		sid: input.sid,
		reattached: false,
		planRunId: row.plan_run_id ?? null,
		spawnId,
		role: row.role ?? null,
		feature: row.feature ?? null,
		action: 'relaunch',
		reason: decision.reason,
	};
}

export interface ResumableSession {
	sid: string;
	harnessSlug: string;
	role: string;
	feature: string | null;
	planRunId: string | null;
	spawnId: string | null;
}

/**
 * List the active coord sessions for a harness that are candidates for
 * resume. Read-only; the caller decides per-sid whether to reattach or
 * relaunch via resumeSession().
 */
export async function findResumableSessions(input: {
	harnessSlug: string;
}): Promise<ResumableSession[]> {
	const pool = await coordPool();
	const { rows } = await pool.query(
		`SELECT sid, harness_slug, role, feature, plan_run_id, spawn_id
		   FROM coord_sessions
		  WHERE harness_slug = $1 AND status = 'active'
		  ORDER BY updated_at DESC`,
		[input.harnessSlug],
	);
	return rows.map((r) => ({
		sid: r.sid,
		harnessSlug: r.harness_slug,
		role: r.role,
		feature: r.feature ?? null,
		planRunId: r.plan_run_id ?? null,
		spawnId: r.spawn_id ?? null,
	}));
}
