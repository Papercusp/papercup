/**
 * dev:pg_query handler wiring — the P-005 point-of-use guards ride the payload:
 * the tenant-scope ADVISORY on a successful read, and the referenced tables'
 * canonical column lists (knownColumns) on a 42703. The guard machinery itself
 * is unit-tested in pg-read-query.test.ts; this pins the handler contract —
 * where the fields land and that a guard failure never breaks the result.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { z } from 'zod';

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
  it('publishes SQL and relation description as mutually exclusive input alternatives', () => {
    expect(pgQueryTool.args.safeParse({ sql: 'SELECT 1' }).success).toBe(true);
    expect(
      pgQueryTool.args.safeParse({ sql: 'SELECT 1', positiveControlSql: 'SELECT 1 AS known' }).success,
    ).toBe(true);
    expect(pgQueryTool.args.safeParse({ describe: 'harness_shared.tool_invocations' }).success).toBe(true);
    expect(pgQueryTool.args.safeParse({ sql: 'SELECT 1', describe: 'harness_shared.tool_invocations' }).success).toBe(false);
    expect(
      pgQueryTool.args.safeParse({
        describe: 'harness_shared.tool_invocations',
        positiveControlSql: 'SELECT 1',
      }).success,
    ).toBe(false);
    expect(pgQueryTool.args.safeParse({}).success).toBe(false);

    const json = z.toJSONSchema(pgQueryTool.args as never) as {
      anyOf?: Array<{
        required?: string[];
        properties?: Record<string, { not?: unknown }>;
      }>;
      oneOf?: Array<{
        required?: string[];
        properties?: Record<string, { not?: unknown }>;
      }>;
    };
    const branches = json.anyOf ?? json.oneOf ?? [];
    expect(branches).toHaveLength(2);
    expect(branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          required: expect.arrayContaining(['sql']),
          properties: expect.objectContaining({ describe: expect.objectContaining({ not: expect.anything() }) }),
        }),
        expect.objectContaining({
          required: expect.arrayContaining(['describe']),
          properties: expect.objectContaining({ sql: expect.objectContaining({ not: expect.anything() }) }),
        }),
      ]),
    );
  });

  it('does not retain an ambient workspace transaction while using the admin read pool', () => {
    expect((pgQueryTool as unknown as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it('keeps ptool JSON responses parseable when a relation description exceeds the result door', () => {
    expect((pgQueryTool as unknown as { skipResultDoor?: string }).skipResultDoor).toBe('programmatic-caller');
  });

  it('documents the unwrapped root shape for code:run callers', () => {
    const returns = (pgQueryTool as unknown as { guidance?: { returns?: string } }).guidance?.returns;
    expect(returns).toContain('{ rowCount, truncated, fields, elapsedMs, rows, positiveControl?, absence? }');
    expect(returns).toContain('absence.status:"unverified"');
    expect(returns).toContain('`code:run` returns this root directly');
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

  describe('positive-control evidence for empty results (WI-41165)', () => {
    it('marks a bare zero-row result unverified instead of presenting silence as evidence', async () => {
      pgReadQueryMock.mockResolvedValue({
        rowCount: 0,
        truncated: false,
        fields: [],
        elapsedMs: 2,
        rows: [],
      });

      const res = await pgQueryTool.handler({ sql: 'SELECT 1 WHERE false' } as never, {} as never);
      const payload = payloadOf(res as never);

      expect(payload.absence).toEqual({
        status: 'unverified',
        code: 'positive-control-not-run',
      });
      expect(payload.advisory).toContain('no positiveControlSql was run');
      expect(payload).not.toHaveProperty('positiveControl');
    });

    it('marks an empty result verified when its same-transaction positive control returns a row', async () => {
      pgReadQueryMock.mockResolvedValue({
        rowCount: 0,
        truncated: false,
        fields: [],
        elapsedMs: 3,
        rows: [],
        positiveControl: {
          rowCount: 1,
          truncated: false,
          fields: ['id'],
          rows: [{ id: 'known-row' }],
        },
      });
      const positiveControlSql = "SELECT id FROM t WHERE id = 'known-row'";

      const res = await pgQueryTool.handler(
        { sql: 'SELECT id FROM t WHERE false', positiveControlSql } as never,
        {} as never,
      );
      const payload = payloadOf(res as never);

      expect(payload.absence).toEqual({ status: 'verified', code: 'positive-control-passed' });
      expect(payload.positiveControl).toEqual({
        status: 'passed',
        rowCount: 1,
        truncated: false,
        fields: ['id'],
        rows: [{ id: 'known-row' }],
      });
      expect(String(payload.advisory ?? '')).not.toContain('absence unverified');
      expect(pgReadQueryMock).toHaveBeenCalledWith('SELECT id FROM t WHERE false', {
        maxRows: undefined,
        timeoutMs: undefined,
        positiveControlSql,
      });
    });

    it('keeps absence unverified when the supplied positive control is also empty', async () => {
      pgReadQueryMock.mockResolvedValue({
        rowCount: 0,
        truncated: false,
        fields: [],
        elapsedMs: 3,
        rows: [],
        positiveControl: { rowCount: 0, truncated: false, fields: [], rows: [] },
      });

      const res = await pgQueryTool.handler(
        { sql: 'SELECT 1 WHERE false', positiveControlSql: 'SELECT 1 WHERE false' } as never,
        {} as never,
      );
      const payload = payloadOf(res as never);

      expect(payload.absence).toEqual({ status: 'unverified', code: 'positive-control-empty' });
      expect(payload.positiveControl).toMatchObject({ status: 'failed', rowCount: 0 });
      expect(payload.advisory).toContain('positiveControlSql also returned 0 rows');
    });

    it('tenant-checks positiveControlSql before executing either query', async () => {
      advisoryMock.mockImplementation(async (sql: string) =>
        sql.includes('unscoped_control') ? '⚠ tenant scope: control is unscoped' : null,
      );

      const res = await pgQueryTool.handler(
        { sql: 'SELECT 1', positiveControlSql: 'SELECT * FROM unscoped_control' } as never,
        { workspaceId: 'ws-1', harnessSlug: 'h-1' } as never,
      );

      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(payloadOf(res as never)).toMatchObject({ reason: 'positive_control_tenant_scope_required' });
      expect(pgReadQueryMock).not.toHaveBeenCalled();
    });
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

  it('attaches the nullable-jsonb negation advisory to a successful result', async () => {
    const sql =
      "SELECT count(*) FILTER (WHERE NOT (jsonb_typeof(body->'sections') = 'array')) " +
      'FROM harness_shared.coord_event_log';
    const res = await pgQueryTool.handler({ sql, allowUnscoped: true } as never, {} as never);
    expect(payloadOf(res as never).advisory).toContain('nullable jsonb_typeof negation');
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

  it('attaches a guarded session_turn_parts decoder advisory to a successful read', async () => {
    const sql =
      "SELECT text::jsonb FROM harness_shared.session_turn_parts WHERE workspace_id = 'default'";
    const res = await pgQueryTool.handler({ sql, allowUnscoped: true } as never, {} as never);
    expect(payloadOf(res as never).advisory).toContain('unsafe session_turn_parts JSON decode');
    expect(payloadOf(res as never).advisory).toContain('CASE WHEN text IS JSON THEN text::jsonb END');
  });

  it('retains the decoder advisory when the unsafe read fails before returning rows', async () => {
    const sql =
      "SELECT text::jsonb FROM harness_shared.session_turn_parts WHERE workspace_id = 'default'";
    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('invalid input syntax for type json'), { code: '22P02' }),
    );
    const res = await pgQueryTool.handler({ sql, allowUnscoped: true } as never, {} as never);
    expect(payloadOf(res as never)).toMatchObject({
      code: '22P02',
      advisory: expect.stringContaining('unsafe session_turn_parts JSON decode'),
    });
  });

  it('does not advise again after the query uses the guarded decoder', async () => {
    const sql =
      'SELECT CASE WHEN text IS JSON THEN text::jsonb END ' +
      "FROM harness_shared.session_turn_parts WHERE workspace_id = 'default'";
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

  it('redirects the legacy result_json guess to tool_invocations output columns', async () => {
    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('column "result_json" does not exist'), { code: '42703' }),
    );
    describeColumnsMock.mockResolvedValue([
      {
        table: 'harness_shared.tool_invocations',
        columns: ['output_ref: text', 'output_size: bigint', 'metadata_json: jsonb'],
      },
    ]);
    const res = await pgQueryTool.handler(
      { sql: 'SELECT result_json FROM harness_shared.tool_invocations LIMIT 1' } as never,
      {} as never,
    );
    expect(payloadOf(res as never)).toMatchObject({
      code: '42703',
      schemaColumn: expect.stringContaining('output_ref'),
    });
    expect(String(payloadOf(res as never).schemaColumn)).toContain('no inline result JSON');
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
