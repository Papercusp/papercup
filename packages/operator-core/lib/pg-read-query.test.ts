/**
 * pg-read-query.test.ts — unit coverage for the single-read-statement guard
 * (the defense-in-depth check; the READ ONLY transaction is the real
 * enforcement, covered in pg-read-query.integration.test.ts) and the P-005
 * point-of-use guards (table extraction, 42703 column hint, tenant-scope
 * advisory) through an injected client stub.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  assertSingleReadStatement,
  extractPgErrorInfo,
  extractReferencedTables,
  describeReferencedTableColumns,
  buildTenantScopeAdvisory,
  buildDerivedColumnRedirect,
  clearTenantScopeSchemaCache,
  PgReadQueryError,
} from './pg-read-query';

describe('assertSingleReadStatement', () => {
  it('accepts a plain SELECT and strips a single trailing semicolon', () => {
    expect(assertSingleReadStatement('SELECT 1')).toBe('SELECT 1');
    expect(assertSingleReadStatement('  SELECT 1 ;  ')).toBe('SELECT 1');
  });

  it('accepts a WITH…SELECT (CTE)', () => {
    const q = 'WITH t AS (SELECT 1 AS n) SELECT * FROM t';
    expect(assertSingleReadStatement(q)).toBe(q);
  });

  it('is case-insensitive on the leading keyword', () => {
    expect(assertSingleReadStatement('select 1')).toBe('select 1');
    expect(assertSingleReadStatement('  WiTh t as (select 1) select * from t')).toMatch(/^WiTh/);
  });

  it('rejects an empty query', () => {
    expect(() => assertSingleReadStatement('   ')).toThrow(PgReadQueryError);
  });

  it('rejects multiple statements (no `;`-separated injection)', () => {
    expect(() => assertSingleReadStatement('SELECT 1; DROP TABLE foo')).toThrow(/single statement/i);
    expect(() => assertSingleReadStatement('SELECT 1; SELECT 2')).toThrow(PgReadQueryError);
  });

  it('rejects a non-read leading statement (INSERT/UPDATE/DELETE/DDL)', () => {
    for (const q of [
      'INSERT INTO foo VALUES (1)',
      'UPDATE foo SET x = 1',
      'DELETE FROM foo',
      'DROP TABLE foo',
      'CREATE TABLE foo (id int)',
      'TRUNCATE foo',
      'ALTER TABLE foo ADD COLUMN x int',
    ]) {
      expect(() => assertSingleReadStatement(q), q).toThrow(/read-only/i);
    }
  });

  // EI-7584: the splitter must not count a `;` INSIDE a string literal (or a
  // quoted identifier, or a comment) as a statement separator.
  describe('quote/comment-aware `;` scan (EI-7584)', () => {
    it('accepts a `;` inside a single-quoted string literal', () => {
      const q = `SELECT * FROM foo WHERE reason = 'text; more text'`;
      expect(assertSingleReadStatement(q)).toBe(q);
    });

    it('accepts a `;` inside a jsonb_set string argument (the reported repro shape)', () => {
      const q = `SELECT jsonb_set('{}', '{reason}', '"text; more text"')`;
      expect(assertSingleReadStatement(q)).toBe(q);
    });

    it('accepts an escaped quote (\'\') followed by a `;` still inside the literal', () => {
      const q = `SELECT 'it''s fine; really' AS x`;
      expect(assertSingleReadStatement(q)).toBe(q);
    });

    it('accepts a `;` inside a double-quoted identifier', () => {
      const q = `SELECT "weird;column" FROM foo`;
      expect(assertSingleReadStatement(q)).toBe(q);
    });

    it('accepts a `;` inside a dollar-quoted string', () => {
      const q = `SELECT $$a; b$$`;
      expect(assertSingleReadStatement(q)).toBe(q);
    });

    it('accepts a `;` inside a tagged dollar-quoted string', () => {
      const q = `SELECT $tag$a; b$tag$`;
      expect(assertSingleReadStatement(q)).toBe(q);
    });

    it('accepts a `;` inside a `--` line comment', () => {
      const q = `SELECT 1 -- trailing; comment`;
      expect(assertSingleReadStatement(q)).toBe(q);
    });

    it('accepts a `;` inside a block comment', () => {
      const q = `SELECT /* a; b */ 1`;
      expect(assertSingleReadStatement(q)).toBe(q);
    });

    it('still rejects a REAL multi-statement query with a literal in the mix', () => {
      expect(() =>
        assertSingleReadStatement(`SELECT 'a; b'; DROP TABLE foo`),
      ).toThrow(/single statement/i);
    });

    it('still rejects two real SELECTs even with a literal before the separator', () => {
      expect(() => assertSingleReadStatement(`SELECT 'x'; SELECT 1`)).toThrow(PgReadQueryError);
    });
  });
});

// EI-8301: dev:pg_query dropped Postgres' HINT/DETAIL on a failed query, so a
// "column does not exist" error only showed the bare message — agents then
// guessed non-obvious column names repeatedly. extractPgErrorInfo pulls the
// diagnostic fields the postgres-js driver attaches through to the payload.
describe('extractPgErrorInfo (EI-8301 — surface PG HINT/DETAIL/code/position)', () => {
  it('extracts hint/detail/code/position from a postgres-js "undefined column" error', () => {
    // Shape postgres-js throws for `SELECT updated_at FROM harness_shared.work_items`
    const pgErr = Object.assign(new Error('column "updated_at" does not exist'), {
      code: '42703',
      hint: 'Perhaps you meant to reference the column "work_items.updated_ts".',
      position: '8',
      severity: 'ERROR',
    });
    expect(extractPgErrorInfo(pgErr)).toEqual({
      message: 'column "updated_at" does not exist',
      hint: 'Perhaps you meant to reference the column "work_items.updated_ts".',
      code: '42703',
      position: '8',
    });
  });

  it('carries DETAIL through when present', () => {
    const pgErr = Object.assign(new Error('some constraint error'), {
      code: '23505',
      detail: 'Key (id)=(1) already exists.',
    });
    const info = extractPgErrorInfo(pgErr);
    expect(info.detail).toBe('Key (id)=(1) already exists.');
    expect(info.code).toBe('23505');
    expect(info.hint).toBeUndefined();
  });

  it('coerces a numeric position to a string', () => {
    const pgErr = Object.assign(new Error('boom'), { position: 42 });
    expect(extractPgErrorInfo(pgErr).position).toBe('42');
  });

  it('returns only message for a PgReadQueryError (validation error — no PG fields)', () => {
    expect(extractPgErrorInfo(new PgReadQueryError('empty query'))).toEqual({
      message: 'empty query',
    });
  });

  it('returns only message for a plain Error with no PG fields', () => {
    expect(extractPgErrorInfo(new Error('generic failure'))).toEqual({
      message: 'generic failure',
    });
  });

  it('handles a non-Error thrown value', () => {
    expect(extractPgErrorInfo('string blew up')).toEqual({ message: 'string blew up' });
  });

  it('omits empty-string PG fields rather than surfacing blanks', () => {
    const pgErr = Object.assign(new Error('x'), { hint: '', detail: '', code: '' });
    expect(extractPgErrorInfo(pgErr)).toEqual({ message: 'x' });
  });
});

// ── P-005 point-of-use guards ────────────────────────────────────────────────

describe('extractReferencedTables (P-005)', () => {
  it('extracts FROM + JOIN names, schema-qualified or bare, lowercased + deduped', () => {
    expect(
      extractReferencedTables(
        'SELECT * FROM harness_shared.Engineer_Issues e JOIN work_items w ON w.id = e.id ' +
          'LEFT JOIN harness_shared.engineer_issues e2 ON e2.id = w.id',
      ),
    ).toEqual(['harness_shared.engineer_issues', 'work_items']);
  });

  it('does not extract a table name from inside a string literal', () => {
    expect(
      extractReferencedTables("SELECT * FROM t1 WHERE note = 'copied from harness_plans join x'"),
    ).toEqual(['t1']);
  });

  it('skips a subquery FROM ( and caps the list', () => {
    const sql =
      'SELECT * FROM (SELECT 1) sub JOIN a ON 1=1 JOIN b ON 1=1 JOIN c ON 1=1 JOIN d ON 1=1 JOIN e ON 1=1';
    expect(extractReferencedTables(sql)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns [] when nothing matches', () => {
    expect(extractReferencedTables('SELECT 1')).toEqual([]);
  });
});

/** A tagged-template `sql` stub returning canned information_schema rows. */
function stubClient(rows: Array<{ table_schema: string; table_name: string; column_name: string; data_type?: string }>) {
  const calls: unknown[][] = [];
  const sql = async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(values);
    return rows;
  };
  return { sql: sql as never, calls };
}

describe('describeReferencedTableColumns (P-005a — the 42703 column hint)', () => {
  it('returns each referenced table with its columns in ordinal order', async () => {
    const { sql } = stubClient([
      { table_schema: 'harness_shared', table_name: 'engineer_issues', column_name: 'issue_id', data_type: 'text' },
      { table_schema: 'harness_shared', table_name: 'engineer_issues', column_name: 'title', data_type: 'text' },
      { table_schema: 'harness_shared', table_name: 'engineer_issues', column_name: 'state', data_type: 'character varying' },
    ]);
    const out = await describeReferencedTableColumns(
      'SELECT wrong_col FROM harness_shared.engineer_issues',
      { client: sql },
    );
    expect(out).toEqual([
      {
        table: 'harness_shared.engineer_issues',
        columns: ['issue_id: text', 'title: text', 'state: character varying'],
      },
    ]);
  });

  it('resolves a bare name matched in many schemas to the preferred one (harness_shared first)', async () => {
    const { sql } = stubClient([
      { table_schema: 'harness_zzz_clone', table_name: 'messages', column_name: 'clone_col', data_type: 'text' },
      { table_schema: 'harness_shared', table_name: 'messages', column_name: 'id', data_type: 'bigint' },
      { table_schema: 'harness_shared', table_name: 'messages', column_name: 'body', data_type: 'text' },
    ]);
    const out = await describeReferencedTableColumns('SELECT nope FROM messages', { client: sql });
    expect(out).toEqual([{ table: 'harness_shared.messages', columns: ['id: bigint', 'body: text'] }]);
  });

  it('returns [] without querying when the SQL references no tables', async () => {
    const { sql, calls } = stubClient([]);
    expect(await describeReferencedTableColumns('SELECT 1', { client: sql })).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('buildTenantScopeAdvisory (P-005b — the wrong-tenant footgun)', () => {
  const TENANT_ROWS = [
    { table_schema: 'harness_shared', table_name: 'harness_plans', column_name: 'workspace_id' },
    { table_schema: 'harness_shared', table_name: 'harness_plans', column_name: 'harness_slug' },
    { table_schema: 'harness_shared', table_name: 'harness_plans', column_name: 'plan_slug' },
  ];

  beforeEach(() => clearTenantScopeSchemaCache());

  it('fires for a filtered query on a tenant table with no scope predicate', async () => {
    const { sql } = stubClient(TENANT_ROWS);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.harness_plans WHERE plan_slug = 'my-plan'",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toContain('harness_shared.harness_plans');
    expect(advisory).toContain('workspace_id + harness_slug');
    expect(advisory).toContain("workspace_id = 'papercusp-workspace'");
    expect(advisory).toContain("harness_slug = 'papercusp'");
    expect(advisory).toContain('raw-sql-plan-slug-needs-workspace-harness-scope');
  });

  it('is silent when the query already carries a scope column', async () => {
    const { sql, calls } = stubClient(TENANT_ROWS);
    expect(
      await buildTenantScopeAdvisory(
        "SELECT * FROM harness_shared.harness_plans WHERE plan_slug = 'p' AND workspace_id = 'ws'",
        { client: sql },
      ),
    ).toBeNull();
    expect(calls).toHaveLength(0); // short-circuits before the schema read
  });

  it("is silent for an unfiltered aggregate (no WHERE — usually a deliberate cross-tenant count)", async () => {
    const { sql, calls } = stubClient(TENANT_ROWS);
    expect(
      await buildTenantScopeAdvisory('SELECT count(*) FROM harness_shared.harness_plans', {
        client: sql,
      }),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('is silent when the referenced table has no tenant columns', async () => {
    const { sql } = stubClient([
      { table_schema: 'public', table_name: 'plain_table', column_name: 'id' },
    ]);
    expect(
      await buildTenantScopeAdvisory('SELECT * FROM plain_table WHERE id = 1', { client: sql }),
    ).toBeNull();
  });

  it("a scope column mentioned only inside a string literal does NOT count as a predicate", async () => {
    const { sql } = stubClient(TENANT_ROWS);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.harness_plans WHERE plan_slug = 'workspace_id-lookalike'",
      { client: sql },
    );
    expect(advisory).not.toBeNull();
  });

  it('caches the schema read (second call for the same table skips the query)', async () => {
    const { sql, calls } = stubClient(TENANT_ROWS);
    await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.harness_plans WHERE plan_slug = 'a'",
      { client: sql },
    );
    await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.harness_plans WHERE plan_slug = 'b'",
      { client: sql },
    );
    expect(calls).toHaveLength(1);
  });

  it('propagates nothing on a schema-read failure (caller catches — advisory just absent)', async () => {
    const throwing = (async () => {
      throw new Error('pg down');
    }) as never;
    await expect(
      buildTenantScopeAdvisory("SELECT * FROM harness_shared.harness_plans WHERE x = 1", {
        client: throwing,
      }),
    ).rejects.toThrow('pg down');
  });
});

// EI-18669912007336072: the generic workspace_id/harness_slug heuristic named
// the WRONG columns for harness_shared.agent_facts (tenanted by scope +
// scope_ref; harness_slug is NULL for ~99.6% of rows) — following its own
// suggested predicate returned a clean-looking, confidence-inspiring empty
// result instead of an error. A per-table override replaces the check (and
// the suggested predicate) for known exceptions like this one.
describe('buildTenantScopeAdvisory — per-table overrides (EI-18669912007336072)', () => {
  beforeEach(() => clearTenantScopeSchemaCache());

  it('advises the real scope+scope_ref predicate for agent_facts instead of workspace_id/harness_slug — no schema read needed', async () => {
    const { sql, calls } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      'SELECT * FROM harness_shared.agent_facts WHERE expires_at < now()',
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toContain('agent_facts');
    expect(advisory).toContain('scope + scope_ref');
    expect(advisory).toContain("scope = 'harness'");
    expect(advisory).toContain("scope_ref = 'papercusp'");
    expect(advisory).toContain('facts:list');
    expect(advisory).not.toContain('harness_slug =');
    expect(calls).toHaveLength(0); // the override is hardcoded — no information_schema read
  });

  it('falls back to a placeholder predicate when harnessSlug is unresolved', async () => {
    const { sql } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      'SELECT * FROM agent_facts WHERE expires_at < now()',
      { client: sql },
    );
    expect(advisory).toContain('scope_ref');
    expect(advisory).not.toContain('scope_ref = \'\'');
  });

  it('is silent for agent_facts when the query already filters by scope + scope_ref', async () => {
    const { sql } = stubClient([]);
    expect(
      await buildTenantScopeAdvisory(
        "SELECT * FROM harness_shared.agent_facts WHERE scope = 'harness' AND scope_ref = 'papercusp'",
        { client: sql },
      ),
    ).toBeNull();
  });

  it('is silent for agent_facts when scoped by scope_ref alone (either override column suffices)', async () => {
    const { sql } = stubClient([]);
    expect(
      await buildTenantScopeAdvisory("SELECT * FROM agent_facts WHERE scope_ref = 'papercusp'", {
        client: sql,
      }),
    ).toBeNull();
  });

  it('still fires for agent_facts when filtered by harness_slug alone — the exact wrong-predicate footgun', async () => {
    const { sql } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.agent_facts WHERE harness_slug = 'papercusp'",
      { client: sql, harnessSlug: 'papercusp' },
    );
    expect(advisory).not.toBeNull();
    expect(advisory).toContain('agent_facts');
  });

  it('still fires generically for a different table joined alongside agent_facts, while agent_facts itself is silenced', async () => {
    const { sql } = stubClient([
      { table_schema: 'harness_shared', table_name: 'harness_plans', column_name: 'workspace_id' },
      { table_schema: 'harness_shared', table_name: 'harness_plans', column_name: 'harness_slug' },
    ]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.agent_facts f JOIN harness_shared.harness_plans p " +
        "ON p.plan_slug = f.scope_ref WHERE f.scope_ref = 'x'",
      { client: sql },
    );
    expect(advisory).toContain('harness_plans');
    expect(advisory).not.toContain('agent_facts');
  });
});

// EI-18749676091756794: the generic heuristic prescribed a WRONG query for
// harness_shared.tool_usage_rollup — it named a `harness_slug` column the
// table does not have at all, and even after dropping that, the real tenant
// workspace id matches ZERO rows because the table is keyed by a CORPUS
// NAMESPACE ('default'), not a tenant. An unscoped read is the correct one
// for these tables, so the advisory must stay silent for them.
describe('buildTenantScopeAdvisory — corpus-namespaced tables (EI-18749676091756794)', () => {
  beforeEach(() => clearTenantScopeSchemaCache());

  it('is silent for tool_usage_rollup even though it has a workspace_id column and no scope predicate', async () => {
    const { sql } = stubClient([
      { table_schema: 'harness_shared', table_name: 'tool_usage_rollup', column_name: 'workspace_id' },
      { table_schema: 'harness_shared', table_name: 'tool_usage_rollup', column_name: 'tool_name' },
      { table_schema: 'harness_shared', table_name: 'tool_usage_rollup', column_name: 'calls' },
    ]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT count(*) FROM harness_shared.tool_usage_rollup WHERE tool_name = 'coord:orient'",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toBeNull();
  });

  it('is silent for session_turns the same way', async () => {
    const { sql } = stubClient([
      { table_schema: 'harness_shared', table_name: 'session_turns', column_name: 'workspace_id' },
      { table_schema: 'harness_shared', table_name: 'session_turns', column_name: 'session_id' },
    ]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.session_turns WHERE session_id = 'x'",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toBeNull();
  });

  it('never names a column absent from the offending table — a workspace_id-only table gets no harness_slug suggestion', async () => {
    const { sql } = stubClient([
      { table_schema: 'harness_shared', table_name: 'workspace_only_table', column_name: 'workspace_id' },
      { table_schema: 'harness_shared', table_name: 'workspace_only_table', column_name: 'id' },
    ]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.workspace_only_table WHERE id = 1",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toContain('workspace_id');
    expect(advisory).not.toContain('harness_slug');
  });

  it('still fires generically for a real tenant table joined alongside a corpus-namespaced one, while the corpus table is silenced', async () => {
    const { sql } = stubClient([
      { table_schema: 'harness_shared', table_name: 'tool_usage_rollup', column_name: 'workspace_id' },
      { table_schema: 'harness_shared', table_name: 'harness_plans', column_name: 'workspace_id' },
      { table_schema: 'harness_shared', table_name: 'harness_plans', column_name: 'harness_slug' },
    ]);
    const advisory = await buildTenantScopeAdvisory(
      'SELECT * FROM harness_shared.tool_usage_rollup u JOIN harness_shared.harness_plans p ' +
        "ON true WHERE u.tool_name = 'x'",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toContain('harness_plans');
    expect(advisory).not.toContain('tool_usage_rollup');
  });
});

describe('buildDerivedColumnRedirect (EI-18801042715296007 — the derived-verdict dead end)', () => {
  const NOT_EXIST = (col: string): string => `column "${col}" does not exist`;
  const PRESENCE_SQL = 'SELECT session_state FROM harness_shared.coord_presence';

  it('redirects the exact query from the filing', () => {
    const out = buildDerivedColumnRedirect(
      'SELECT owner_id, last_active_at, intent, session_state FROM harness_shared.coord_presence',
      NOT_EXIST('session_state'),
    );
    expect(out).toBeTruthy();
    expect(out).toContain('DERIVED, not stored');
  });

  it('names the surfaces that DO return the verdict', () => {
    const out = buildDerivedColumnRedirect(PRESENCE_SQL, NOT_EXIST('session_state'));
    expect(out).toContain('coord:presence');
    expect(out).toContain('fleet:assignments');
  });

  // THE POINT OF THE WHOLE FIX: `knownColumns` steers the retry onto
  // heartbeat_at / last_active_at, which the platform documents as NOT the
  // liveness verdict. The redirect must name that fallback to rule it OUT.
  it('explicitly rules out the raw-keepalive fallback the 42703 hint steers to', () => {
    const out = buildDerivedColumnRedirect(PRESENCE_SQL, NOT_EXIST('session_state'));
    expect(out).toContain('heartbeat_at');
    expect(out).toContain('last_active_at');
    expect(out).toMatch(/do NOT fall back/i);
  });

  // Without this, the next reader proposes the coord_presence_live VIEW that
  // would fork the single oracle — the redirect carries its own rationale.
  it('explains why no view can add the column (the two non-SQL legs)', () => {
    const out = buildDerivedColumnRedirect(PRESENCE_SQL, NOT_EXIST('session_state'));
    expect(out).toContain('no view can add it');
    expect(out).toMatch(/kill\(pid, ?0\)/);
    expect(out).toContain('psu-pty host registry');
  });

  it('handles the ALIAS-QUALIFIED spelling PG uses', () => {
    const out = buildDerivedColumnRedirect(
      'SELECT p.session_state FROM harness_shared.coord_presence p',
      'column p.session_state does not exist',
    );
    expect(out).toBeTruthy();
    expect(out).toContain('DERIVED, not stored');
  });

  it('covers the rest of the oracle-derived family', () => {
    for (const col of ['wakeable', 'live_turn', 'confirm_liveness']) {
      const out = buildDerivedColumnRedirect(
        `SELECT ${col} FROM harness_shared.coord_presence`,
        NOT_EXIST(col),
      );
      expect(out, col).toBeTruthy();
      expect(out, col).toContain('DERIVED, not stored');
    }
  });

  // intent_stale is the sharpest one: the row DOES carry `intent` and
  // `last_active_at`, so a hand-rolled threshold LOOKS like it works while
  // silently disagreeing with INTENT_STALE_SEC.
  it('warns intent_stale against a hand-rolled last_active_at threshold', () => {
    const out = buildDerivedColumnRedirect(
      'SELECT owner_id, intent_stale FROM harness_shared.coord_presence',
      NOT_EXIST('intent_stale'),
    );
    expect(out).toBeTruthy();
    expect(out).toContain('INTENT_STALE_SEC');
    expect(out).toMatch(/do NOT fall back/i);
  });

  // heartbeat_fresh IS computable in SQL — the redirect exists to stop it being
  // READ as liveness, so it must not claim a view is impossible for it.
  it('treats heartbeat_fresh as computable-but-not-the-verdict', () => {
    const out = buildDerivedColumnRedirect(
      'SELECT heartbeat_fresh FROM harness_shared.coord_presence',
      NOT_EXIST('heartbeat_fresh'),
    );
    expect(out).toBeTruthy();
    expect(out).toContain('NOT the liveness verdict');
    expect(out).not.toContain('no view can add it');
  });

  it('stays silent for an ordinary typo on the same table', () => {
    expect(
      buildDerivedColumnRedirect(
        'SELECT owner_idd FROM harness_shared.coord_presence',
        NOT_EXIST('owner_idd'),
      ),
    ).toBeNull();
  });

  // The registry is keyed on (table, column), not column alone — the same word
  // against an unrelated table must not trigger the liveness lecture.
  it('stays silent when the column matches but the table does not', () => {
    expect(
      buildDerivedColumnRedirect(
        'SELECT session_state FROM harness_shared.tool_invocations',
        NOT_EXIST('session_state'),
      ),
    ).toBeNull();
  });

  it('stays silent on a non-undefined-column message', () => {
    expect(
      buildDerivedColumnRedirect(
        PRESENCE_SQL,
        'relation "harness_shared.coord_presence" does not exist',
      ),
    ).toBeNull();
  });
});
