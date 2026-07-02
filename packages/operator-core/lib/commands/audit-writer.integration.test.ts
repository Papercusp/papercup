/**
 * audit-writer.integration.test.ts — the agent audit-log PG inserter
 * (`harness_shared.agent_actions` + `agent_queries`) against real Postgres.
 *
 * writeAuditRows routes through `withWorkspace(ws, cb)`, so we mock db-org's
 * withWorkspace to run the callback against the org-fixture's admin client
 * scoped to a per-test workspace (the established withWorkspace-mock pattern;
 * see voice-utterance-log.integration.test.ts). Validates: action rows insert
 * with the jsonb args round-tripping, query rows insert with args_compact (and
 * NULL when undefined), the empty-input early return, and that a multi-row batch
 * persists all rows.
 *
 * Part of whole-app-test-coverage-breadth-2026-06-14 P-006 (integration tier).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown, ws: 'ws-audit-default' }));

// withWorkspace runs its callback with a workspace-scoped tx; point it at the
// fixture admin client. activeWorkspaceId is pinned per test via h.ws.
vi.mock('@papercusp/db-org', () => ({
  withWorkspace: async <T>(_ws: string, cb: (tx: unknown) => Promise<T>): Promise<T> => cb(h.sql),
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => h.ws }));

const { writeAuditRows } = await import('./audit-writer');
const { createOrgTestDb } = await import('../../test/_org-test-db');

describe('agent audit-log writer (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('is a no-op when both lists are empty (no rows, no throw)', async () => {
    h.ws = 'ws-audit-empty';
    await expect(writeAuditRows([], [])).resolves.toBeUndefined();
    const a = await db.adminSql`SELECT count(*)::int AS n FROM harness_shared.agent_actions WHERE workspace_id = 'ws-audit-empty'`;
    expect((a[0] as { n: number }).n).toBe(0);
  });

  it('inserts an action row with jsonb args round-tripping', async () => {
    h.ws = 'ws-audit-action';
    await writeAuditRows(
      [
        {
          id: 'plans:get',
          agent: 'operator' as never,
          workspace: 'ws-audit-action',
          sessionId: 'sess-1',
          requestId: 'req-1',
          args: { slug: 'demo', limit: 5 },
          status: 'ok',
          durationMs: 42,
        },
      ],
      [],
    );
    const rows = await db.adminSql<
      Array<{ command_id: string; args: Record<string, unknown>; status: string; duration_ms: number; session_id: string; request_id: string }>
    >`
      SELECT command_id, args, status, duration_ms, session_id, request_id
        FROM harness_shared.agent_actions WHERE workspace_id = 'ws-audit-action'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].command_id).toBe('plans:get');
    expect(rows[0].args).toEqual({ slug: 'demo', limit: 5 }); // real jsonb, not a string scalar
    expect(rows[0].status).toBe('ok');
    expect(rows[0].duration_ms).toBe(42);
    expect(rows[0].session_id).toBe('sess-1');
  });

  it('inserts a failed action with error_code + null session_id', async () => {
    h.ws = 'ws-audit-err';
    await writeAuditRows(
      [
        {
          id: 'plans:set',
          agent: 'operator' as never,
          workspace: 'ws-audit-err',
          requestId: 'req-err',
          args: {},
          status: 'err',
          errorCode: 'E_BOOM',
          durationMs: 7,
        },
      ],
      [],
    );
    const rows = await db.adminSql<Array<{ status: string; error_code: string | null; session_id: string | null }>>`
      SELECT status, error_code, session_id FROM harness_shared.agent_actions WHERE workspace_id = 'ws-audit-err'`;
    expect(rows[0].status).toBe('err');
    expect(rows[0].error_code).toBe('E_BOOM');
    expect(rows[0].session_id).toBeNull();
  });

  it('inserts a query row with args_compact, and NULL when args undefined', async () => {
    h.ws = 'ws-audit-query';
    await writeAuditRows(
      [],
      [
        { id: 'features:list', agent: 'operator' as never, workspace: 'ws-audit-query', requestId: 'q-1', args: { tag: 'x' }, sample: true },
        { id: 'features:search', agent: 'operator' as never, workspace: 'ws-audit-query', requestId: 'q-2', sample: false },
      ],
    );
    const rows = await db.adminSql<Array<{ query_id: string; args_compact: Record<string, unknown> | null }>>`
      SELECT query_id, args_compact FROM harness_shared.agent_queries
       WHERE workspace_id = 'ws-audit-query' ORDER BY query_id`;
    expect(rows).toHaveLength(2);
    const byId = Object.fromEntries(rows.map((r) => [r.query_id, r.args_compact]));
    expect(byId['features:list']).toEqual({ tag: 'x' });
    expect(byId['features:search']).toBeNull();
  });

  it('persists every row of a multi-row action batch', async () => {
    h.ws = 'ws-audit-batch';
    await writeAuditRows(
      [0, 1, 2].map((i) => ({
        id: `cmd-${i}`,
        agent: 'operator' as never,
        workspace: 'ws-audit-batch',
        requestId: `r-${i}`,
        args: { i },
        status: 'ok' as const,
        durationMs: i,
      })),
      [],
    );
    const rows = await db.adminSql`SELECT count(*)::int AS n FROM harness_shared.agent_actions WHERE workspace_id = 'ws-audit-batch'`;
    expect((rows[0] as { n: number }).n).toBe(3);
  });
});
