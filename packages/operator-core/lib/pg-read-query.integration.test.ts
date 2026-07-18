/**
 * pg-read-query.integration.test.ts — the READ-ONLY enforcement + row cap of
 * the dev:pg_query helper, against real Postgres (shared testcontainer, Docker
 * required), a fresh migrated org DB.
 *
 * The helper has THREE guards, each tested here:
 *   1. regex          — must be a single SELECT / WITH…SELECT (rejects plain writes early)
 *   2. subquery-wrap  — the LIMIT cap wraps the query in `SELECT * FROM (…)`,
 *                       which PG forbids for a data-modifying CTE (the regex bypass)
 *   3. READ ONLY txn  — PG blocks any remaining write path (e.g. a volatile
 *                       function side effect) — proven via transaction_read_only
 *
 * Run: cd packages/operator-core && \
 *   npx vitest run --config vitest.integration.config.ts lib/pg-read-query.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { pgReadQuery, explainReadQuery, PgReadQueryError } from './pg-read-query';

const { createOrgTestDb } = await import('../test/_org-test-db');

describe('pgReadQuery (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('runs a SELECT and returns rows + field names', async () => {
    const r = await pgReadQuery("SELECT 1 AS n, 'x' AS label", { client: db.adminSql });
    expect(r.rows).toEqual([{ n: 1, label: 'x' }]);
    expect(r.fields).toEqual(['n', 'label']);
    expect(r.rowCount).toBe(1);
    expect(r.truncated).toBe(false);
  });

  it('reads PG-canonical projection tables (harness_plans exists, returns rows array)', async () => {
    const r = await pgReadQuery(
      'SELECT plan_slug, status FROM harness_shared.harness_plans LIMIT 5',
      { client: db.adminSql },
    );
    expect(Array.isArray(r.rows)).toBe(true);
  });

  it('runs inside a READ ONLY transaction (PG-enforced, not just the regex)', async () => {
    const r = await pgReadQuery("SELECT current_setting('transaction_read_only') AS ro", {
      client: db.adminSql,
    });
    expect(r.rows[0]?.ro).toBe('on');
  });

  it('blocks a data-modifying CTE that sneaks past the regex (guard 2 and/or 3)', async () => {
    // Starts with WITH → passes the regex, but the write must NOT happen: the
    // subquery-wrap forbids a data-modifying CTE in a subquery, and the READ
    // ONLY txn forbids the INSERT — either way it rejects and writes nothing.
    await expect(
      pgReadQuery(
        "WITH w AS (INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, status) " +
          "VALUES ('ro-test-ws','h','ro-test-plan','draft') RETURNING 1 AS n) SELECT * FROM w",
        { client: db.adminSql },
      ),
    ).rejects.toThrow(/read-only|top level|data-modifying/i);

    // Prove nothing was written.
    const check = await pgReadQuery(
      "SELECT count(*)::int AS c FROM harness_shared.harness_plans WHERE plan_slug = 'ro-test-plan'",
      { client: db.adminSql },
    );
    expect(check.rows[0]?.c).toBe(0);
  });

  it('caps rows and flags truncation (LIMIT enforced in the DB)', async () => {
    const r = await pgReadQuery('SELECT generate_series(1, 10) AS n', {
      client: db.adminSql,
      maxRows: 3,
    });
    expect(r.rows).toHaveLength(3);
    expect(r.truncated).toBe(true);
    expect(r.rows.map((x) => x.n)).toEqual([1, 2, 3]);
  });

  it('rejects a plain write before it reaches the DB (guard 1)', async () => {
    await expect(
      pgReadQuery('DELETE FROM harness_shared.harness_plans', { client: db.adminSql }),
    ).rejects.toThrow(PgReadQueryError);
  });

  it('rejects multiple statements (guard 1)', async () => {
    await expect(
      pgReadQuery('SELECT 1; SELECT 2', { client: db.adminSql }),
    ).rejects.toThrow(PgReadQueryError);
  });
});

// EI-10514: EXPLAIN-only schema validation (parses/plans, never executes or writes) —
// built for validateRubricReplicationSql to schema-check embedded rubric drill SQL.
describe('explainReadQuery (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('ok:true for a query against a real table/columns', async () => {
    const r = await explainReadQuery('SELECT plan_slug, status FROM harness_shared.harness_plans LIMIT 5', {
      client: db.adminSql,
    });
    expect(r).toEqual({ ok: true });
  });

  it('ok:false with the PG error info for an undefined table (42P01)', async () => {
    const r = await explainReadQuery('SELECT * FROM harness_shared.this_table_does_not_exist', {
      client: db.adminSql,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('42P01');
      expect(r.error.message).toMatch(/does not exist/i);
    }
  });

  it('ok:false with the PG error info for an undefined column (42703) — the renamed-column repro shape', async () => {
    // The literal EI-10514 repro: a drill authored from memory of the old column name.
    const r = await explainReadQuery(
      'SELECT ideas_count, created_at FROM harness_shared.scout_ticks LIMIT 1',
      { client: db.adminSql },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('42703');
    }
  });

  it('never executes/materializes the query — an aggregate over a huge generate_series is instant', async () => {
    const started = Date.now();
    const r = await explainReadQuery('SELECT count(*) FROM generate_series(1, 100000000) AS n', {
      client: db.adminSql,
    });
    expect(r).toEqual({ ok: true });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('rejects a write statement (guard 1, same as pgReadQuery)', async () => {
    const r = await explainReadQuery('DELETE FROM harness_shared.harness_plans', { client: db.adminSql });
    expect(r.ok).toBe(false);
  });
});
