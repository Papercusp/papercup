import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { withTestSchema } from '@papercusp/test-config';
import { resumeSession } from '../session-resume';
import { __setCoordPoolForTest, ensureCoordIdentity } from '../identity-pg';
import { SID_HEARTBEAT_TTL_MS } from '../heartbeat';

/**
 * P-070: crash/restart hardening for psu role-launch resume.
 *
 * Simulates a crash (stale or absent heartbeat) followed by a restart and
 * asserts liveness-driven behavior against the real single-table coord model
 * (coord_sessions carries role/feature + plan_run_id + spawn_id/pid):
 *   - stale/absent heartbeat -> RELAUNCH, same sid + plan-run, single session row
 *   - resume is idempotent (no second coord identity, no second session row)
 *   - fresh heartbeat -> RE-ATTACH (no double-spawn)
 *   - persisted role/feature surfaced from PG (AC1)
 */

let pool: Pool;
let cleanup: () => Promise<void>;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS coord_sessions (
  sid TEXT PRIMARY KEY,
  harness_slug TEXT NOT NULL,
  role TEXT NOT NULL,
  feature TEXT,
  plan_run_id TEXT,
  spawn_id TEXT,
  pid INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS coord_session_heartbeats (
  sid TEXT PRIMARY KEY,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  pid INTEGER
);
`;

async function countSessions(sid: string): Promise<number> {
	const { rows } = await pool.query('SELECT count(*)::int AS n FROM coord_sessions WHERE sid = $1', [sid]);
	return rows[0].n as number;
}

// Seed a coord session (the spawn binding lives on the same row) bound to a
// plan-run, plus a heartbeat at a chosen age. heartbeatAgeMs=null => no row.
async function seedSession(opts: {
	harnessSlug: string;
	role: string;
	feature: string | null;
	planRunId: string;
	spawnId: string;
	heartbeatAgeMs: number | null;
}): Promise<string> {
	const { sid } = await ensureCoordIdentity({
		harnessSlug: opts.harnessSlug,
		role: opts.role,
		feature: opts.feature,
		planRunId: opts.planRunId,
	});
	await pool.query(
		`UPDATE coord_sessions SET spawn_id = $2, pid = 9999, status = 'active' WHERE sid = $1`,
		[sid, opts.spawnId],
	);
	if (opts.heartbeatAgeMs !== null) {
		await pool.query(
			`INSERT INTO coord_session_heartbeats (sid, last_seen_at, pid)
			 VALUES ($1, now() - ($2 || ' milliseconds')::interval, $3)
			 ON CONFLICT (sid) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, pid = EXCLUDED.pid`,
			[sid, String(opts.heartbeatAgeMs), 9999],
		);
	}
	return sid;
}

beforeAll(async () => {
	const { pool: p, cleanup: c } = await withTestSchema('coord_resume_crash');
	pool = p;
	cleanup = c;
	await __setCoordPoolForTest(pool);
});

afterAll(async () => {
	await cleanup();
});

beforeEach(async () => {
	await pool.query(SCHEMA_SQL);
	await pool.query('TRUNCATE coord_sessions, coord_session_heartbeats');
});

describe('resumeSession crash/restart (P-070)', () => {
	it('RELAUNCHES on a stale heartbeat, preserving sid + plan-run, without a 2nd session row', async () => {
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
		expect(r.spawnId).toBe('spawn-stale'); // binding preserved
		expect(r.action).toBe('relaunch');
		expect(r.reason).toBe('stale-heartbeat');

		expect(await countSessions(sid)).toBe(1); // UPDATE, not INSERT
	});

	it('is idempotent: a second relaunch does not create a 2nd identity/row (AC2)', async () => {
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
		expect(r.reason).toBe('no-heartbeat');
		expect(await countSessions(sid)).toBe(1);
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
		expect(r.action).toBe('reattach');
		expect(await countSessions(sid)).toBe(1); // unchanged
	});

	it('clears the dead pid and refreshes updated_at on relaunch (in-place UPDATE)', async () => {
		const sid = await seedSession({
			harnessSlug: 'hcrash',
			role: 'engineer',
			feature: 'feat-w',
			planRunId: 'pr-500',
			spawnId: 'spawn-refresh',
			heartbeatAgeMs: SID_HEARTBEAT_TTL_MS + 60_000,
		});

		// push updated_at into the past so we can detect a refresh
		await pool.query(
			`UPDATE coord_sessions SET updated_at = now() - interval '1 hour', pid = 1 WHERE sid = $1`,
			[sid],
		);

		await resumeSession({ sid });

		const { rows } = await pool.query(
			`SELECT sid, pid, status, spawn_id, plan_run_id,
			        (updated_at > now() - interval '5 minutes') AS refreshed
			   FROM coord_sessions WHERE sid = $1`,
			[sid],
		);
		expect(rows.length).toBe(1); // still exactly one row
		expect(rows[0].spawn_id).toBe('spawn-refresh'); // binding preserved
		expect(rows[0].plan_run_id).toBe('pr-500'); // plan-run preserved
		expect(rows[0].pid).toBeNull(); // dead pid cleared
		expect(rows[0].refreshed).toBe(true); // updated_at moved forward
		expect(rows[0].status).toBe('active');
	});
});

export const __COORD_SESSION_RESUME_CRASH_TEST__ = true;
