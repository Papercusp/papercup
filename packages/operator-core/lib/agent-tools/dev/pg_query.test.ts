/**
 * dev:pg_query handler wiring — the P-005 point-of-use guards ride the payload:
 * the tenant-scope ADVISORY on a successful read, and the referenced tables'
 * canonical column lists (knownColumns) on a 42703. The guard machinery itself
 * is unit-tested in pg-read-query.test.ts; this pins the handler contract —
 * where the fields land and that a guard failure never breaks the result.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const {
  pgReadQueryMock,
  advisoryMock,
  describeColumnsMock,
  describeRelationMock,
  listRelationsMock,
} = vi.hoisted(() => ({
  pgReadQueryMock: vi.fn(),
  advisoryMock: vi.fn(),
  describeColumnsMock: vi.fn(),
  describeRelationMock: vi.fn(),
  listRelationsMock: vi.fn(),
}));

vi.mock('../../pg-read-query', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pgReadQuery: pgReadQueryMock,
  buildTenantScopeAdvisory: advisoryMock,
  describeReferencedTableColumns: describeColumnsMock,
  describeRelation: describeRelationMock,
  listRelations: listRelationsMock,
}));

import pgQueryTool from './pg_query';
import { PgReadQueryTimeoutError } from '../../pg-read-query';

const OK_RESULT = { rowCount: 1, truncated: false, fields: ['x'], elapsedMs: 3, rows: [{ x: 1 }] };

function payloadOf(res: { content: Array<{ type: string; text: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

beforeEach(() => {
  pgReadQueryMock.mockReset().mockResolvedValue(OK_RESULT);
  advisoryMock.mockReset().mockResolvedValue(null);
  describeColumnsMock.mockReset().mockResolvedValue([]);
  describeRelationMock.mockReset().mockResolvedValue(null);
  listRelationsMock.mockReset().mockResolvedValue([]);
});

describe('dev:pg_query — P-005 guard wiring', () => {
  it('does not retain an ambient workspace transaction while using the admin read pool', () => {
    expect((pgQueryTool as unknown as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it('keeps ptool JSON responses parseable when a relation description exceeds the result door', () => {
    expect((pgQueryTool as unknown as { skipResultDoor?: string }).skipResultDoor).toBe('programmatic-caller');
  });

  it('documents the unwrapped root shape for code:run callers', () => {
    const returns = (pgQueryTool as unknown as { guidance?: { returns?: string } }).guidance?.returns;
    expect(returns).toContain('{ rowCount, truncated, fields, elapsedMs, rows }');
    expect(returns).toContain('there is no `result.content` MCP envelope');
  });

  it('returns a relation description as structured data for transport-safe shaping', async () => {
    const description = {
      relation: 'harness_shared.tool_invocations',
      kind: 'table',
      columns: [{ name: 'id', type: 'text', nullable: false, default: null, comment: null }],
      indexes: [{ name: 'tool_invocations_pkey', definition: 'CREATE UNIQUE INDEX …' }],
      constraints: [{ name: 'tool_invocations_pkey', type: 'PRIMARY KEY', definition: 'PRIMARY KEY (id)' }],
    };
    describeRelationMock.mockResolvedValue(description);

    const res = await pgQueryTool.handler(
      { describe: 'harness_shared.tool_invocations' } as never,
      {} as never,
    );

    expect(res).toEqual({ data: description });
    expect(res).not.toHaveProperty('content');
  });

  it('returns glob relation listings as structured data for transport-safe shaping', async () => {
    const relations = [{ relation: 'harness_shared.tool_invocations', kind: 'table' }];
    listRelationsMock.mockResolvedValue(relations);

    const res = await pgQueryTool.handler({ describe: 'harness_shared.tool_*' } as never, {} as never);

    expect(res).toEqual({
      data: { pattern: 'harness_shared.tool_*', relationCount: 1, relations },
    });
    expect(res).not.toHaveProperty('content');
  });

  it('refuses an unscoped tenant read before executing it', async () => {
    advisoryMock.mockResolvedValue('⚠ tenant scope: …');
    const res = await pgQueryTool.handler(
      { sql: 'SELECT 1' } as never,
      { workspaceId: 'ws-1', harnessSlug: 'h-1' } as never,
    );
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(payloadOf(res as never)).toMatchObject({ reason: 'tenant_scope_required' });
    expect(String(payloadOf(res as never).error)).toContain('allowUnscoped: true');
    expect(pgReadQueryMock).not.toHaveBeenCalled();
    expect(advisoryMock).toHaveBeenCalledWith('SELECT 1', {
      workspaceId: 'ws-1',
      harnessSlug: 'h-1',
    });
  });

  it('runs an explicitly allowed cross-tenant read and retains the advisory', async () => {
    advisoryMock.mockResolvedValue('⚠ tenant scope: …');
    const res = await pgQueryTool.handler(
      { sql: 'SELECT 1', allowUnscoped: true } as never,
      { workspaceId: 'ws-1', harnessSlug: 'h-1' } as never,
    );
    expect(payloadOf(res as never)).toMatchObject({ advisory: '⚠ tenant scope: …', rowCount: 1 });
    expect(pgReadQueryMock).toHaveBeenCalledOnce();
  });

  it('runs a read-only EXPLAIN over a SELECT body and returns planner rows', async () => {
    pgReadQueryMock.mockResolvedValue({
      rowCount: 1,
      truncated: false,
      fields: ['QUERY PLAN'],
      elapsedMs: 4,
      rows: [{ 'QUERY PLAN': 'Result  (cost=0.00..0.01 rows=1 width=4)' }],
    });
    const sql = 'EXPLAIN (FORMAT TEXT) SELECT 1';
    const res = await pgQueryTool.handler({ sql, allowUnscoped: true } as never, {} as never);
    expect(payloadOf(res as never)).toMatchObject({
      rowCount: 1,
      fields: ['QUERY PLAN'],
      rows: [{ 'QUERY PLAN': expect.stringContaining('Result') }],
    });
    expect(pgReadQueryMock).toHaveBeenCalledWith(sql, { maxRows: undefined, timeoutMs: undefined });
  });

  it('omits the advisory field when the guard finds nothing (or throws)', async () => {
    const clean = await pgQueryTool.handler({ sql: 'SELECT 1' } as never, {} as never);
    expect(payloadOf(clean as never)).not.toHaveProperty('advisory');

    advisoryMock.mockRejectedValue(new Error('schema read down'));
    const guarded = await pgQueryTool.handler({ sql: 'SELECT 1' } as never, {} as never);
    expect(payloadOf(guarded as never)).toMatchObject({ rowCount: 1 });
  });

  // WI-6674. NOTE the mock factory spreads importOriginal() before overriding,
  // so buildSilentNullPathAdvisory here is the REAL implementation — these pin
  // the handler wiring end-to-end rather than a stub agreeing with itself.
  const NULL_PATH_SQL =
    "SELECT count(*) FROM harness_shared.engineer_issues WHERE payload->'_ei'->>'severity' = 'critical'";

  it('attaches the always-NULL-accessor advisory to a successful result', async () => {
    const res = await pgQueryTool.handler({ sql: NULL_PATH_SQL, allowUnscoped: true } as never, {} as never);
    expect(payloadOf(res as never).advisory).toContain('always-NULL accessor');
  });

  it('attaches the epoch-unit advisory to a tool_invocations recency read', async () => {
    const sql =
      'SELECT min(invoked_at) FROM harness_shared.tool_invocations ' +
      'WHERE invoked_at >= to_timestamp(1786547705.088/1000.0)';
    const res = await pgQueryTool.handler({ sql, allowUnscoped: true } as never, {} as never);
    expect(payloadOf(res as never).advisory).toContain('epoch-unit ambiguity');
  });

  it('does not warn for an epoch-milliseconds literal', async () => {
    const sql =
      'SELECT min(invoked_at) FROM harness_shared.tool_invocations ' +
      'WHERE invoked_at >= to_timestamp(1786547705088/1000.0)';
    const res = await pgQueryTool.handler({ sql, allowUnscoped: true } as never, {} as never);
    expect(payloadOf(res as never)).not.toHaveProperty('advisory');
  });

  it('COMPOSES both advisories — neither masks the other', async () => {
    // A query can be both wrongly-scoped AND wrongly-accessed; reporting only
    // one would send the agent back for a second round-trip on the same query.
    advisoryMock.mockResolvedValue('⚠ tenant scope: …');
    const res = await pgQueryTool.handler(
      { sql: NULL_PATH_SQL, allowUnscoped: true } as never,
      {} as never,
    );
    const advisory = String(payloadOf(res as never).advisory);
    expect(advisory).toContain('always-NULL accessor');
    expect(advisory).toContain('tenant scope');
  });

  it('omits the advisory field entirely when neither guard fires', async () => {
    const res = await pgQueryTool.handler(
      // Keep this a genuinely uncovered read: engineer_issues is covered by
      // the existing improvements:digest routing hint.
      { sql: 'SELECT 1' } as never,
      {} as never,
    );
    expect(payloadOf(res as never)).not.toHaveProperty('advisory');
  });

  it('a 42703 error carries knownColumns for the referenced tables', async () => {
    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('column "updated_at" does not exist'), { code: '42703' }),
    );
    describeColumnsMock.mockResolvedValue([
      { table: 'harness_shared.engineer_issues', columns: ['issue_id: text', 'updated_ts: bigint'] },
    ]);
    const res = await pgQueryTool.handler(
      { sql: 'SELECT updated_at FROM harness_shared.engineer_issues' } as never,
      {} as never,
    );
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(payloadOf(res as never)).toMatchObject({
      code: '42703',
      knownColumns: {
        'harness_shared.engineer_issues': ['issue_id: text', 'updated_ts: bigint'],
      },
    });
  });

  it('adds an actionable routines schema redirect alongside knownColumns', async () => {
    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('column "harness_slug" does not exist'), { code: '42703' }),
    );
    describeColumnsMock.mockResolvedValue([
      { table: 'harness_shared.routines', columns: ['install_slug: text', 'workspace_id: text'] },
    ]);
    const res = await pgQueryTool.handler(
      {
        sql: "SELECT harness_slug FROM harness_shared.routines WHERE workspace_id = 'ws'",
      } as never,
      {} as never,
    );
    expect(payloadOf(res as never)).toMatchObject({
      code: '42703',
      schemaColumn: expect.stringContaining('install_slug'),
    });
  });

  it('a non-42703 error gets no column lookup; a failing lookup still returns the error', async () => {
    pgReadQueryMock.mockRejectedValue(Object.assign(new Error('syntax error'), { code: '42601' }));
    const res = await pgQueryTool.handler({ sql: 'SELEC 1' } as never, {} as never);
    expect(describeColumnsMock).not.toHaveBeenCalled();
    expect(payloadOf(res as never)).toMatchObject({ code: '42601' });

    pgReadQueryMock.mockRejectedValue(Object.assign(new Error('bad column'), { code: '42703' }));
    describeColumnsMock.mockRejectedValue(new Error('schema read down'));
    const res2 = await pgQueryTool.handler({ sql: 'SELECT nope FROM t' } as never, {} as never);
    const p2 = payloadOf(res2 as never);
    expect(p2).toMatchObject({ code: '42703' });
    expect(p2).not.toHaveProperty('knownColumns');
  });

  it('adds the zero-argument signature hint for a regprocedure cast parse error', async () => {
    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('expected a left parenthesis'), { code: '22P02' }),
    );
    const res = await pgQueryTool.handler(
      {
        sql: "SELECT pg_get_functiondef('harness_shared.engineer_issues_view_dml'::regprocedure)",
      } as never,
      {} as never,
    );
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(payloadOf(res as never)).toMatchObject({
      code: '22P02',
      hint: expect.stringContaining("'harness_shared.engineer_issues_view_dml()'::regprocedure"),
    });
  });

  // EI-19415142351884573: a whole-call timeout is a distinct failure from a
  // real PG error ("we never found out" vs "PG said no") and must be reported
  // as such, not fall into the generic HINT/DETAIL/42703 error path below it.
  it('a PgReadQueryTimeoutError is reported as reason "call_timeout", not a generic PG error', async () => {
    pgReadQueryMock.mockRejectedValue(
      new PgReadQueryTimeoutError('Query call did not complete within 3100ms of the WHOLE call…'),
    );
    const res = await pgQueryTool.handler({ sql: 'SELECT 1' } as never, {} as never);
    expect((res as { isError?: boolean }).isError).toBe(true);
    const payload = payloadOf(res as never);
    expect(payload.reason).toBe('call_timeout');
    expect(String(payload.error)).toContain('WHOLE call');
    expect(payload).not.toHaveProperty('knownColumns');
    expect(describeColumnsMock).not.toHaveBeenCalled();
  });
});
