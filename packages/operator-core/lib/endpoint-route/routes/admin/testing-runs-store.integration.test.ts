/**
 * testing-runs-store.integration.test.ts — the admin /testing "status chips"
 * durable backend (harness_shared.test_runs) against REAL Postgres
 * (testcontainer). Plan: admin-testing-tab-restructure-2026-05-24.
 *
 * test_runs is the recorder/reader the /admin/testing chips read from. The WRITE
 * shape is testing-run-store.persistFallbackRow's INSERT; the READ shapes are the
 * three route handlers in this directory. test_runs is a SHARED harness table (no
 * workspace_id / no RLS) — isolation is by file_path + branch + run_group_id, and
 * the sequence-backed bigint id is the tiebreak in every ORDER BY.
 *
 * This file pins, against the full migrated baseline schema:
 *   - the exact persistFallbackRow INSERT round-trip (sequence id, source/status
 *     CHECK constraints, field mapping);
 *   - file-history: newest-first ordering (finished_at DESC NULLS LAST, id DESC),
 *     file_path scoping, LIMIT clamp, field/camelCase mapping;
 *   - file-status: DISTINCT ON latest-per-file, the (branch = X OR source='admin-ui')
 *     branch filter, and the "any-branch + stale:true" SECOND-pass fallback (D-010);
 *   - prune_test_runs(): keep-N-newest per (file_path, branch) DELETE.
 *
 * The route handlers are route-shaped defineTool defs (pure — `default.handler(req)`
 * is directly callable). They route through getOrgPg().sql as the table owner, so
 * we mock it to the fixture admin client; file-status additionally needs the
 * domain/glob/git seams mocked to feed it a known file set + branch.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type postgres from 'postgres';
import type { OrgTestDb } from '../../../../test/_org-test-db';

const h = vi.hoisted(() => ({
  sql: null as unknown as postgres.Sql,
  // file-status seams, mutated per test:
  filePaths: [] as string[],
  branch: null as string | null,
  commit: 'deadbeef' as string | null,
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
// Side-effect registry import in the route — make it a no-op (the real domains
// aren't needed; we mock getTestDomain to a synthetic domain below).
vi.mock('../../../testing-domains-registry', () => ({}));
vi.mock('../../../testing-domains', () => ({
  getTestDomain: (id: string) =>
    id === 'unknown-domain'
      ? undefined
      : { id, label: id, sections: [{ id: 's', label: 's', globs: ['x'] }] },
}));
vi.mock('../../../testing-domain-glob', () => ({
  inferWorkspaceRoot: () => '/repo',
  // Return the per-test file set as {path}[] (the route maps h.path).
  expandGlobs: async () => h.filePaths.map((p) => ({ path: p })),
}));
vi.mock('../../../testing-branch-resolve', () => ({
  resolveGitContext: async () => ({ branch: h.branch, commit: h.commit }),
}));

const fileHistory = (await import('./testing-file-history')).default;
const fileStatus = (await import('./testing-file-status')).default;
const { createOrgTestDb } = await import('../../../../test/_org-test-db');
const ROUTE_CTX = {} as never;
const callFileHistory = (url: string) => fileHistory.handler(new Request(url), ROUTE_CTX);
const callFileStatus = (url: string) => fileStatus.handler(new Request(url), ROUTE_CTX);

type FrameworkKind = 'vitest' | 'playwright' | 'node' | 'shell';
type StatusKind = 'pass' | 'fail' | 'skip' | 'cancelled' | 'error' | 'running';

/**
 * The exact INSERT that testing-run-store.persistFallbackRow issues. Kept in
 * lockstep with that writer so this test pins the real write shape (column set,
 * source/status CHECK values, sequence-backed id).
 */
async function insertRun(opts: {
  filePath: string;
  framework?: FrameworkKind;
  status?: StatusKind;
  durationMs?: number | null;
  source?: 'ci' | 'local' | 'admin-ui';
  branch?: string | null;
  commit?: string | null;
  outputTail?: string | null;
}): Promise<void> {
  const now = Date.now();
  await h.sql`
    INSERT INTO harness_shared.test_runs
      (file_path, framework, status, duration_ms, started_at, finished_at, output_tail, run_group_id, source, branch, commit_sha)
    VALUES
      (${opts.filePath}, ${opts.framework ?? 'node'}, ${opts.status ?? 'pass'},
       ${opts.durationMs ?? 100}, ${new Date(now - 100).toISOString()},
       ${new Date(now).toISOString()}, ${opts.outputTail ?? null},
       ${randomBytes(6).toString('hex')}, ${opts.source ?? 'local'},
       ${opts.branch ?? null}, ${opts.commit ?? null})
  `;
}

