import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { createFreshTestDb } from '@papercusp/test-config/pg';

type Sampler = typeof import('./pgbouncer-pool-sample.mjs');
let sampler: Sampler;
let fixture: Awaited<ReturnType<typeof createFreshTestDb>> | undefined;
let sql: postgres.Sql | undefined;
let scratch: string;
const originalLog = process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_POOL_SAMPLE_LOG;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'pgbouncer-census-test-'));
  process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_POOL_SAMPLE_LOG = join(scratch, 'samples.log');
  sampler = await import('./pgbouncer-pool-sample.mjs');
  fixture = await createFreshTestDb({ prefix: 'it_pool_sample' });
  sql = postgres(fixture.url, { max: 1, prepare: false, onnotice: () => {} });
  await sql.unsafe(`CREATE SCHEMA sample_fixture;
    CREATE TABLE sample_fixture.pg_stat_activity (
      pid int, datname text, application_name text, state text,
      wait_event_type text, wait_event text, backend_type text, leader_pid int
    );`);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await fixture?.drop();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  if (originalLog === undefined) delete process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_POOL_SAMPLE_LOG;
  else process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_POOL_SAMPLE_LOG = originalLog;
}, 30_000);

async function capture() {
  sampler._resetSampleDebounceForTests();
  const execFileImpl: NonNullable<Parameters<Sampler['samplePgBouncerPools']>[1]>['execFileImpl'] = (cmd, args, options, cb) => {
    if (args.includes('pgbouncer')) {
      writeFileSync(args[args.indexOf('--output') + 1], 'isolated \u001b[31mpool fixture\n');
      cb(null, '', '');
      return;
    }
    const env = options.env as NodeJS.ProcessEnv;
    // Shadow only the activity relation in this disposable database. The
    // production query, psql argv, timeout and file transport are unchanged.
    execFile(cmd, args, { ...options, encoding: 'utf8', env: {
      ...env, PGOPTIONS: `${env.PGOPTIONS} -c search_path=sample_fixture,pg_catalog`,
    } }, cb);
  };
  return sampler.samplePgBouncerPools('real-pg-census', {
    execFileImpl, activityConnectionString: fixture!.url,
  });
}

describe('sampler census SQL and real psql file transport', () => {
  it.each([0, 23, 24, 25])('captures the entire %i-group population independently of input order or process-local state', async (count) => {
    const db = sql!;
    const preserved: string[] = [];
    let expected: string | undefined;
    for (const reverse of [false, true]) {
      await db.unsafe('TRUNCATE sample_fixture.pg_stat_activity');
      if (count > 0) {
        await db.unsafe(`INSERT INTO sample_fixture.pg_stat_activity
          SELECT i * 10 + n, current_database(), 'app-' || lpad(i::text, 3, '0'),
            'active', 'Client', 'ClientRead', 'client backend', NULL
          FROM generate_series(1, $1::int) AS i CROSS JOIN generate_series(1, 2) AS n
          ORDER BY CASE WHEN $2::boolean THEN -i ELSE i END`, [count - 2, reverse]);
        await db.unsafe(`INSERT INTO sample_fixture.pg_stat_activity VALUES
          (9001, current_database(), 'app-001', 'active', 'Client', 'ClientRead', 'parallel worker', 111111),
          (9002, current_database(), 'app-001', 'active', 'Client', 'ClientRead', 'parallel worker', 222222),
          (9003, 'another_database', 'excluded', 'active', NULL, NULL, 'client backend', NULL)`);
      }
      const result = await capture();
      expect(result.output).not.toContain('\u001b');
      expect(readFileSync(result.outputSource!.path, 'utf8')).toContain('\u001b');
      expect(result.pgActivity?.error).toBeNull();
      expect(result.pgActivity).toMatchObject({ ok: true, shownGroups: count, omittedGroups: 0,
        census: { totalGroups: count, totalSessions: count ? 2 * count - 2 : 0,
          clientBackends: count ? 2 * (count - 2) : 0, parallelWorkers: count ? 2 : 0 } });
      const source = result.pgActivity!.outputSource!;
      expect(source.complete).toBe(true);
      const full = readFileSync(source.path, 'utf8');
      const groups = full.trimEnd().split('\n').slice(1).map((line) => JSON.parse(line));
      expect(groups).toHaveLength(count);
      if (count) {
        expect(groups.slice(-2).map((g) => [g.backend_type, g.leader_pid])).toEqual([
          ['parallel worker', 111111], ['parallel worker', 222222],
        ]);
      }
      if (expected !== undefined) expect(full).toBe(expected);
      expected = full;
      preserved.push(source.path);
    }
    expect(new Set(preserved).size).toBe(2);
    preserved.forEach((path) => expect(readFileSync(path, 'utf8')).toBe(expected));
  });

  it('preserves empty, null and literal placeholder identities in the complete source', async () => {
    await sql!.unsafe(`TRUNCATE sample_fixture.pg_stat_activity;
      INSERT INTO sample_fixture.pg_stat_activity VALUES
        (1, current_database(), '', NULL, NULL, NULL, 'client backend', NULL),
        (2, current_database(), '(unset)', NULL, NULL, NULL, 'client backend', NULL),
        (3, current_database(), NULL, NULL, NULL, NULL, 'client backend', NULL)`);
    const result = await capture();
    expect(result.pgActivity).toMatchObject({ ok: true, census: { totalGroups: 3, totalSessions: 3 } });
    const rows = readFileSync(result.pgActivity!.outputSource!.path, 'utf8')
      .trimEnd().split('\n').slice(1).map((line) => JSON.parse(line));
    expect(new Set(rows.map((row) => row.application_name))).toEqual(new Set(['', '(unset)', null]));
    rows.forEach((row) => expect(row).toMatchObject({ state: null, wait_event_type: null, wait_event: null }));
  });
});
