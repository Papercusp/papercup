/**
 * testing-flakiness.integration.test.ts — regression for the workspace_id
 * scoping bug found during production-test-readiness-2026-07-06 P-004.
 *
 * BUG: admin-test-runs-reporter.ts deliberately writes workspace_id NULL for
 * "a plain operator self-test run" (this workspace's own dogfood suite —
 * ~99% of harness_shared.test_runs rows in practice). computeFlakiness's old
 * `workspace_id = ${opts.workspaceId}` filter excluded every NULL row, so any
 * workspace-scoped caller (every MCP call carries ctx.workspaceId) saw
 * near-zero data despite the docstring's "Omit for workspace-wide" promise.
 * This proves the fixed filter includes NULL-workspace_id rows alongside the
 * caller's own workspace's rows, while still excluding another workspace's
 * explicitly-tagged rows (no tenant-isolation regression).
 *
 * Real Postgres via the shared testcontainer (Docker required), a fresh
 * database per file with a minimal hand-rolled test_runs table (mirrors
 * `createFreshPgDb`'s pattern — no need for the full baseline+migrations).
 *
 * Run: cd packages/operator-core && \
 *   npx vitest run --config vitest.integration.config.ts lib/testing-flakiness.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { computeFlakiness } from './testing-flakiness';

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('flakytest');

  await db.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.test_runs (
      id bigint generated always as identity primary key,
      file_path text NOT NULL,
      framework text,
      status text NOT NULL,
      duration_ms bigint,
      started_at timestamptz,
      finished_at timestamptz,
      output_tail text,
      run_group_id text,
      source text,
      branch text,
      commit_sha text,
      created_at timestamptz NOT NULL DEFAULT now(),
      harness_slug text,
      workspace_id text
    )
  `);

  const rowsToInsert: Array<{
    filePath: string;
    status: string;
    workspaceId: string | null;
  }> = [
    // This workspace's own dogfood rows: workspace_id NULL (the common case).
    { filePath: 'a-null-ws.test.ts', status: 'pass', workspaceId: null },
    { filePath: 'a-null-ws.test.ts', status: 'fail', workspaceId: null },
    { filePath: 'a-null-ws.test.ts', status: 'pass', workspaceId: null },
    { filePath: 'a-null-ws.test.ts', status: 'fail', workspaceId: null },
    // Explicitly tagged as THIS workspace.
    { filePath: 'b-this-ws.test.ts', status: 'pass', workspaceId: 'ws-mine' },
    { filePath: 'b-this-ws.test.ts', status: 'fail', workspaceId: 'ws-mine' },
    { filePath: 'b-this-ws.test.ts', status: 'pass', workspaceId: 'ws-mine' },
    { filePath: 'b-this-ws.test.ts', status: 'fail', workspaceId: 'ws-mine' },
    // Explicitly tagged as ANOTHER workspace — must stay excluded.
    { filePath: 'c-other-ws.test.ts', status: 'pass', workspaceId: 'ws-other' },
    { filePath: 'c-other-ws.test.ts', status: 'fail', workspaceId: 'ws-other' },
    { filePath: 'c-other-ws.test.ts', status: 'pass', workspaceId: 'ws-other' },
    { filePath: 'c-other-ws.test.ts', status: 'fail', workspaceId: 'ws-other' },
  ];

  const now = Date.now();
  for (let i = 0; i < rowsToInsert.length; i++) {
    const r = rowsToInsert[i];
    const finishedAt = new Date(now - (rowsToInsert.length - i) * 60_000);
    await db.sql`
      INSERT INTO harness_shared.test_runs
        (file_path, framework, status, duration_ms, started_at, finished_at, workspace_id)
      VALUES
        (${r.filePath}, 'vitest', ${r.status}, 100, ${finishedAt}, ${finishedAt}, ${r.workspaceId})
    `;
  }
});

afterAll(async () => {
  await db.cleanup();
});

describe('computeFlakiness workspace scoping (regression)', () => {
  it("includes NULL-workspace_id rows alongside this workspace's own rows, excludes another workspace's rows", async () => {
    const rows = await computeFlakiness({
      workspaceId: 'ws-mine',
      minRuns: 2,
      lookbackDays: 90,
      sql: db.sql as unknown as Parameters<typeof computeFlakiness>[0] extends { sql?: infer S } ? S : never,
    });
    const byFile = new Map(rows.map((r) => [r.filePath, r]));

    expect(byFile.has('a-null-ws.test.ts')).toBe(true);
    expect(byFile.get('a-null-ws.test.ts')?.totalRuns).toBe(4);

    expect(byFile.has('b-this-ws.test.ts')).toBe(true);
    expect(byFile.get('b-this-ws.test.ts')?.totalRuns).toBe(4);

    expect(byFile.has('c-other-ws.test.ts')).toBe(false);
  });
});

describe('computeFlakiness harness scoping (regression, WI-3925)', () => {
  let hdb: FreshPgDb;

  beforeAll(async () => {
    hdb = await createFreshPgDb('flakytest-harness');

    await hdb.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS harness_shared.test_runs (
        id bigint generated always as identity primary key,
        file_path text NOT NULL,
        framework text,
        status text NOT NULL,
        duration_ms bigint,
        started_at timestamptz,
        finished_at timestamptz,
        output_tail text,
        run_group_id text,
        source text,
        branch text,
        commit_sha text,
        created_at timestamptz NOT NULL DEFAULT now(),
        harness_slug text,
        workspace_id text
      )
    `);

    const rowsToInsert: Array<{ filePath: string; status: string; harnessSlug: string | null }> = [
      // Real-world common case: a "plain operator self-test run" — harness_slug NULL.
      { filePath: 'a-null-harness.test.ts', status: 'pass', harnessSlug: null },
      { filePath: 'a-null-harness.test.ts', status: 'fail', harnessSlug: null },
      { filePath: 'a-null-harness.test.ts', status: 'pass', harnessSlug: null },
      { filePath: 'a-null-harness.test.ts', status: 'fail', harnessSlug: null },
      // Explicitly tagged as THIS harness.
      { filePath: 'b-this-harness.test.ts', status: 'pass', harnessSlug: 'papercusp' },
      { filePath: 'b-this-harness.test.ts', status: 'fail', harnessSlug: 'papercusp' },
      { filePath: 'b-this-harness.test.ts', status: 'pass', harnessSlug: 'papercusp' },
      { filePath: 'b-this-harness.test.ts', status: 'fail', harnessSlug: 'papercusp' },
      // Explicitly tagged as ANOTHER harness — must stay excluded.
      { filePath: 'c-other-harness.test.ts', status: 'pass', harnessSlug: 'some-other-harness' },
      { filePath: 'c-other-harness.test.ts', status: 'fail', harnessSlug: 'some-other-harness' },
      { filePath: 'c-other-harness.test.ts', status: 'pass', harnessSlug: 'some-other-harness' },
      { filePath: 'c-other-harness.test.ts', status: 'fail', harnessSlug: 'some-other-harness' },
    ];

    const now = Date.now();
    for (let i = 0; i < rowsToInsert.length; i++) {
      const r = rowsToInsert[i];
      const finishedAt = new Date(now - (rowsToInsert.length - i) * 60_000);
      await hdb.sql`
        INSERT INTO harness_shared.test_runs
          (file_path, framework, status, duration_ms, started_at, finished_at, harness_slug)
        VALUES
          (${r.filePath}, 'vitest', ${r.status}, 100, ${finishedAt}, ${finishedAt}, ${r.harnessSlug})
      `;
    }
  });

  afterAll(async () => {
    await hdb.cleanup();
  });

  it("includes NULL-harness_slug rows alongside this harness's own rows, excludes another harness's rows", async () => {
    const rows = await computeFlakiness({
      harnessSlug: 'papercusp',
      minRuns: 2,
      lookbackDays: 90,
      sql: hdb.sql as unknown as Parameters<typeof computeFlakiness>[0] extends { sql?: infer S } ? S : never,
    });
    const byFile = new Map(rows.map((r) => [r.filePath, r]));

    expect(byFile.has('a-null-harness.test.ts')).toBe(true);
    expect(byFile.get('a-null-harness.test.ts')?.totalRuns).toBe(4);

    expect(byFile.has('b-this-harness.test.ts')).toBe(true);
    expect(byFile.get('b-this-harness.test.ts')?.totalRuns).toBe(4);

    expect(byFile.has('c-other-harness.test.ts')).toBe(false);
  });
});
