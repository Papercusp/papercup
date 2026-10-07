/**
 * admin-test-runs-reporter-playwright.ts — Playwright counterpart to
 * the Vitest reporter (P-010). Writes one row per spec FILE to
 * harness_shared.test_runs with framework='playwright'.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-011.
 *
 * D-007 fail-soft contract — identical to the Vitest reporter:
 *   - 1s connect timeout
 *   - swallow every PG / git / fs error
 *   - never throw out of any hook
 *   - never write to stderr/stdout in a way that taints test output
 *   - never affect the process exit code
 *
 * Wire-up: apps/operator/playwright.config.ts adds this reporter to
 * its `reporter` array. Opt-out via PAPERCUSP_DISABLE_TEST_RUNS_REPORTER=1.
 *
 * Playwright reporter API: implement onBegin/onTestEnd/onEnd. Each
 * spec file's per-test results aggregate into one row (status=fail
 * if any test failed, pass if all passed).
 */

import type { FullConfig, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { resolveGitContext } from '@papercusp/operator-core/lib/testing-branch-resolve';
import { resolveAgentWorkspaceRoot } from '@papercusp/operator-core/lib/agent-tools/capability/base-dir';
import {
  captureWorktreeSnapshot,
  computeWorktreeDirty,
  type WorktreeGitSnapshot,
} from '@papercusp/operator-core/lib/testing-worktree';
import { resolveTestRunSource } from '@papercusp/operator-core/lib/testing-run-source';
import {
  describeWorktreeDirt,
  resolveMutationProbePhase,
  resolveTestRunHarnessSlug,
  resolveTestRunWorkspaceId,
} from '@papercusp/test-config/admin-test-runs-reporter';
import { posix, relative } from 'node:path';
import {
  isRecordedCaseTitle,
  MAX_RECORDED_FAILED_CASES,
  MAX_RECORDED_PASSED_CASES,
  TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION,
  type TestRunExecutionDetails,
} from '@papercusp/test-config/execution-details';

interface TestRunRow {
  filePath: string;
  status: 'pass' | 'fail' | 'skip' | 'cancelled' | 'error';
  durationMs: number;
  startedAt: Date;
  finishedAt: Date;
  outputTail: string | null;
  worktreeDirty: boolean;
  passed: number;
  failed: number;
  skipped: number;
  /** Exact failing case identities (WI-10006806): what a filed red names as "the failing tests". */
  failedCaseTitles?: string[];
  passedCaseTitles?: string[];
}

/**
 * WI-10006806: the identity of one Playwright case below its file — describe blocks then the test
 * title, joined with ' > ' like Vitest's `TestCase.fullName`. Playwright's `titlePath()` is
 * `['', <project>, <file>, ...describes, <title>]`; the root, project and file segments are
 * dropped so one case reads the same under every project. Returns null when the title is not a
 * valid recorded identity (the shared parser would reject the whole row otherwise).
 */
export function playwrightCaseTitle(test: Partial<Pick<TestCase, 'titlePath' | 'title'>>): string | null {
  let parts: string[] = [];
  try {
    if (typeof test.titlePath === 'function') parts = test.titlePath().slice(3).filter((part) => part.length > 0);
  } catch {
    parts = [];
  }
  if (parts.length === 0 && typeof test.title === 'string' && test.title.length > 0) parts = [test.title];
  const title = parts.map((part) => part.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).join(' > ');
  return isRecordedCaseTitle(title) ? title : null;
}

/**
 * EI-24434635346407728: stamp the RUNTIME layer. This reporter only ever runs inside a
 * Playwright process, so every row it writes is an e2e execution — the fact acceptance
 * BARs requiring `e2e` bind against. Before this the row carried no execution_details at
 * all, so no e2e run could ever satisfy an `e2e` layer requirement.
 */
export function playwrightExecutionDetails(
  row: TestRunRow,
  run: { root: string; runGroupId: string | null; workspaceId: string | null; harnessSlug: string | null; commitSha: string | null },
): TestRunExecutionDetails {
  return {
    schemaVersion: TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION,
    root: run.root,
    filePath: row.filePath,
    runGroupId: run.runGroupId,
    workspaceId: run.workspaceId,
    harnessSlug: run.harnessSlug,
    testNamePattern: null,
    testLayer: 'e2e',
    passed: row.passed,
    failed: row.failed,
    skipped: row.skipped,
    collectionFailed: false,
    mutationPhase: resolveMutationProbePhase(),
    commitSha: run.commitSha,
    worktreeDirty: row.worktreeDirty,
    ...(row.failedCaseTitles && row.failedCaseTitles.length > 0
      ? { failedCaseTitles: row.failedCaseTitles.slice(0, Math.min(MAX_RECORDED_FAILED_CASES, row.failed)) }
      : {}),
    ...(row.passedCaseTitles && row.passedCaseTitles.length > 0
      ? { passedCaseTitles: row.passedCaseTitles.slice(0, Math.min(MAX_RECORDED_PASSED_CASES, row.passed)) }
      : {}),
  };
}

function captureReporterSaturationSnapshot(): { loopLagP95Ms: number | null; rssMb: number | null } {
  // This reporter is a child process. Its event loop is mostly idle while
  // Playwright workers run, so it cannot measure the operator host loop used
  // by testing:runs' critical-band classifier. Persist no false-provenance
  // sample; the reader will expose saturationSuspect as unknown.
  let rssMb: number | null = null;
  try {
    rssMb = Math.round((process.memoryUsage().rss / 1_048_576) * 10) / 10;
  } catch {
    rssMb = null;
  }
  return { loopLagP95Ms: null, rssMb };
}

function toWorkspaceRel(absPath: string, root: string): string {
  const rel = relative(root, absPath);
  return rel.split(/[/\\]/).join(posix.sep);
}

async function tryGetPg(): Promise<{
  sql: (strings: TemplateStringsArray, ...vals: unknown[]) => Promise<unknown[]>;
} | null> {
  try {
    const pg = (await import('postgres')).default;
    // The dedicated ledger variable wins (WI-10006736): the isolated rig exports
    // HARNESS_ADMIN_DATABASE_URL at its throwaway database, so the isolated e2e runner
    // points PAPERCUSP_TEST_RUNS_DB_URL at the shared ledger. Same order as the Vitest
    // reporter and resolveExecutedMapPgUrl.
    const url =
      process.env.PAPERCUSP_TEST_RUNS_DB_URL ??
      process.env.HARNESS_ADMIN_DATABASE_URL ??
      'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';
    const sql = pg(url, {
      max: 1,
      connect_timeout: 1,
      idle_timeout: 1,
      max_lifetime: 5,
      onnotice: () => {},
    });
    return { sql } as unknown as {
      sql: (strings: TemplateStringsArray, ...vals: unknown[]) => Promise<unknown[]>;
    };
  } catch {
    return null;
  }
}

async function insertRow(row: TestRunRow, worktreeAfter: WorktreeGitSnapshot, root: string): Promise<void> {
  let branch: string | null = null;
  try {
    // The ambient resolver describes the agent's tree. It cannot name the
    // branch of a separate proof checkout; its actual snapshot names the commit.
    if (root === resolveAgentWorkspaceRoot({})) branch = (await resolveGitContext()).branch;
  } catch { /* fail-soft */ }
  // Use the post-run snapshot for attribution. The cached resolver's commit
  // may describe a different tree if git-sync or a peer changed it while the
  // Playwright run was in flight.
  const commit = worktreeAfter.commit;

  const pg = await tryGetPg();
  if (!pg) return;

  const source = resolveTestRunSource();
  const runGroupId = process.env.PAPERCUSP_TEST_RUN_GROUP ?? null;
  const { loopLagP95Ms, rssMb } = captureReporterSaturationSnapshot();
  // WI-6583: this reporter never wrote harness_slug/workspace_id at all. It now calls the
  // Vitest reporter's resolvers directly instead of an inline copy: the copy had already
  // drifted once (it lacked the PAPERCUSP_TEST_RUN_WORKSPACE override, so isolated e2e rows
  // were stamped with the rig's throwaway workspace — WI-10006804).
  const harnessSlug = resolveTestRunHarnessSlug();
  const workspaceId = resolveTestRunWorkspaceId();

  try {
    await Promise.race([
      pg.sql`
        INSERT INTO harness_shared.test_runs
          (file_path, framework, status, duration_ms, started_at, finished_at, output_tail, run_group_id, source, branch, commit_sha, harness_slug, workspace_id, loop_lag_p95_ms, rss_mb, worktree_dirty, execution_details)
        VALUES
          (${row.filePath}, 'playwright', ${row.status}, ${row.durationMs}, ${row.startedAt},
           ${row.finishedAt}, ${row.outputTail}, ${runGroupId}, ${source}, ${branch}, ${commit}, ${harnessSlug}, ${workspaceId}, ${loopLagP95Ms}, ${rssMb}, ${row.worktreeDirty},
           ${playwrightExecutionDetails(row, { root, runGroupId, workspaceId, harnessSlug, commitSha: commit }) as never}::jsonb)
      `,
      new Promise((_, reject) => setTimeout(() => reject(new Error('pg_insert_timeout')), 1000)),
    ]).catch(() => {
      /* swallow — D-007 */
    });
  } catch {
    /* swallow — D-007 */
  }
}

interface PerFile {
  startedAt: number;
  finishedAt: number;
  anyFail: boolean;
  anyPass: boolean;
  allSkipped: boolean;
  errors: string[];
  passed: number;
  failed: number;
  skipped: number;
  failedTitles: Set<string>;
  passedTitles: Set<string>;
}

export default class AdminTestRunsPlaywrightReporter implements Reporter {
  private byFile = new Map<string, PerFile>();
  private pending: Promise<void>[] = [];
  /** Captured before Playwright begins executing tests. */
  private worktreeBefore: WorktreeGitSnapshot | null = null;
  private runRoot = resolveAgentWorkspaceRoot({});

  onBegin(config?: Pick<FullConfig, 'rootDir'>): void {
    this.runRoot = resolveAgentWorkspaceRoot(config?.rootDir ? { projectDir: config.rootDir } : {});
    this.worktreeBefore = captureWorktreeSnapshot(this.runRoot);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    try {
      if (process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER === '1') return;
      const file = test.location?.file;
      if (!file) return;

      const existing = this.byFile.get(file) ?? {
        startedAt: result.startTime?.getTime() ?? Date.now(),
        finishedAt: 0,
        anyFail: false,
        anyPass: false,
        allSkipped: true,
        errors: [],
        passed: 0,
        failed: 0,
        skipped: 0,
        failedTitles: new Set<string>(),
        passedTitles: new Set<string>(),
      };

      const endMs = (result.startTime?.getTime() ?? Date.now()) + result.duration;
      existing.startedAt = Math.min(existing.startedAt, result.startTime?.getTime() ?? Date.now());
      existing.finishedAt = Math.max(existing.finishedAt, endMs);

      switch (result.status) {
        case 'passed':
          existing.passed += 1;
          existing.anyPass = true;
          existing.allSkipped = false;
          {
            const title = playwrightCaseTitle(test);
            if (title && existing.passedTitles.size < MAX_RECORDED_PASSED_CASES) existing.passedTitles.add(title);
          }
          break;
        case 'failed':
        case 'timedOut':
        case 'interrupted':
          existing.failed += 1;
          existing.anyFail = true;
          existing.allSkipped = false;
          for (const e of result.errors ?? []) {
            if (e.message) existing.errors.push(e.message);
          }
          {
            const title = playwrightCaseTitle(test);
            if (title && existing.failedTitles.size < MAX_RECORDED_FAILED_CASES) existing.failedTitles.add(title);
          }
          break;
        case 'skipped':
          existing.skipped += 1;
          // keep allSkipped flag until something else lands
          break;
      }

      this.byFile.set(file, existing);
    } catch {
      /* swallow — D-007 */
    }
  }

  onEnd(): void {
    try {
      let worktreeAfter: WorktreeGitSnapshot = { commit: null, porcelain: null };
      try {
        worktreeAfter = captureWorktreeSnapshot(this.runRoot);
      } catch {
        // D-007: missing proof of stability is dirty, never a false clean.
      }
      const worktreeDirty = computeWorktreeDirty(
        this.worktreeBefore ?? { commit: null, porcelain: null },
        worktreeAfter,
      );
      const dirtReason = describeWorktreeDirt(this.worktreeBefore ?? { commit: null, porcelain: null }, worktreeAfter)?.slice(0, 500);
      for (const [file, agg] of this.byFile) {
        try {
          const filePath = toWorkspaceRel(file, this.runRoot);
          const status: TestRunRow['status'] = agg.anyFail
            ? 'fail'
            : agg.allSkipped
            ? 'skip'
            : 'pass';
          const durationMs = Math.max(0, agg.finishedAt - agg.startedAt);
          // Preserve diagnostics in the existing text column while deployed
          // strict execution_details readers await the expanded reason field.
          const output = [...agg.errors, ...(dirtReason ? [`[worktree provenance] ${dirtReason}`] : [])].join('\n');
          const outputTail = output ? output.slice(-4000) : null;
          this.pending.push(
            insertRow({
              filePath,
              status,
              durationMs,
              startedAt: new Date(agg.startedAt),
              finishedAt: new Date(agg.finishedAt),
              outputTail,
              worktreeDirty,
              passed: agg.passed,
              failed: agg.failed,
              skipped: agg.skipped,
              failedCaseTitles: [...agg.failedTitles],
              passedCaseTitles: [...agg.passedTitles],
            }, worktreeAfter, this.runRoot),
          );
        } catch {
          /* swallow per-file */
        }
      }
    } catch {
      /* swallow */
    }
  }

  async onExit(): Promise<void> {
    try {
      await Promise.race([
        Promise.allSettled(this.pending),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      /* swallow */
    }
  }
}
