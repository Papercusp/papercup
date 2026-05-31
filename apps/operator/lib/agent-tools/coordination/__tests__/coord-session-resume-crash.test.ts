import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { withTestSchema, getTestPg } from '@papercusp/test-config';
import type { Pool } from 'pg';
import { resumeSession } from '../session-resume';
import { ensureCoordIdentity } from '../identity-pg';
import { recordHeartbeat } from '../heartbeat';
import { SID_HEARTBEAT_TTL_MS } from '../identity';

/**
 * P-070: crash/restart hardening for psu role-launch resume.
 *
 * Simulates a crash (stale or absent heartbeat) followed by a restart and
 * asserts liveness-driven behavior:
 *   - stale/absent heartbeat -> RELAUNCH, same sid + plan-run, single spawn row
 *   - resume is idempotent (no second coord identity, no second spawn row)
 *   - fresh heartbeat -> RE-ATTACH (no double-spawn)
 */

let pool: Pool;
let restoreSchema: () => Promise<void>;

async function applyCoordDDL(p: Pool) {
	await p.query(`
		CREATE TABLE IF NOT EXISTS coord_sessions (
			sid TEXT PRIMARY KEY,
			harness_slug TEXT NOT NULL,
			role TEXT NOT NULL,
			feature TEXT,
			plan_run_id TEXT,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now()
		);
	`);
	await p.query(`
		CREATE TABLE IF NOT EXISTS spawned_agents (
			spawn_id TEXT PRIMARY KEY,
			sid TEXT,
			plan_run_id TEXT,
			role TEXT NOT NULL,
			feature TEXT,
			status TEXT NOT NULL DEFAULT 'running',
			pid INTEGER,
			started_at TIMESTAMPTZ NOT NULL DEFAULT now()
		);
	`);
	await p.query(`
		CREATE TABLE IF NOT EXISTS coord_session_heartbeats (
			sid TEXT PRIMARY KEY,
			last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			pid INTEGER
		);
	`);
}

async function countSpawns(sid: string): Promise<number> {
	const { rows } = await pool.query('SELECT count(*)::int AS n FROM spawned_agents WHERE sid = $1', [sid]);
	return rows[0].n as number;
}

async function countSessions(sid: string): Promise<number> {
	const { rows } = await pool.query('SELECT count(*)::int AS n FROM coord_sessions WHERE sid = $1', [sid]);
	return rows[0].n as number;
}

// Seed a coord session + a single bound spawn row + a heartbeat at a chosen age.
async function seedSession(opts: {
	harnessSlug: string;
	role: string;
	feature: string | null;
	planRunId: string;
	spawnId: string;
	heartbeatAgeMs: number | null; // null = no heartbeat row at all
}): Promise<string> {
	const { sid } = await ensureCoordIdentity({
		harnessSlug: opts.harnessSlug,
		role: opts.role,
		feature: opts.feature,
		planRunId: opts.planRunId,
	});
	await pool.query(
		`INSERT INTO spawned_agents (spawn_id, sid, plan_run_id, role, feature, status, pid)
		 VALUES ($1,$2,$3,$4,$5,'running',$6)`,
		[opts.spawnId, sid, opts.planRunId, opts.role, opts.feature, 9999],
	);
	if (opts.heartbeatAgeMs !== null) {
		await pool.query(
			`INSERT INTO coord_session_heartbeats (sid, last_seen_at, pid)
			 VALUES ($1, now() - ($2 || ' milliseconds')::interval, $3)`,
			[sid, String(opts.heartbeatAgeMs), 9999],
		);
	}
	return sid;
}

beforeAll(async () => {
	const { pool: p, restore } = await withTestSchema(getTestPg(), 'coord_resume_crash');
	pool = p;
	restoreSchema = restore;
	await applyCoordDDL(pool);
});

afterAll(async () => {
	await restoreSchema?.();
});

beforeEach(async () => {
	await pool.query('TRUNCATE coord_sessions, spawned_agents, coord_session_heartbeats');
});

