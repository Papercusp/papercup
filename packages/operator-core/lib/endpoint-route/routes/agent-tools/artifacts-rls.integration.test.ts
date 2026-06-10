/**
 * Audit P-012 — artifacts:save/append/load/delete used the `getOrgPg()`
 * admin handle (rolbypassrls), silently bypassing harness_text_artifacts'
 * workspace-isolation RLS policy: any workspace's bearer could read/write/
 * delete any other workspace's artifacts. The handlers now run on `ctx.tx`
 * (the host-chosen handle — `withWorkspace` under isolation), so the policy
 * actually applies.
 *
 * This file is the cross-workspace DENIAL proof on real Postgres RLS,
 * sibling to scoped-handle.integration.test.ts (which proves the routing
 * decision): a ws-A write is invisible/undeletable from ws-B through the
 * REAL tool handlers, and the admin handle (superuser/cross-workspace
 * dispatch) retains its view.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { OrgTestDb } from '../../../../test/_org-test-db';
import { lookupByMcpName } from '@papercusp/tooldef';

// Side-effect imports register the tools into the projection registry. Post
// P-012 these modules import only zod + tooldef (no db-org/Drizzle graph),
// so they are safe to load here.
// eslint-disable-next-line import/no-relative-packages
import '../../../../../agent-mcp/src/tools/artifacts/save';
// eslint-disable-next-line import/no-relative-packages
import '../../../../../agent-mcp/src/tools/artifacts/append';
// eslint-disable-next-line import/no-relative-packages
import '../../../../../agent-mcp/src/tools/artifacts/load';
// eslint-disable-next-line import/no-relative-packages
import '../../../../../agent-mcp/src/tools/artifacts/delete';

const { createOrgTestDb } = await import('../../../../test/_org-test-db');

const WS_A = 'ws-art-a';
const WS_B = 'ws-art-b';
const SLUG = 'rls-h';
const REL = 'notes.md';

describe('artifacts:* cross-workspace denial via ctx.tx + RLS (audit P-012)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  /** Run a tool handler the way the production seam does: ctx.tx bound to a
   *  workspace-scoped transaction (harness_app role + GUC). */
  async function callInWorkspace<T>(ws: string, run: (tx: Sql) => Promise<T>): Promise<T> {
    return db.appSql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      return run(tx as unknown as Sql);
    }) as Promise<T>;
  }

  function ctxWith(tx: Sql, ws: string) {
    return {
      log: () => {},
      signal: new AbortController().signal,
      progress: () => {},
      emit: () => {},
      workspaceId: ws,
      harnessSlug: SLUG,
      role: 'operator',
      tx,
    } as never;
  }

  const payloadOf = (r: { content: Array<{ text: string }> }) =>
    JSON.parse(r.content[0].text) as Record<string, unknown>;

  const tool = (name: string) => lookupByMcpName(name)!;

  it('ws-A saves an artifact; the row lands stamped with ws-A', async () => {
    const r = await callInWorkspace(WS_A, (tx) =>
      tool('artifacts:save').fn(
        { slug: SLUG, rel_path: REL, content: 'secret-A' },
        ctxWith(tx, WS_A),
      ),
    );
    expect(payloadOf(r as never).bytes).toBe('secret-A'.length);
    const rows = await db.adminSql<{ workspace_id: string; content: string }[]>`
      SELECT workspace_id, content FROM harness_shared.harness_text_artifacts
       WHERE harness_slug = ${SLUG} AND rel_path = ${REL}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].workspace_id).toBe(WS_A);
    expect(rows[0].content).toBe('secret-A');
  });

  it('ws-A loads its own artifact back', async () => {
    const r = await callInWorkspace(WS_A, (tx) =>
      tool('artifacts:load').fn({ slug: SLUG, rel_path: REL }, ctxWith(tx, WS_A)),
    );
    const p = payloadOf(r as never);
    expect(p.found).toBe(true);
    expect(p.content).toBe('secret-A');
  });

  it('DENIAL: ws-B cannot read ws-A\'s artifact (found:false, not an error)', async () => {
    const r = await callInWorkspace(WS_B, (tx) =>
      tool('artifacts:load').fn({ slug: SLUG, rel_path: REL }, ctxWith(tx, WS_B)),
    );
    const p = payloadOf(r as never);
    expect(p.found).toBe(false);
    expect(p.content).toBeNull();
  });

  it('DENIAL: ws-B cannot delete ws-A\'s artifact (deleted:false, row intact)', async () => {
    const r = await callInWorkspace(WS_B, (tx) =>
      tool('artifacts:delete').fn({ slug: SLUG, rel_path: REL }, ctxWith(tx, WS_B)),
    );
    expect(payloadOf(r as never).deleted).toBe(false);
    const rows = await db.adminSql`
      SELECT 1 FROM harness_shared.harness_text_artifacts
       WHERE harness_slug = ${SLUG} AND rel_path = ${REL} AND workspace_id = ${WS_A}
    `;
    expect(rows).toHaveLength(1);
  });

  it('DENIAL: ws-B cannot append onto ws-A\'s (slug, rel_path) — RLS rejects the upsert; content unchanged', async () => {
    // The PK is (harness_slug, rel_path) without workspace_id, so ws-B's
    // INSERT conflicts with ws-A's row; the ON CONFLICT UPDATE then targets
    // a row ws-B's policy cannot see/modify → Postgres raises rather than
    // letting B clobber A.
    await expect(
      callInWorkspace(WS_B, (tx) =>
        tool('artifacts:append').fn(
          { slug: SLUG, rel_path: REL, suffix: '-B-was-here' },
          ctxWith(tx, WS_B),
        ),
      ),
    ).rejects.toThrow();
    const rows = await db.adminSql<{ content: string }[]>`
      SELECT content FROM harness_shared.harness_text_artifacts
       WHERE harness_slug = ${SLUG} AND rel_path = ${REL}
    `;
    expect(rows[0].content).toBe('secret-A');
  });

  it('ws-B in its OWN namespace works normally (write + read back)', async () => {
    await callInWorkspace(WS_B, (tx) =>
      tool('artifacts:save').fn(
        { slug: SLUG, rel_path: 'b-own.md', content: 'b-content' },
        ctxWith(tx, WS_B),
      ),
    );
    const r = await callInWorkspace(WS_B, (tx) =>
      tool('artifacts:load').fn({ slug: SLUG, rel_path: 'b-own.md' }, ctxWith(tx, WS_B)),
    );
    expect(payloadOf(r as never).content).toBe('b-content');
  });

  it('admin handle (superuser/cross-workspace dispatch) still reads across workspaces', async () => {
    const r = (await tool('artifacts:load').fn(
      { slug: SLUG, rel_path: REL },
      ctxWith(db.adminSql, '*'),
    )) as never;
    const p = payloadOf(r);
    expect(p.found).toBe(true);
    expect(p.content).toBe('secret-A');
  });
});
