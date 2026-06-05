/**
 * admin-test-runs-reporter.ts — custom Vitest reporter that writes
 * one row per test FILE to harness_shared.test_runs.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-010.
 *
 * Powers the /admin/testing status chip (P-013) without parsing
 * Vitest output — we tap the reporter API directly. Playwright and
 * Cargo get parallel reporters in P-011 and P-012.
 *
 * D-007 fail-soft contract — LOAD-BEARING:
 *   - 1s connect timeout
 *   - swallow every PG / git / fs error
 *   - never throw out of any hook
 *   - never write to stderr/stdout in a way that taints test output
 *   - never affect the process exit code
 *
 * Tests can run with the embedded DB down, with the table missing,
 * offline, in cold contributor checkouts — none of those scenarios
 * change a single test outcome.
 *
 * Vitest 4 API: onTestRunEnd(testModules, unhandledErrors, reason).
 * Older onFinished/onTaskUpdate names from Vitest 1-3 are NOT called.
 */

import type { Reporter, TestModule, Vitest } from 'vitest/node';
import { resolveGitContext } from '@papercusp/operator-core/lib/testing-branch-resolve';
import { inferWorkspaceRoot } from '@papercusp/operator-core/lib/testing-domain-glob';
import { resolveTestRunSource } from '@papercusp/operator-core/lib/testing-run-source';
import { posix, relative } from 'node:path';

interface TestRunRow {
  filePath: string;        // workspace-relative POSIX
  status: 'pass' | 'fail' | 'skip' | 'cancelled' | 'error';
  durationMs: number;
  startedAt: Date;
  finishedAt: Date;
  outputTail: string | null;
}

function toWorkspaceRel(absPath: string): string {
  const root = inferWorkspaceRoot();
  const rel = relative(root, absPath);
  return rel.split(/[/\\]/).join(posix.sep);
}

/**
 * Roll up per-module status from the Vitest 4 TestModule:
 *   passed → 'pass'
 *   failed → 'fail'
 *   skipped → 'skip'
 *   pending/queued → 'error' (module never finished — treat as error)
 */
function moduleStatus(m: TestModule): TestRunRow['status'] {
  let state: string;
  try {
    state = m.state();
  } catch {
    return 'error';
  }
  switch (state) {
    case 'passed':
      return 'pass';
    case 'failed':
      return 'fail';
    case 'skipped':
      return 'skip';
    default:
      return 'error';
  }
}

async function tryGetPg(): Promise<{
  sql: ReturnType<typeof import('postgres')['default']> | null;
} | null> {
  try {
    const pg = (await import('postgres')).default;
    const url =
      process.env.HARNESS_ADMIN_DATABASE_URL ??
      process.env.PAPERCUSP_TEST_RUNS_DB_URL ??
      'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';
    // 1s connect timeout per D-007 fail-soft.
    const sql = pg(url, {
      max: 1,
      connect_timeout: 1,
      idle_timeout: 1,
      max_lifetime: 5,
      onnotice: () => {},
      // Silence postgres internal warnings — the reporter MUST stay quiet.
    });
    return { sql } as unknown as {
      sql: ReturnType<typeof import('postgres')['default']> | null;
    };
  } catch (e) {
    if (process.env.PAPERCUSP_DEBUG_REPORTER) {
      const fs = await import('node:fs');
      fs.appendFileSync('/tmp/_rep_dbg', `${new Date().toISOString()} tryGetPg-fail: ${e instanceof Error ? e.message : String(e)}
`);
    }
    return null;
  }
}

async function insertRow(row: TestRunRow): Promise<void> {
  let branch: string | null = null;
  let commit: string | null = null;
  try {
    const ctx = await resolveGitContext();
    branch = ctx.branch;
    commit = ctx.commit;
  } catch { /* fail-soft */ }

  const pg = await tryGetPg();
  if (!pg) return;

  const source = resolveTestRunSource();
  const runGroupId = process.env.PAPERCUSP_TEST_RUN_GROUP ?? null;

  try {
    await Promise.race([
      pg.sql`
        INSERT INTO harness_shared.test_runs
          (file_path, framework, status, duration_ms, started_at, finished_at, output_tail, run_group_id, source, branch, commit_sha)
        VALUES
          (${row.filePath}, 'vitest', ${row.status}, ${row.durationMs}, ${row.startedAt},
           ${row.finishedAt}, ${row.outputTail}, ${runGroupId}, ${source}, ${branch}, ${commit})
      `,
      new Promise((_, reject) => setTimeout(() => reject(new Error('pg_insert_timeout')), 1000)),
    ]).catch(() => {
      /* swallow — D-007 */
    });
  } catch {
    /* swallow — D-007 */
  }
}

export default class AdminTestRunsReporter implements Reporter {
  private pending: Promise<void>[] = [];

  onInit(_ctx: Vitest): void {
    void _ctx;
  }

  /**
   * Per-module hook — fires as each test file finishes. We fire-and-
   * forget the insert and stash the promise on `pending` so onTestRunEnd
   * can wait for all of them before letting the process exit.
   */
  onTestModuleEnd(testModule: TestModule): void {
    try {
      const filePath = toWorkspaceRel(testModule.moduleId);
      const status = moduleStatus(testModule);
      let durationMsRaw = 0;
      try {
        durationMsRaw = testModule.diagnostic().duration ?? 0;
      } catch { /* fail-soft */ }
      const finishedAt = new Date();
      const durationMs = Math.round(durationMsRaw);
      const startedAt = new Date(finishedAt.getTime() - durationMs);

      // Best-effort tail of any module-level error messages.
      let outputTail: string | null = null;
      try {
        const errs = testModule.errors?.() ?? [];
        if (errs.length > 0) {
          outputTail = errs.map((e: unknown) => (e instanceof Error ? e.message : String(e))).join('\n').slice(-4000);
        }
      } catch { /* fail-soft */ }

      this.pending.push(
        insertRow({ filePath, status, durationMs, startedAt, finishedAt, outputTail }),
      );
    } catch {
      /* swallow — D-007 */
    }
  }

  async onTestRunEnd(): Promise<void> {
    try {
      // Don't block forever — give inserts up to 5s total.
      await Promise.race([
        Promise.allSettled(this.pending),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      /* swallow — D-007 */
    }
  }

  async onExit(): Promise<void> {
    try {
      await Promise.race([
        Promise.allSettled(this.pending),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      /* swallow — D-007 */
    }
  }
}

// Each insertRow opens its own short-lived pg client; nothing to close
// at exit beyond awaiting pending inserts.
