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

  // ── EI-280: pre-fix blank-stamp legacy rows ────────────────────────────────
  // Rows written before P-012 carry workspace_id='' — invisible to load and a
  // poison pill for save's upsert. Three legs close the class: migration 221
  // backfills per registration, the admin write path stamps ctx.workspaceId
  // instead of minting '', and the conflict arm adopts blank rows.

  it('EI-280: migration 221 backfills a blank legacy row per harness registration', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { resolve, dirname } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const migration = readFileSync(
      resolve(here, '../../../../../../libs/papercusp/libs/db/sql/221-backfill-text-artifacts-workspace-id.sql'),
      'utf8',
    );
    // Register the slug (leg-1 mapping source) + seed a pre-fix blank row.
    await db.adminSql`
      INSERT INTO harness_shared.projects (id, name, status, created_ts, updated_ts, slug, workspace_id)
      VALUES ('proj-legacy-h', 'legacy', 'active', 1, 1, 'legacy-h', ${WS_A})
      ON CONFLICT (id) DO UPDATE SET workspace_id = ${WS_A}
    `;
    await db.adminSql`
      INSERT INTO harness_shared.harness_text_artifacts (harness_slug, rel_path, content, updated_at, workspace_id)
      VALUES ('legacy-h', 'old.md', 'pre-fix content', 1, '')
    `;
    // Invisible before the backfill…
    const before = await callInWorkspace(WS_A, (tx) =>
      tool('artifacts:load').fn({ slug: 'legacy-h', rel_path: 'old.md' }, ctxWith(tx, WS_A)),
    );
    expect(payloadOf(before as never).found).toBe(false);
    // …run the (idempotent) migration…
    await db.adminSql.unsafe(migration);
    // …now visible from the registered workspace, and the upsert works.
    const after = await callInWorkspace(WS_A, (tx) =>
      tool('artifacts:load').fn({ slug: 'legacy-h', rel_path: 'old.md' }, ctxWith(tx, WS_A)),
    );
    expect(payloadOf(after as never).content).toBe('pre-fix content');
    await callInWorkspace(WS_A, (tx) =>
      tool('artifacts:save').fn(
        { slug: 'legacy-h', rel_path: 'old.md', content: 'updated post-backfill' },
        ctxWith(tx, WS_A),
      ),
    );
    const rows = await db.adminSql<{ content: string; workspace_id: string }[]>`
      SELECT content, workspace_id FROM harness_shared.harness_text_artifacts
       WHERE harness_slug = 'legacy-h' AND rel_path = 'old.md'
    `;
    expect(rows[0]).toEqual({ content: 'updated post-backfill', workspace_id: WS_A });
  });

  it('EI-280: an unregistered slug falls through to the default workspace', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { resolve, dirname } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const migration = readFileSync(
      resolve(here, '../../../../../../libs/papercusp/libs/db/sql/221-backfill-text-artifacts-workspace-id.sql'),
      'utf8',
    );
    await db.adminSql`
      INSERT INTO harness_shared.harness_text_artifacts (harness_slug, rel_path, content, updated_at, workspace_id)
      VALUES ('never-registered-h', 'orphan.md', 'x', 1, '')
    `;
    await db.adminSql.unsafe(migration);
    const rows = await db.adminSql<{ workspace_id: string }[]>`
      SELECT workspace_id FROM harness_shared.harness_text_artifacts
       WHERE harness_slug = 'never-registered-h' AND rel_path = 'orphan.md'
    `;
    expect(rows[0].workspace_id).toBe('default');
  });

  it('EI-280: the admin write path stamps ctx.workspaceId, never blank', async () => {
    // Superuser/cross-workspace dispatch runs on the admin handle with no
    // GUC — the original COALESCE(...,'') minted the blank rows. The
    // fallback now stamps ctx.workspaceId ('*' is not a stamp).
    await tool('artifacts:save').fn(
      { slug: SLUG, rel_path: 'admin-written.md', content: 'by-admin' },
      ctxWith(db.adminSql, WS_A),
    );
    const rows = await db.adminSql<{ workspace_id: string }[]>`
      SELECT workspace_id FROM harness_shared.harness_text_artifacts
       WHERE harness_slug = ${SLUG} AND rel_path = 'admin-written.md'
    `;
    expect(rows[0].workspace_id).toBe(WS_A);
  });

  it('EI-280: save on the admin handle ADOPTS a blank-stamped row instead of bricking', async () => {
    await db.adminSql`
      INSERT INTO harness_shared.harness_text_artifacts (harness_slug, rel_path, content, updated_at, workspace_id)
      VALUES (${SLUG}, 'blank-legacy.md', 'old', 1, '')
    `;
    await tool('artifacts:save').fn(
      { slug: SLUG, rel_path: 'blank-legacy.md', content: 'adopted' },
      ctxWith(db.adminSql, WS_B),
    );
    const rows = await db.adminSql<{ content: string; workspace_id: string }[]>`
      SELECT content, workspace_id FROM harness_shared.harness_text_artifacts
       WHERE harness_slug = ${SLUG} AND rel_path = 'blank-legacy.md'
    `;
    expect(rows[0]).toEqual({ content: 'adopted', workspace_id: WS_B });
  });
});
