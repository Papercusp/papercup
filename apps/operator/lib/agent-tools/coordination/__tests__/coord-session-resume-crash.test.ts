/**
 * P-070: crash/restart hardening for psu role-launch resume.
 *
 * PG-backed (testcontainer) per the project convention — follows the same
 * withTestSchema() + Pool bootstrap as presence-conformance.test.ts.
 *
 * The production code reads the fully-qualified harness_shared.spawned_agents
 * (libs/papercusp/libs/db/sql/049-spawned-agents.sql), so this suite creates
 * the table under that exact schema. Using the qualified name (rather than a
 * per-file search-path schema) also means every pooled connection resolves
 * the table regardless of its own search_path.
 *
 * Simulates a crash (stale or absent heartbeat) then a restart and asserts
 * the liveness-driven behavior against that single source of truth
 * (role/feature + plan_run_id + sid + pid + last_seen_at all on one row):
 *   - stale/absent heartbeat -> RELAUNCH, same sid + plan-run, single row  (AC3)
 *   - resume is idempotent (no 2nd identity, no 2nd spawn row)             (AC2)
 *   - fresh heartbeat -> RE-ATTACH (no double-spawn)                       (AC4)
 *   - persisted role/feature surfaced from PG                             (AC1)
 *
 *   npx vitest run lib/agent-tools/coordination/__tests__/coord-session-resume-crash.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { withTestSchema } from '@papercusp/test-config';
import { resumeSession, findResumableSessions, configureSpawnPool } from '../session-resume';
import { SID_HEARTBEAT_TTL_MS } from '../heartbeat';

let pool: Pool;

const DDL = `
CREATE SCHEMA IF NOT EXISTS harness_shared;
CREATE TABLE IF NOT EXISTS harness_shared.spawned_agents (
  spawn_id      TEXT PRIMARY KEY,
  sid           TEXT NOT NULL,
  harness_slug  TEXT NOT NULL,
  role          TEXT NOT NULL,
  feature       TEXT,
  plan_run_id   TEXT,
  status        TEXT NOT NULL DEFAULT 'running',
  pid           INTEGER,
  last_seen_at  TIMESTAMPTZ,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function countSpawns(sid: string): Promise<number> {
	const { rows } = await pool.query(
		'SELECT count(*)::int AS n FROM harness_shared.spawned_agents WHERE sid = $1',
		[sid],
	);
	return rows[0].n as number;
}

// Seed a single spawn row (the persisted launch spec) with a heartbeat at a
// chosen age. heartbeatAgeMs=null => last_seen_at is NULL (never beat).
async function seedSpawn(opts: {
	spawnId: string;
	sid: string;
	harnessSlug: string;
	role: string;
	feature: string | null;
	planRunId: string;
	heartbeatAgeMs: number | null;
}): Promise<void> {
	const ageStr = opts.heartbeatAgeMs === null ? null : String(opts.heartbeatAgeMs);
	await pool.query(
		`INSERT INTO harness_shared.spawned_agents
		   (spawn_id, sid, harness_slug, role, feature, plan_run_id, status, pid, last_seen_at)
		 VALUES
		   ($1, $2, $3, $4, $5, $6, 'running', 9999,
		    CASE WHEN $7::bigint IS NULL THEN NULL
		         ELSE now() - ($7::bigint || ' milliseconds')::interval END)`,
		[
			opts.spawnId,
			opts.sid,
			opts.harnessSlug,
			opts.role,
			opts.feature,
			opts.planRunId,
			ageStr,
		],
	);
}

beforeAll(async () => {
	const { connectionUri } = await withTestSchema();
	pool = new Pool({ connectionString: connectionUri });
	await pool.query(DDL);
	configureSpawnPool(pool);
});

afterAll(async () => {
	configureSpawnPool(null);
	await pool.end();
});

beforeEach(async () => {
	await pool.query('TRUNCATE harness_shared.spawned_agents');
});

describe('resumeSession crash/restart (P-070)', () => {
	it('RELAUNCHES on a stale heartbeat, preserving sid + plan-run, without a 2nd spawn row (AC3)', async () => {
		await seedSpawn({
			spawnId: 'spawn-stale',
			sid: 'sid-stale',
			harnessSlug: 'hcrash',
			role: 'engineer',
			feature: 'feat-x',
			planRunId: 'pr-100',
			heartbeatAgeMs: SID_HEARTBEAT_TTL_MS + 60_000, // well past TTL
		});

		const r = await resumeSession({ sid: 'sid-stale' });

		expect(r.reattached).toBe(false); // relaunch path
		expect(r.action).toBe('relaunch');
		expect(r.reason).toBe('stale-heartbeat');
		expect(r.sid).toBe('sid-stale'); // same sid, no new identity minted
		expect(r.planRunId).toBe('pr-100'); // plan-run binding preserved
		expect(r.role).toBe('engineer'); // AC1: persisted role surfaced
		expect(r.feature).toBe('feat-x'); // AC1: persisted feature surfaced
		expect(r.spawnId).toBe('spawn-stale'); // binding preserved

		expect(await countSpawns('sid-stale')).toBe(1); // UPDATE, not INSERT
	});

	it('is idempotent: a second relaunch does not create a 2nd identity/spawn row (AC2)', async () => {
		await seedSpawn({
			spawnId: 'spawn-idem',
			sid: 'sid-idem',
			harnessSlug: 'hcrash',
			role: 'engineer',
			feature: 'feat-y',
			planRunId: 'pr-200',
			heartbeatAgeMs: SID_HEARTBEAT_TTL_MS + 60_000,
		});

		const first = await resumeSession({ sid: 'sid-idem' });
		const second = await resumeSession({ sid: 'sid-idem' });

		expect(first.reattached).toBe(false);
		expect(second.reattached).toBe(false);
		expect(second.sid).toBe('sid-idem');
		expect(second.planRunId).toBe('pr-200');
		expect(second.spawnId).toBe('spawn-idem');

		expect(await countSpawns('sid-idem')).toBe(1); // still exactly one spawn row
	});

	it('RELAUNCHES when there is no heartbeat at all (AC3)', async () => {
		await seedSpawn({
			spawnId: 'spawn-nohb',
			sid: 'sid-nohb',
			harnessSlug: 'hcrash',
			role: 'worker',
			feature: null,
			planRunId: 'pr-300',
			heartbeatAgeMs: null,
		});

		const r = await resumeSession({ sid: 'sid-nohb' });

		expect(r.reattached).toBe(false);
		expect(r.action).toBe('relaunch');
		expect(r.reason).toBe('no-heartbeat');
		expect(r.sid).toBe('sid-nohb');
		expect(r.planRunId).toBe('pr-300');
		expect(await countSpawns('sid-nohb')).toBe(1);
	});

	it('RE-ATTACHES when the heartbeat is fresh (AC4 — no double-spawn)', async () => {
		await seedSpawn({
			spawnId: 'spawn-fresh',
			sid: 'sid-fresh',
			harnessSlug: 'hcrash',
			role: 'engineer',
			feature: 'feat-z',
			planRunId: 'pr-400',
			heartbeatAgeMs: 1000, // well within TTL
		});

		const r = await resumeSession({ sid: 'sid-fresh' });

		expect(r.reattached).toBe(true);
		expect(r.action).toBe('reattach');
		expect(r.sid).toBe('sid-fresh');
		expect(r.planRunId).toBe('pr-400');
		expect(r.spawnId).toBe('spawn-fresh');
		expect(r.role).toBe('engineer'); // AC1
		expect(r.feature).toBe('feat-z'); // AC1
		expect(await countSpawns('sid-fresh')).toBe(1); // unchanged
	});

	it('clears the dead pid and refreshes started_at on relaunch (in-place UPDATE)', async () => {
		await seedSpawn({
			spawnId: 'spawn-refresh',
			sid: 'sid-refresh',
			harnessSlug: 'hcrash',
			role: 'engineer',
			feature: 'feat-w',
			planRunId: 'pr-500',
			heartbeatAgeMs: SID_HEARTBEAT_TTL_MS + 60_000,
		});
		// push started_at into the past + a live pid so we can detect the refresh
		await pool.query(
			`UPDATE harness_shared.spawned_agents
			    SET started_at = now() - interval '1 hour', pid = 1
			  WHERE sid = 'sid-refresh'`,
		);

		await resumeSession({ sid: 'sid-refresh' });

		const { rows } = await pool.query(
			`SELECT spawn_id, pid, status, plan_run_id,
			        (started_at > now() - interval '5 minutes') AS refreshed
			   FROM harness_shared.spawned_agents WHERE sid = 'sid-refresh'`,
		);
		expect(rows.length).toBe(1); // still exactly one row
		expect(rows[0].spawn_id).toBe('spawn-refresh'); // same row reused
		expect(rows[0].plan_run_id).toBe('pr-500'); // plan-run preserved
		expect(rows[0].pid).toBeNull(); // dead pid cleared
		expect(rows[0].refreshed).toBe(true); // started_at moved forward
		expect(rows[0].status).toBe('running');
	});

	it('returns unknown-sid for a sid with no spawn row', async () => {
		const r = await resumeSession({ sid: 'sid-missing' });
		expect(r.reattached).toBe(false);
		expect(r.reason).toBe('unknown-sid');
		expect(r.spawnId).toBeNull();
	});

	it('findResumableSessions lists non-terminal spawns for a harness', async () => {
		await seedSpawn({
			spawnId: 's-a', sid: 'sid-a', harnessSlug: 'hres', role: 'engineer',
			feature: 'f', planRunId: 'pr-a', heartbeatAgeMs: 1000,
		});
		await seedSpawn({
			spawnId: 's-b', sid: 'sid-b', harnessSlug: 'hres', role: 'worker',
			feature: null, planRunId: 'pr-b', heartbeatAgeMs: null,
		});
		// a terminal one that must be excluded
		await seedSpawn({
			spawnId: 's-c', sid: 'sid-c', harnessSlug: 'hres', role: 'worker',
			feature: null, planRunId: 'pr-c', heartbeatAgeMs: 1000,
		});
		await pool.query(
			`UPDATE harness_shared.spawned_agents SET status = 'exited' WHERE spawn_id = 's-c'`,
		);

		const list = await findResumableSessions({ harnessSlug: 'hres' });
		const sids = list.map((s) => s.sid).sort();
		expect(sids).toEqual(['sid-a', 'sid-b']);
	});
});

export const __COORD_SESSION_RESUME_CRASH_TEST__ = true;