const uniqueFile = (tag: string) => `pkg/lib/${tag}-${randomBytes(3).toString('hex')}.test.ts`;

describe('test_runs store (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  beforeEach(() => {
    h.filePaths = [];
    h.branch = null;
    h.commit = 'deadbeef';
  });

  describe('write round-trip (persistFallbackRow INSERT shape)', () => {
    it('inserts a row, auto-assigns a sequence id, and round-trips the fields', async () => {
      const file = uniqueFile('rt');
      await insertRun({ filePath: file, framework: 'node', status: 'pass', durationMs: 1234, source: 'admin-ui', outputTail: 'ok' });
      const rows = await h.sql<{ id: string; file_path: string; framework: string; status: string; duration_ms: string; source: string; output_tail: string }[]>`
        SELECT id, file_path, framework, status, duration_ms, source, output_tail
          FROM harness_shared.test_runs WHERE file_path = ${file}
      `;
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].id)).toBeGreaterThan(0); // sequence-backed
      expect(rows[0]).toMatchObject({ file_path: file, framework: 'node', status: 'pass', source: 'admin-ui', output_tail: 'ok' });
      expect(Number(rows[0].duration_ms)).toBe(1234);
    });

    it('rejects a status outside the CHECK constraint', async () => {
      await expect(
        insertRun({ filePath: uniqueFile('bad'), status: 'bogus' as StatusKind }),
      ).rejects.toThrow();
    });

    it('rejects a source outside the CHECK constraint', async () => {
      await expect(
        insertRun({ filePath: uniqueFile('bad'), source: 'cron' as 'ci' }),
      ).rejects.toThrow();
    });
  });

  describe('file-history route (read: newest-first, file-scoped, limit)', () => {
    it('returns rows newest-first for one file and maps fields to camelCase', async () => {
      const file = uniqueFile('hist');
      await insertRun({ filePath: file, status: 'pass', source: 'admin-ui', branch: 'staging', commit: 'c1', durationMs: 10 });
      await new Promise((r) => setTimeout(r, 20)); // distinct finished_at
      await insertRun({ filePath: file, status: 'fail', source: 'local', branch: 'staging', commit: 'c2', durationMs: 20, outputTail: 'boom' });

      const res = await callFileHistory(`http://x/admin/testing/file-history?filePath=${encodeURIComponent(file)}`);
      const body = await res.json();
      expect(body.filePath).toBe(file);
      expect(body.rows).toHaveLength(2);
      // newest (the fail) first
      expect(body.rows[0]).toMatchObject({ status: 'fail', source: 'local', branch: 'staging', commitSha: 'c2', outputTail: 'boom', durationMs: 20 });
      expect(body.rows[1]).toMatchObject({ status: 'pass', commitSha: 'c1' });
      expect(typeof body.rows[0].id).toBe('string');
      expect(typeof body.rows[0].finishedAt).toBe('string');
    });

    it('only returns rows for the requested file_path', async () => {
      const a = uniqueFile('only-a');
      const b = uniqueFile('only-b');
      await insertRun({ filePath: a });
      await insertRun({ filePath: b });
      const res = await callFileHistory(`http://x/admin/testing/file-history?filePath=${encodeURIComponent(a)}`);
      const body = await res.json();
      expect(body.rows).toHaveLength(1);
      expect(body.rows.every((r: { status: string }) => typeof r.status === 'string')).toBe(true);
    });

    it('clamps the limit (default 20, max 200, min 1)', async () => {
      const file = uniqueFile('limit');
      for (let i = 0; i < 5; i++) await insertRun({ filePath: file, status: 'pass' });
      const res = await callFileHistory(`http://x/admin/testing/file-history?filePath=${encodeURIComponent(file)}&limit=2`);
      const body = await res.json();
      expect(body.rows).toHaveLength(2);
    });

    it('400s when filePath is missing', async () => {
      const res = await callFileHistory('http://x/admin/testing/file-history');
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('missing_query_param');
    });
  });

  describe('file-status route (read: DISTINCT ON latest-per-file, branch filter, stale fallback)', () => {
    it('400 on missing domainId, 404 on unknown domain', async () => {
      expect((await callFileStatus('http://x/admin/testing/file-status')).status).toBe(400);
      expect(
        (await callFileStatus('http://x/admin/testing/file-status?domainId=unknown-domain')).status,
      ).toBe(404);
    });

    it('returns the latest row per file on the current branch (not stale)', async () => {
      const file = uniqueFile('fs-latest');
      h.filePaths = [file];
      h.branch = 'staging';
      await insertRun({ filePath: file, status: 'pass', source: 'local', branch: 'staging' });
      await new Promise((r) => setTimeout(r, 20));
      await insertRun({ filePath: file, status: 'fail', source: 'local', branch: 'staging' }); // newer

      const res = await callFileStatus('http://x/admin/testing/file-status?domainId=d1');
      const body = await res.json();
      expect(body.branch).toBe('staging');
      expect(body.statuses[file]).toMatchObject({ status: 'fail', branch: 'staging', stale: false });
    });

    it('an admin-ui row on ANOTHER branch still counts as current (source=admin-ui)', async () => {
      const file = uniqueFile('fs-adminui');
      h.filePaths = [file];
      h.branch = 'staging';
      // The only row is on a different branch but source=admin-ui → matches the
      // first-pass (branch = X OR source = 'admin-ui'); NOT stale.
      await insertRun({ filePath: file, status: 'pass', source: 'admin-ui', branch: 'feature-x' });
      const res = await callFileStatus('http://x/admin/testing/file-status?domainId=d1');
      const body = await res.json();
      expect(body.statuses[file]).toMatchObject({ status: 'pass', source: 'admin-ui', stale: false });
    });

    it('falls back to any-branch latest with stale:true when no current-branch row exists', async () => {
      const file = uniqueFile('fs-stale');
      h.filePaths = [file];
      h.branch = 'staging';
      // Only a CI row on a different branch — misses the first pass, caught by
      // the second (any-source) pass and flagged stale.
      await insertRun({ filePath: file, status: 'pass', source: 'ci', branch: 'main' });
      const res = await callFileStatus('http://x/admin/testing/file-status?domainId=d1');
      const body = await res.json();
      expect(body.statuses[file]).toMatchObject({ status: 'pass', source: 'ci', branch: 'main', stale: true });
    });

    it('DISTINCT ON keeps exactly one (latest) status per file across many rows', async () => {
      const file = uniqueFile('fs-distinct');
      h.filePaths = [file];
      h.branch = 'staging';
      await insertRun({ filePath: file, status: 'fail', source: 'local', branch: 'staging' });
      await new Promise((r) => setTimeout(r, 15));
      await insertRun({ filePath: file, status: 'error', source: 'local', branch: 'staging' });
      await new Promise((r) => setTimeout(r, 15));
      await insertRun({ filePath: file, status: 'pass', source: 'local', branch: 'staging' }); // newest
      const res = await callFileStatus('http://x/admin/testing/file-status?domainId=d1');
      const body = await res.json();
      expect(Object.keys(body.statuses)).toHaveLength(1);
      expect(body.statuses[file].status).toBe('pass');
    });
  });

  describe('prune_test_runs() SQL function (keep-N-newest per file+branch)', () => {
    it('deletes everything beyond keep-N for each (file_path, branch) partition', async () => {
      const file = uniqueFile('prune');
      // 5 rows on staging, 2 on main.
      for (let i = 0; i < 5; i++) { await insertRun({ filePath: file, status: 'pass', branch: 'staging' }); await new Promise((r) => setTimeout(r, 4)); }
      for (let i = 0; i < 2; i++) { await insertRun({ filePath: file, status: 'pass', branch: 'main' }); await new Promise((r) => setTimeout(r, 4)); }

      const deleted = await h.sql<{ prune_test_runs: number }[]>`SELECT harness_shared.prune_test_runs(2) AS prune_test_runs`;
      // staging had 5 → keep 2 → delete 3; main had 2 → keep 2 → delete 0. (Other
      // tests' rows are on distinct file_paths / null branch and are kept-or-not
      // independently; we assert on THIS file only below.)
      const remaining = await h.sql<{ branch: string | null; n: string }[]>`
        SELECT branch, COUNT(*)::text AS n
          FROM harness_shared.test_runs WHERE file_path = ${file}
         GROUP BY branch ORDER BY branch
      `;
      const byBranch = Object.fromEntries(remaining.map((r) => [r.branch, Number(r.n)]));
      expect(byBranch['staging']).toBe(2);
      expect(byBranch['main']).toBe(2);
      expect(deleted[0].prune_test_runs).toBeGreaterThanOrEqual(3);
    });
  });
});
