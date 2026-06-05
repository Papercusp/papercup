/**
 * git-export.integration.test.ts (plan harness-state-storage-unification, P-003b).
 * Real testcontainer PG. Proves the end-to-end git-export vertical:
 *   capture trigger → git_export_outbox → drainer → .papercusp/state/<…> file,
 * the echo-loop guard (remote-origin writes skipped), and DELETE → file removal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import {
  ensureGitExportOutbox,
  attachGitCaptureTrigger,
  detachStaleGitCaptureTriggers,
} from './ensure-git-outbox';
import { drainGitExportOnce } from './drainer';
import { hydrateGitTable } from './hydrate';
import { gcOrphanOutboxRows } from './gc';
import { parseFile, gitFilePath } from './serialize';

const WS = 'ws_git';
const SLUG = 'githarness';

describe('git-export integration (P-003b): trigger → outbox → drainer → file', () => {
  let db: FreshPgDb;
  let root: string;

  beforeAll(async () => {
    db = await createFreshPgDb('git_export');
    root = await mkdtemp(join(tmpdir(), 'git-export-'));
    await db.sql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
    // a synthetic prose (decisions-shaped) git table
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.harness_decisions (
        id TEXT PRIMARY KEY, workspace_id TEXT, harness_slug TEXT, origin TEXT,
        title TEXT, content TEXT, ts BIGINT
      )`);
    await ensureGitExportOutbox(db.sql);
    await attachGitCaptureTrigger(db.sql, 'harness_decisions', ['id']);
    // a synthetic composite-PK (chunk-plans-shaped) structured git table
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.harness_chunk_plans (
        workspace_id TEXT, harness_slug TEXT, origin TEXT,
        feature_id TEXT, chunk_id TEXT, plan JSONB,
        PRIMARY KEY (workspace_id, harness_slug, feature_id, chunk_id)
      )`);
    await attachGitCaptureTrigger(db.sql, 'harness_chunk_plans', ['feature_id', 'chunk_id']);
  }, 90_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('INSERT → outbox row → drainer writes a round-trippable .md file', async () => {
    await db.sql`
      INSERT INTO harness_shared.harness_decisions (id, workspace_id, harness_slug, origin, title, content, ts)
      VALUES ('D-001', ${WS}, ${SLUG}, 'local', 'T', '# Use PG\n\nruntime store-of-record', 1)`;

    const ob = await db.sql<{ op: string; key: string; table_name: string }[]>`
      SELECT op, key, table_name FROM harness_shared.git_export_outbox`;
    expect(ob.length).toBe(1);
    expect(ob[0]).toMatchObject({ op: 'put', key: 'D-001', table_name: 'harness_decisions' });

    const res = await drainGitExportOnce({ sql: db.sql, workspaceId: WS, harnessSlug: SLUG, harnessRoot: root });
    expect(res.exported).toBe(1);
    expect(res.changedPaths).toEqual([gitFilePath('harness_decisions', 'D-001')]);

    const abs = join(root, gitFilePath('harness_decisions', 'D-001'));
    const parsed = parseFile('harness_decisions', await readFile(abs, 'utf8'));
    // context cols (workspace_id/harness_slug/origin) are stripped from the file.
    expect(parsed).toMatchObject({ id: 'D-001', title: 'T', content: '# Use PG\n\nruntime store-of-record' });
    expect(parsed).not.toHaveProperty('harness_slug');
    expect(parsed).not.toHaveProperty('workspace_id');

    // second drain is a no-op (exported_at marked)
    const res2 = await drainGitExportOnce({ sql: db.sql, workspaceId: WS, harnessSlug: SLUG, harnessRoot: root });
    expect(res2.exported).toBe(0);
  });

  it('echo-loop guard: remote-origin writes are NOT captured', async () => {
    await db.sql`
      INSERT INTO harness_shared.harness_decisions (id, workspace_id, harness_slug, origin, content, ts)
      VALUES ('D-remote', ${WS}, ${SLUG}, 'remote', 'x', 1)`;
    const ob = await db.sql`SELECT key FROM harness_shared.git_export_outbox WHERE key = 'D-remote'`;
    expect(ob.length).toBe(0);
  });

  it('DELETE → drainer removes the file', async () => {
    await db.sql`DELETE FROM harness_shared.harness_decisions WHERE id = 'D-001'`;
    const res = await drainGitExportOnce({ sql: db.sql, workspaceId: WS, harnessSlug: SLUG, harnessRoot: root });
    expect(res.deleted).toBe(1);
    const abs = join(root, gitFilePath('harness_decisions', 'D-001'));
    await expect(stat(abs)).rejects.toBeTruthy();
  });

  it('composite key → "__"-joined leaf + round-trippable json file', async () => {
    await db.sql`
      INSERT INTO harness_shared.harness_chunk_plans (workspace_id, harness_slug, origin, feature_id, chunk_id, plan)
      VALUES (${WS}, ${SLUG}, 'local', 'F-9', 'c3', ${db.sql.json({ a: 1 })})`;
    const ob = await db.sql<{ key: string }[]>`
      SELECT key FROM harness_shared.git_export_outbox WHERE table_name = 'harness_chunk_plans'`;
    expect(ob[0]?.key).toBe('F-9__c3');
    const res = await drainGitExportOnce({ sql: db.sql, workspaceId: WS, harnessSlug: SLUG, harnessRoot: root });
    expect(res.exported).toBe(1);
    const abs = join(root, gitFilePath('harness_chunk_plans', 'F-9__c3'));
    const parsed = parseFile('harness_chunk_plans', await readFile(abs, 'utf8'));
    expect(parsed).toMatchObject({ feature_id: 'F-9', chunk_id: 'c3', plan: { a: 1 } });
  });

  it('hydrate: file → PG (clone-and-go) restores a deleted row', async () => {
    await db.sql`
      INSERT INTO harness_shared.harness_decisions (id, workspace_id, harness_slug, origin, title, content, ts)
      VALUES ('D-rt', ${WS}, ${SLUG}, 'local', 'RT', 'body text\n\nx', 7)`;
    await drainGitExportOnce({ sql: db.sql, workspaceId: WS, harnessSlug: SLUG, harnessRoot: root }); // → file
    // simulate a fresh clone: file present, PG row gone
    await db.sql`DELETE FROM harness_shared.harness_decisions WHERE id = 'D-rt'`;
    expect((await db.sql`SELECT 1 FROM harness_shared.harness_decisions WHERE id='D-rt'`).length).toBe(0);

    const n = await hydrateGitTable({
      sql: db.sql, harnessRoot: root, table: 'harness_decisions', conflictCols: ['id'],
      workspaceId: WS, harnessSlug: SLUG,
    });
    expect(n).toBeGreaterThanOrEqual(1);
    const after = await db.sql<
      { id: string; title: string; content: string; workspace_id: string; harness_slug: string; origin: string }[]
    >`
      SELECT id, title, content, workspace_id, harness_slug, origin
        FROM harness_shared.harness_decisions WHERE id = 'D-rt'`;
    // content restored; context/provenance cols re-injected from the harness context.
    expect(after[0]).toMatchObject({
      id: 'D-rt', title: 'RT', content: 'body text\n\nx',
      workspace_id: WS, harness_slug: SLUG, origin: 'remote',
    });
  });

  it('no-op guard: an UPDATE that changes nothing produces no new outbox row (re-upsert amplification)', async () => {
    await db.sql`
      INSERT INTO harness_shared.harness_decisions (id, workspace_id, harness_slug, origin, title, content, ts)
      VALUES ('D-noop', ${WS}, ${SLUG}, 'local', 'T', 'body', 1)`;
    await drainGitExportOnce({ sql: db.sql, workspaceId: WS, harnessSlug: SLUG, harnessRoot: root });
    const countRows = () =>
      db.sql<{ c: number }[]>`
        SELECT count(*)::int AS c FROM harness_shared.git_export_outbox
         WHERE table_name = 'harness_decisions' AND key = 'D-noop'`.then((r) => r[0].c);
    const before = await countRows();
    // a genuine no-op UPDATE (every column set to its current value)
    await db.sql`UPDATE harness_shared.harness_decisions SET content = content WHERE id = 'D-noop'`;
    expect(await countRows()).toBe(before); // no capture for a no-op
    // a REAL change still captures
    await db.sql`UPDATE harness_shared.harness_decisions SET content = 'changed' WHERE id = 'D-noop'`;
    expect(await countRows()).toBe(before + 1);
  });

  it('detach-stale: drops the capture trigger from tables no longer in GIT_TABLES, keeps current ones', async () => {
    // simulate a table that was once (mis)classified sync:'git' and wrongly attached.
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.harness_branch_actions (
        workspace_id TEXT, harness_slug TEXT, origin TEXT,
        branch TEXT, payload JSONB, last_check_ms BIGINT,
        PRIMARY KEY (harness_slug, branch)
      )`);
    await attachGitCaptureTrigger(db.sql, 'harness_branch_actions', ['branch']);
    const hasTrigger = (tbl: string) =>
      db.sql<{ c: number }[]>`
        SELECT count(*)::int AS c FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'harness_shared'
           AND c.relname = ${tbl}
           AND t.tgname = 'capture_git_export_outbox_trg'
           AND NOT t.tgisinternal`.then((r) => r[0].c > 0);
    expect(await hasTrigger('harness_branch_actions')).toBe(true);

    const { detached } = await detachStaleGitCaptureTriggers(db.sql);
    expect(detached).toContain('harness_branch_actions');
    expect(await hasTrigger('harness_branch_actions')).toBe(false);
    // a genuine GIT_TABLES member keeps its trigger.
    expect(await hasTrigger('harness_decisions')).toBe(true);
  });

  it('P-008 GC: deletes orphan outbox rows from non-registry harnesses, keeps live ones', async () => {
    // seed outbox rows for a LIVE (registry) harness + an EPHEMERAL orphan harness.
    await db.sql`
      INSERT INTO harness_shared.git_export_outbox (workspace_id, harness_slug, table_name, op, key, row, ts)
      VALUES
        (${WS}, ${SLUG},          'harness_decisions', 'put', 'live-1',   ${db.sql.json({})}, 1),
        (${WS}, 'gymsmoke-eph01', 'harness_decisions', 'put', 'orphan-1', ${db.sql.json({})}, 1),
        (${WS}, 'gymsmoke-eph01', 'harness_lanes',     'put', 'orphan-2', ${db.sql.json({})}, 1)`;

    // guard: an empty live list is a no-op (never GC-everything on a failed resolve)
    const noop = await gcOrphanOutboxRows(db.sql, []);
    expect(noop.deleted).toBe(0);

    const gc = await gcOrphanOutboxRows(db.sql, [{ workspaceId: WS, harnessSlug: SLUG }]);
    expect(gc.deleted).toBe(2); // the two gymsmoke-eph01 rows
    expect(gc.orphans).toContain(`${WS}::gymsmoke-eph01`);

    const live = await db.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM harness_shared.git_export_outbox
       WHERE workspace_id = ${WS} AND harness_slug = ${SLUG} AND key = 'live-1'`;
    expect(live[0].c).toBe(1); // the registry harness's row is untouched
    const orphan = await db.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM harness_shared.git_export_outbox WHERE harness_slug = 'gymsmoke-eph01'`;
    expect(orphan[0].c).toBe(0);
  });

  it('hydrate does NOT re-enqueue an export (capture trigger disabled during load)', async () => {
    const q = db.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM harness_shared.git_export_outbox
       WHERE table_name = 'harness_decisions' AND key = 'D-rt' AND op = 'put'`;
    const before = (await q)[0].c;
    await hydrateGitTable({
      sql: db.sql, harnessRoot: root, table: 'harness_decisions', conflictCols: ['id'],
      workspaceId: WS, harnessSlug: SLUG,
    });
    const after = (await db.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM harness_shared.git_export_outbox
       WHERE table_name = 'harness_decisions' AND key = 'D-rt' AND op = 'put'`)[0].c;
    expect(after).toBe(before); // hydrate produced no new export rows
  });
});
