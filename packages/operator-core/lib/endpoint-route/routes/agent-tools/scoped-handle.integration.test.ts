/**
 * P-062 (per-window-workspace-context-2026-05-31) — deny-by-default workspace
 * isolation, proven against REAL Postgres RLS.
 *
 * The scoped-handle.test.ts sibling proves the *routing decision* in isolation;
 * the tooldef-http http-projection.test.ts proves the *seam wiring*. This test
 * closes the loop the brief's verify clause asks for: that the REAL
 * `chooseScopedHandle` decision, bound to the real DB handles, makes an
 * agent-tool dispatched on a normal bearer call *physically unable* to read
 * another workspace's rows — and that the cross-workspace / superuser / flag-off
 * paths still see everything (behavior-neutral parity).
 *
 * It replicates catchall.ts's `runScoped` body verbatim (catchall.ts:97-99),
 * substituting only the two production handles for the fixture's role-scoped
 * clients — exactly the substitution the org-fixture endorses:
 *   - admin handle      getOrgPg().sql        → db.adminSql  (rolbypassrls)
 *   - workspace handle   withWorkspace(ws, …)  → db.appSql.begin + SET LOCAL GUC
 * We do NOT import the real catchall (its module graph pulls the whole tool
 * registry + the Drizzle `is()` path that throws under vitest — see
 * test/_org-test-db.ts). The decision function under test is the real one, so
 * the matrix → RLS-row-isolation guarantee is end-to-end faithful.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { OrgTestDb } from '../../../../test/_org-test-db';
import {
  chooseScopedHandle,
  isWorkspaceIsolationEnabled,
  type ScopedHandleInput,
} from './scoped-handle';

const { createOrgTestDb } = await import('../../../../test/_org-test-db');

const WS_A = 'ws-iso-a';
const WS_B = 'ws-iso-b';

describe('agent-tools deny-by-default workspace isolation (real PG RLS)', () => {
  let db: OrgTestDb;

  // Faithful replica of catchall.ts's HOST_EXTRAS.runScoped, bound to the
  // fixture's role-scoped clients. `run` receives the handle the tool would
  // see as ctx.tx — exactly what the production seam hands a tool handler.
  async function runScoped<T>(
    scope: ScopedHandleInput,
    opts: { isolationOn?: boolean },
    run: (tx: Sql) => Promise<T>,
  ): Promise<T> {
    const isolationOn = opts.isolationOn ?? isWorkspaceIsolationEnabled();
    const choice = chooseScopedHandle(scope, { isolationOn });
    if (choice.kind === 'admin') return run(db.adminSql);
    return db.appSql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${choice.workspaceId}, true)`;
      return run(tx as unknown as Sql);
    }) as Promise<T>;
  }

  // A stand-in agent-tool handler: read the goals it can see via its ctx.tx.
  const readGoalIds = (tx: Sql) =>
    tx<{ id: string }[]>`SELECT id FROM harness_shared.goals ORDER BY id`.then((rows) =>
      rows.map((r) => r.id),
    );

  beforeAll(async () => {
    db = await createOrgTestDb();
    // Seed two workspaces' goals via the admin (RLS-bypass) handle.
    await db.adminSql`
      INSERT INTO harness_shared.goals (id, install_slug, title, workspace_id) VALUES
        ('a1', 'inst', 'A one', ${WS_A}),
        ('a2', 'inst', 'A two', ${WS_A}),
        ('b1', 'inst', 'B one', ${WS_B}),
        ('b2', 'inst', 'B two', ${WS_B}),
        ('b3', 'inst', 'B three', ${WS_B})
    `;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  const scope = (over: Partial<ScopedHandleInput> = {}): ScopedHandleInput => ({
    workspaceId: WS_A,
    isSuperuser: false,
    tool: {},
    ...over,
  });

  it('admin handle (assertion baseline) sees BOTH workspaces — confirms the rows exist', async () => {
    const ids = await runScoped(scope({ isSuperuser: true }), { isolationOn: true }, readGoalIds);
    expect(ids).toEqual(['a1', 'a2', 'b1', 'b2', 'b3']);
  });

  it('isolation ON + normal bearer (ws-A) → tool sees ONLY ws-A rows, never ws-B', async () => {
    const ids = await runScoped(scope({ workspaceId: WS_A }), { isolationOn: true }, readGoalIds);
    expect(ids).toEqual(['a1', 'a2']);
    expect(ids).not.toContain('b1');
  });

  it('isolation ON + normal bearer (ws-B) → tool sees ONLY ws-B rows, never ws-A', async () => {
    const ids = await runScoped(scope({ workspaceId: WS_B }), { isolationOn: true }, readGoalIds);
    expect(ids).toEqual(['b1', 'b2', 'b3']);
    expect(ids).not.toContain('a1');
  });

  it('isolation ON + crossWorkspace tool → admin handle → sees ALL workspaces (opt-out)', async () => {
    const ids = await runScoped(
      scope({ workspaceId: WS_A, tool: { crossWorkspace: true } }),
      { isolationOn: true },
      readGoalIds,
    );
    expect(ids).toEqual(['a1', 'a2', 'b1', 'b2', 'b3']);
  });

  it('isolation ON + superuser → admin handle → sees ALL workspaces', async () => {
    const ids = await runScoped(scope({ workspaceId: WS_A, isSuperuser: true }), { isolationOn: true }, readGoalIds);
    expect(ids).toEqual(['a1', 'a2', 'b1', 'b2', 'b3']);
  });

  it("isolation ON + no concrete workspace ('*') → admin handle → sees ALL (withWorkspace would throw)", async () => {
    const ids = await runScoped(scope({ workspaceId: '*' }), { isolationOn: true }, readGoalIds);
    expect(ids).toEqual(['a1', 'a2', 'b1', 'b2', 'b3']);
  });

  it('kill-switch OFF → admin handle even for a normal call → behavior-neutral (sees ALL)', async () => {
    const ids = await runScoped(scope({ workspaceId: WS_A }), { isolationOn: false }, readGoalIds);
    expect(ids).toEqual(['a1', 'a2', 'b1', 'b2', 'b3']);
  });

  it('write isolation (WITH CHECK): a scoped ws-A call cannot INSERT a ws-B-tagged row', async () => {
    await expect(
      runScoped(scope({ workspaceId: WS_A }), { isolationOn: true }, (tx) =>
        tx`INSERT INTO harness_shared.goals (id, install_slug, title, workspace_id)
            VALUES ('x1', 'inst', 'cross-write', ${WS_B})`,
      ),
    ).rejects.toThrow();
    // And the forbidden row never landed (admin view confirms).
    const leaked = await db.adminSql<{ id: string }[]>`SELECT id FROM harness_shared.goals WHERE id = 'x1'`;
    expect(leaked).toHaveLength(0);
  });
});
