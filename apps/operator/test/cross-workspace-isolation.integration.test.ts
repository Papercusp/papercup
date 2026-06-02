/**
 * cross-workspace-isolation.integration.test.ts — plan
 * harness-test-coverage-for-launch P-005 (RLS half).
 *
 * Proves the PG-layer workspace isolation that the whole multi-tenant model
 * rests on: under workspace B's scope (harness_app + app.workspace_id GUC, the
 * exact contract `withWorkspace` enforces), workspace A's rows are invisible and
 * unwritable; a query with NO GUC sees nothing. This supersedes the agent-mcp
 * `cross-workspace-probe.test.ts`, which was hard-EXCLUDED from vitest (its
 * `@papercusp/db-org/workspace-context` import didn't resolve there) and so ran
 * nowhere. Here it runs over a real migrated DB via the createOrgTestDb fixture.
 *
 * (The dispatch-layer half of P-005 — a bearer scopes to the PRINCIPAL's
 * workspace with no caller-supplied channel — is covered by P-022's
 * server-dispatch.test.ts.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from './_org-test-db';

const WS_A = 'test-ws-a';
const WS_B = 'test-ws-b';

let db: OrgTestDb;

// Reproduce withWorkspace's app-role + transaction-local GUC scoping against the
// fixture's harness_app client (the real withWorkspace can't build Drizzle under
// vitest — see _org-test-db.ts / plan D-004).
async function inWorkspace<T>(ws: string, cb: (tx: PgTx) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (db.appSql as any).begin(async (tx: PgTx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    return cb(tx);
  }) as Promise<T>;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PgTx = any;

beforeAll(async () => {
  db = await createOrgTestDb();
  // Seed two workspaces' rows via the admin (RLS-bypass) client.
  await db.adminSql`
    INSERT INTO harness_shared.projects (id, slug, name, status, created_ts, updated_ts, workspace_id)
    VALUES ('proj-a', 'proj-a', 'Workspace A Project', 'active', 0, 0, ${WS_A}),
           ('proj-b', 'proj-b', 'Workspace B Project', 'active', 0, 0, ${WS_B})
    ON CONFLICT (id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id, name = EXCLUDED.name`;
  await db.adminSql`
    INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
    VALUES ('aud-a', 0, 'system:test', 'noop', 'proj-a', '{}'::jsonb, ${WS_A}),
           ('aud-b', 0, 'system:test', 'noop', 'proj-b', '{}'::jsonb, ${WS_B})
    ON CONFLICT (id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id`;
}, 90_000);

afterAll(async () => {
  if (db) await db.cleanup();
});

describe('cross-workspace RLS isolation (P-005)', () => {
  it("cannot SELECT another workspace's project", async () => {
    const rows = await inWorkspace(WS_B, (tx) => tx`SELECT id FROM harness_shared.projects WHERE id = 'proj-a'`);
    expect(rows).toHaveLength(0);
  });

  it("CAN SELECT its own workspace's project", async () => {
    const rows = await inWorkspace(WS_B, (tx) => tx`SELECT id FROM harness_shared.projects WHERE id = 'proj-b'`);
    expect(rows).toHaveLength(1);
  });

  it("cannot UPDATE another workspace's project (RLS silently affects 0 rows)", async () => {
    await inWorkspace(WS_B, (tx) => tx`UPDATE harness_shared.projects SET name = 'hijacked' WHERE id = 'proj-a'`);
    const check = await db.adminSql`SELECT name FROM harness_shared.projects WHERE id = 'proj-a'`;
    expect(check[0].name).toBe('Workspace A Project'); // untouched
  });

  it('audit_log is workspace-isolated the same way', async () => {
    const cross = await inWorkspace(WS_B, (tx) => tx`SELECT id FROM harness_shared.audit_log WHERE id = 'aud-a'`);
    expect(cross).toHaveLength(0);
    const own = await inWorkspace(WS_B, (tx) => tx`SELECT id FROM harness_shared.audit_log WHERE id = 'aud-b'`);
    expect(own).toHaveLength(1);
  });

  it('a query with NO app.workspace_id GUC sees nothing (RLS predicate is false on a null GUC)', async () => {
    // Direct harness_app query, no withWorkspace/GUC — the workspace filter
    // `workspace_id = current_setting('app.workspace_id', true)` is NULL → no rows.
    const rows = await db.appSql`SELECT id FROM harness_shared.projects WHERE id IN ('proj-a', 'proj-b')`;
    expect(rows).toHaveLength(0);
  });
});