describe('resumeSession crash/restart (P-070)', () => {
	it('RELAUNCHES on a stale heartbeat, preserving sid + plan-run, without inserting a 2nd spawn', async () => {
		const sid = await seedSession({
			harnessSlug: 'hcrash',
			role: 'engineer',
			feature: 'feat-x',
			planRunId: 'pr-100',
			spawnId: 'spawn-stale',
			heartbeatAgeMs: SID_HEARTBEAT_TTL_MS + 60_000, // well past TTL
		});

		const r = await resumeSession({ sid });

		expect(r.reattached).toBe(false); // relaunch path
		expect(r.sid).toBe(sid); // same sid, no new identity minted
		expect(r.planRunId).toBe('pr-100'); // plan-run binding preserved
		expect(r.role).toBe('engineer'); // AC1: persisted role surfaced
		expect(r.feature).toBe('feat-x'); // AC1: persisted feature surfaced
		expect(r.spawnId).toBeTruthy(); // a spawn id is returned

		// relaunch UPDATEs the existing single row, does not INSERT a second
		expect(await countSpawns(sid)).toBe(1);
		expect(await countSessions(sid)).toBe(1);
	});

	it('is idempotent: a second relaunch does not create a 2nd spawn or 2nd identity (AC2)', async () => {
		const sid = await seedSession({
			harnessSlug: 'hcrash',
			role: 'engineer',
			feature: 'feat-y',
			planRunId: 'pr-200',
			spawnId: 'spawn-stale-2',
			heartbeatAgeMs: SID_HEARTBEAT_TTL_MS + 60_000,
		});

		const first = await resumeSession({ sid });
		const second = await resumeSession({ sid });

		expect(first.reattached).toBe(false);
		expect(second.reattached).toBe(false);
		expect(second.sid).toBe(sid);
		expect(second.planRunId).toBe('pr-200');

		expect(await countSpawns(sid)).toBe(1); // still exactly one spawn row
		expect(await countSessions(sid)).toBe(1); // still exactly one coord session
	});

	it('RELAUNCHES when there is no heartbeat at all (AC3)', async () => {
		const sid = await seedSession({
			harnessSlug: 'hcrash',
			role: 'worker',
			feature: null,
			planRunId: 'pr-300',
			spawnId: 'spawn-nohb',
			heartbeatAgeMs: null,
		});

		const r = await resumeSession({ sid });

		expect(r.reattached).toBe(false);
		expect(r.sid).toBe(sid);
		expect(r.planRunId).toBe('pr-300');
		expect(await countSpawns(sid)).toBe(1);
	});

	it('RE-ATTACHES when the heartbeat is fresh (AC4 — no double-spawn)', async () => {
		const sid = await seedSession({
			harnessSlug: 'hcrash',
			role: 'engineer',
			feature: 'feat-z',
			planRunId: 'pr-400',
			spawnId: 'spawn-fresh',
			heartbeatAgeMs: 1000, // well within TTL
		});

		const r = await resumeSession({ sid });

		expect(r.reattached).toBe(true);
		expect(r.sid).toBe(sid);
		expect(r.planRunId).toBe('pr-400');
		expect(r.spawnId).toBe('spawn-fresh');
		expect(await countSpawns(sid)).toBe(1); // unchanged
	});

	it('refreshes started_at and replaces pid on relaunch (does not insert)', async () => {
		const sid = await seedSession({
			harnessSlug: 'hcrash',
			role: 'engineer',
			feature: 'feat-w',
			planRunId: 'pr-500',
			spawnId: 'spawn-refresh',
			heartbeatAgeMs: SID_HEARTBEAT_TTL_MS + 60_000,
		});

		// push started_at into the past so we can detect a refresh
		await pool.query(
			`UPDATE spawned_agents SET started_at = now() - interval '1 hour', pid = 1 WHERE sid = $1`,
			[sid],
		);

		await resumeSession({ sid });

		const { rows } = await pool.query(
			`SELECT spawn_id, pid, status, started_at,
			        (started_at > now() - interval '5 minutes') AS refreshed
			   FROM spawned_agents WHERE sid = $1`,
			[sid],
		);
		expect(rows.length).toBe(1); // still exactly one row
		expect(rows[0].spawn_id).toBe('spawn-refresh'); // same row reused
		expect(rows[0].refreshed).toBe(true); // started_at moved forward
		expect(rows[0].status).toBe('running');
	});
});

export const __COORD_SESSION_RESUME_CRASH_TEST__ = true;
