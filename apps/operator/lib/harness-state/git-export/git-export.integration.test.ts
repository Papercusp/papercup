/**
 * git-export.integration.test.ts (plan harness-state-storage-unification, P-003b).
 * Real testcontainer PG. Proves the end-to-end git-export vertical:
 *   capture trigger → git_export_outbox → drainer → .harness/state/<…> file,
 * the echo-loop guard (remote-origin writes skipped), and DELETE → file removal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { ensureGitExportOutbox, attachGitCaptureTrigger } from './ensure-git-outbox';
import { drainGitExportOnce } from './drainer';
import { hydrateGitTable } from './hydrate';
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
    expect(parsed).toMatchObject({
      id: 'D-001',
      harness_slug: SLUG,
      title: 'T',
      content: '# Use PG\n\nruntime store-of-record',
    });

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

    const n = await hydrateGitTable({ sql: db.sql, harnessRoot: root, table: 'harness_decisions', conflictCols: ['id'] });
    expect(n).toBeGreaterThanOrEqual(1);
    const after = await db.sql<{ id: string; title: string; content: string }[]>`
      SELECT id, title, content FROM harness_shared.harness_decisions WHERE id = 'D-rt'`;
    expect(after[0]).toMatchObject({ id: 'D-rt', title: 'RT', content: 'body text\n\nx' });
  });

  it('hydrate does NOT re-enqueue an export (capture trigger disabled during load)', async () => {
    const q = db.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM harness_shared.git_export_outbox
       WHERE table_name = 'harness_decisions' AND key = 'D-rt' AND op = 'put'`;
    const before = (await q)[0].c;
    await hydrateGitTable({ sql: db.sql, harnessRoot: root, table: 'harness_decisions', conflictCols: ['id'] });
    const after = (await db.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM harness_shared.git_export_outbox
       WHERE table_name = 'harness_decisions' AND key = 'D-rt' AND op = 'put'`)[0].c;
    expect(after).toBe(before); // hydrate produced no new export rows
  });
});
