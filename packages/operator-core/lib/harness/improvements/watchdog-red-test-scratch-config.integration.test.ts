/**
 * watchdog-red-test-scratch-config.integration.test.ts — EI-18767688096795873.
 *
 * BUG: the red-test watchdog aggregates `harness_shared.test_runs` purely by
 * file_path + status, so a test file whose ONLY recent failures came from a
 * deliberate, throwaway harness (a mutation-testing run using
 * `--config /tmp/.../vitest.mutant.config.ts` to alias in a broken module and
 * assert the suite goes red) was indistinguishable from a genuine repeated
 * regression — the mutant run's file path is identical to the real test's.
 *
 * FIX: the vitest reporter now stamps `is_scratch_config` on every row (true when
 * the run's resolved config file lives outside the repo tree — see
 * admin-test-runs-reporter.ts's `isScratchConfigFile`), and `fetchRedTestRows`
 * excludes those rows from BOTH the fail count and the "latest run" freshness
 * check. This proves the SQL predicate end-to-end against real Postgres — the
 * layer a pure-function unit test of `isScratchConfigFile` alone cannot cover.
 *
 * Real Postgres via the shared testcontainer (Docker required), a fresh database
 * per file with a minimal hand-rolled test_runs table (mirrors
 * testing-flakiness.integration.test.ts's pattern) — no need for the full
 * baseline+migrations.
 *
 * Run: cd packages/operator-core && \
 *   npx vitest run --config vitest.integration.config.ts lib/harness/improvements/watchdog-red-test-scratch-config.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { fetchRedTestRows } from './watchdog';

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('redtest-scratch-config');

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
      workspace_id text,
      is_scratch_config boolean NOT NULL DEFAULT false
    )
  `);

  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);

  const rows: Array<{ filePath: string; status: string; startedAt: Date; isScratchConfig: boolean }> = [
    // THE live repro: a test file with a real, clean history — its only 3 recent
    // "failures" are a mutation-testing run's mutants, each is_scratch_config=true.
    // The real (non-scratch) runs bracketing them are all green.
    { filePath: 'packages/operator-core/lib/sync/pot-git/chunked-blob-scan.integration.test.ts', status: 'pass', startedAt: at(50), isScratchConfig: false },
    { filePath: 'packages/operator-core/lib/sync/pot-git/chunked-blob-scan.integration.test.ts', status: 'fail', startedAt: at(40), isScratchConfig: true },
    { filePath: 'packages/operator-core/lib/sync/pot-git/chunked-blob-scan.integration.test.ts', status: 'fail', startedAt: at(35), isScratchConfig: true },
    { filePath: 'packages/operator-core/lib/sync/pot-git/chunked-blob-scan.integration.test.ts', status: 'fail', startedAt: at(30), isScratchConfig: true },
    { filePath: 'packages/operator-core/lib/sync/pot-git/chunked-blob-scan.integration.test.ts', status: 'pass', startedAt: at(5), isScratchConfig: false },

    // CONTROL A: a genuinely broken file — same fail count, all real (non-scratch)
    // runs, latest run still red. Must still fire (the fix must not suppress a
    // real regression).
    { filePath: 'packages/operator-core/lib/real-regression.test.ts', status: 'pass', startedAt: at(50), isScratchConfig: false },
    { filePath: 'packages/operator-core/lib/real-regression.test.ts', status: 'fail', startedAt: at(40), isScratchConfig: false },
    { filePath: 'packages/operator-core/lib/real-regression.test.ts', status: 'fail', startedAt: at(30), isScratchConfig: false },
    { filePath: 'packages/operator-core/lib/real-regression.test.ts', status: 'fail', startedAt: at(5), isScratchConfig: false },

    // CONTROL B: a file with ONLY scratch-config runs (a mutation harness run
    // against a file with no real recent history at all) — must never fire either.
    { filePath: 'packages/operator-core/lib/only-mutated.test.ts', status: 'fail', startedAt: at(20), isScratchConfig: true },
    { filePath: 'packages/operator-core/lib/only-mutated.test.ts', status: 'fail', startedAt: at(15), isScratchConfig: true },
    { filePath: 'packages/operator-core/lib/only-mutated.test.ts', status: 'fail', startedAt: at(10), isScratchConfig: true },
  ];

  for (const r of rows) {
    await db.sql`
      INSERT INTO harness_shared.test_runs
        (file_path, framework, status, duration_ms, started_at, finished_at, is_scratch_config)
      VALUES
        (${r.filePath}, 'vitest', ${r.status}, 100, ${r.startedAt}, ${r.startedAt}, ${r.isScratchConfig})
    `;
  }
});

afterAll(async () => {
  await db?.cleanup();
});

describe('fetchRedTestRows excludes scratch-config runs (EI-18767688096795873)', () => {
  it('does NOT surface a file whose only recent fails were mutation-testing runs (THE live repro)', async () => {
    const rows = await fetchRedTestRows(db.sql as unknown as Parameters<typeof fetchRedTestRows>[0], { redTestWindowHours: 6, redTestMinFails: 3 });
    const paths = rows.map((r) => r.file_path);
    expect(paths).not.toContain('packages/operator-core/lib/sync/pot-git/chunked-blob-scan.integration.test.ts');
  });

  it('STILL surfaces a genuinely broken file with the same fail count, all non-scratch (no over-suppression)', async () => {
    const rows = await fetchRedTestRows(db.sql as unknown as Parameters<typeof fetchRedTestRows>[0], { redTestWindowHours: 6, redTestMinFails: 3 });
    const row = rows.find((r) => r.file_path === 'packages/operator-core/lib/real-regression.test.ts');
    expect(row).toBeDefined();
    expect(row?.fails).toBe(3);
  });

  it('does NOT surface a file with ONLY scratch-config fails and no real history at all', async () => {
    const rows = await fetchRedTestRows(db.sql as unknown as Parameters<typeof fetchRedTestRows>[0], { redTestWindowHours: 6, redTestMinFails: 3 });
    const paths = rows.map((r) => r.file_path);
    expect(paths).not.toContain('packages/operator-core/lib/only-mutated.test.ts');
  });
});
