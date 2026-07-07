/**
 * dev:pg_query handler wiring — the P-005 point-of-use guards ride the payload:
 * the tenant-scope ADVISORY on a successful read, and the referenced tables'
 * canonical column lists (knownColumns) on a 42703. The guard machinery itself
 * is unit-tested in pg-read-query.test.ts; this pins the handler contract —
 * where the fields land and that a guard failure never breaks the result.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { pgReadQueryMock, advisoryMock, describeColumnsMock } = vi.hoisted(() => ({
  pgReadQueryMock: vi.fn(),
  advisoryMock: vi.fn(),
  describeColumnsMock: vi.fn(),
}));

vi.mock('../../pg-read-query', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pgReadQuery: pgReadQueryMock,
  buildTenantScopeAdvisory: advisoryMock,
  describeReferencedTableColumns: describeColumnsMock,
}));

import pgQueryTool from './pg_query';

const OK_RESULT = { rowCount: 1, truncated: false, fields: ['x'], elapsedMs: 3, rows: [{ x: 1 }] };

function payloadOf(res: { content: Array<{ type: string; text: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

beforeEach(() => {
  pgReadQueryMock.mockReset().mockResolvedValue(OK_RESULT);
  advisoryMock.mockReset().mockResolvedValue(null);
  describeColumnsMock.mockReset().mockResolvedValue([]);
});

describe('dev:pg_query — P-005 guard wiring', () => {
  it('attaches the tenant-scope advisory to a successful result', async () => {
    advisoryMock.mockResolvedValue('⚠ tenant scope: …');
    const res = await pgQueryTool.handler({ sql: 'SELECT 1' } as never, {} as never);
    expect(payloadOf(res as never)).toMatchObject({ advisory: '⚠ tenant scope: …', rowCount: 1 });
  });

  it('omits the advisory field when the guard finds nothing (or throws)', async () => {
    const clean = await pgQueryTool.handler({ sql: 'SELECT 1' } as never, {} as never);
    expect(payloadOf(clean as never)).not.toHaveProperty('advisory');

    advisoryMock.mockRejectedValue(new Error('schema read down'));
    const guarded = await pgQueryTool.handler({ sql: 'SELECT 1' } as never, {} as never);
    expect(payloadOf(guarded as never)).toMatchObject({ rowCount: 1 });
  });

  it('a 42703 error carries knownColumns for the referenced tables', async () => {
    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('column "updated_at" does not exist'), { code: '42703' }),
    );
    describeColumnsMock.mockResolvedValue([
      { table: 'harness_shared.engineer_issues', columns: ['issue_id', 'updated_ts'] },
    ]);
    const res = await pgQueryTool.handler(
      { sql: 'SELECT updated_at FROM harness_shared.engineer_issues' } as never,
      {} as never,
    );
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(payloadOf(res as never)).toMatchObject({
      code: '42703',
      knownColumns: { 'harness_shared.engineer_issues': ['issue_id', 'updated_ts'] },
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
});
