/**
 * test-run-ledger.ts — record a LIVE llm-test scenario run in `harness_shared.test_runs`.
 *
 * EI-24434635346407728. `llm-test run` executes a scenario against a live model and
 * persists its rich report to `harness_shared.llm_test_runs`, but acceptance BAR
 * clauses bind to the shared test ledger (`test_runs` + `execution_details`). Before
 * this module a live scenario left no `test_runs` row, so a clause whose
 * `requiredTestLayers` includes `llm` had nothing to bind to and was unsatisfiable.
 *
 * The recorded layer is a RUNTIME fact: only the live runner calls this, so it stamps
 * `llm`. Replaying stored model output under the unit Vitest config never reaches here
 * and records `unit` through the ordinary Vitest reporter.
 *
 * Fail-soft like the Vitest/Playwright reporters: a ledger write must never change the
 * scenario verdict or the CLI exit code.
 */

import { existsSync } from 'node:fs';
import { posix, relative } from 'node:path';

import type { RunReport } from '@papercusp/testing-shell/llm';
import {
  TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION,
  type TestRunExecutionDetails,
} from '@papercusp/test-config/execution-details';

import { resolveAgentWorkspaceRoot } from '../agent-tools/capability/base-dir';
import { getLongLivedAdminPool } from '../long-lived-admin-pool';
import { sharedUtilityPoolMax } from '../resource-profile';
import { resolveGitContext } from '../testing-branch-resolve';
import { resolveTestRunSource } from '../testing-run-source';
import { captureWorktreeSnapshot, computeWorktreeDirty, type WorktreeGitSnapshot } from '../testing-worktree';

export interface LlmScenarioLedgerRow {
  filePath: string;
  status: 'pass' | 'fail' | 'skip' | 'error';
  durationMs: number;
  startedAt: Date;
  finishedAt: Date;
  outputTail: string | null;
  executionDetails: TestRunExecutionDetails;
}

export interface LlmScenarioLedgerContext {
  root: string;
  filePath: string;
  runGroupId: string | null;
  workspaceId: string | null;
  harnessSlug: string | null;
  commitSha: string | null;
  worktreeDirty: boolean;
  /** Fallback clock when the report carries no runs. */
  now?: Date;
}

/** Pure projection of a live scenario report onto one `test_runs` row. */
export function llmScenarioLedgerRow(report: RunReport, ctx: LlmScenarioLedgerContext): LlmScenarioLedgerRow {
  const passed = report.runs.filter((r) => r.status === 'passed').length;
  const failed = report.runs.filter((r) => r.status === 'failed').length;
  const errored = report.runs.filter((r) => r.status === 'errored').length;

  const status: LlmScenarioLedgerRow['status'] =
    report.runs.length === 0 ? 'skip'
      : failed > 0 ? 'fail'
        : errored > 0 ? 'error'
          : 'pass';

  const now = ctx.now ?? new Date();
  const starts = report.runs.map((r) => new Date(r.summary.startedAt).getTime()).filter(Number.isFinite);
  const ends = report.runs.map((r) => new Date(r.summary.finishedAt).getTime()).filter(Number.isFinite);
  const startedAt = starts.length ? new Date(Math.min(...starts)) : now;
  const finishedAt = ends.length ? new Date(Math.max(...ends)) : now;

  const outputTail = status === 'pass' ? null
    : `llm-test ${report.scenarioId} verdict=${report.verdict} runs=${report.runs.length} passed=${passed} failed=${failed} errored=${errored}`;

  return {
    filePath: ctx.filePath,
    status,
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    startedAt,
    finishedAt,
    outputTail,
    executionDetails: {
      schemaVersion: TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION,
      root: ctx.root,
      filePath: ctx.filePath,
      runGroupId: ctx.runGroupId,
      workspaceId: ctx.workspaceId,
      harnessSlug: ctx.harnessSlug,
      testNamePattern: null,
      testLayer: 'llm',
      // An errored run measured nothing it could pass; count it against the file.
      passed,
      failed: failed + errored,
      skipped: 0,
      collectionFailed: false,
      mutationPhase: null,
      commitSha: ctx.commitSha,
      worktreeDirty: ctx.worktreeDirty,
    },
  };
}

/** Workspace-relative POSIX path, or null when the scenario file is not on disk. */
export function scenarioLedgerPath(absPath: string | undefined, root: string): string | null {
  if (!absPath || !existsSync(absPath)) return null;
  const rel = relative(root, absPath);
  if (rel.startsWith('..')) return null;
  return rel.split(/[/\\]/).join(posix.sep);
}

/** Snapshot taken BEFORE the scenario runs, so the row can prove the tree was stable. */
export function beginLlmScenarioLedger(): WorktreeGitSnapshot | null {
  try {
    return captureWorktreeSnapshot();
  } catch {
    return null;
  }
}

/**
 * Insert the ledger row for a finished live scenario. Returns the new `test_runs.id`, or
 * null when it could not be recorded (no scenario file, DB unreachable). Never throws.
 */
export async function recordLlmScenarioTestRun(
  report: RunReport,
  scenarioFilePath: string | undefined,
  before: WorktreeGitSnapshot | null,
): Promise<number | null> {
  try {
    const root = resolveAgentWorkspaceRoot({});
    const filePath = scenarioLedgerPath(scenarioFilePath, root);
    if (!filePath) return null;

    const after = captureWorktreeSnapshot();
    const worktreeDirty = before ? computeWorktreeDirty(before, after) : true;
    const { branch } = await resolveGitContext().catch(() => ({ branch: null as string | null }));
    const runGroupId = process.env.PAPERCUSP_TEST_RUN_GROUP ?? report.matrixGroupId ?? null;
    const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID ?? null;
    const harnessSlug = process.env.PAPERCUSP_TEST_RUN_HARNESS ?? null;

    const row = llmScenarioLedgerRow(report, {
      root, filePath, runGroupId, workspaceId, harnessSlug,
      commitSha: after.commit ?? null,
      worktreeDirty,
    });

    // Same pool + options as ./storage, so the two writers share one connection budget.
    const sql = getLongLivedAdminPool('llm-testing-storage', { max: sharedUtilityPoolMax(), prepare: false });
    const inserted = (await sql`
      INSERT INTO harness_shared.test_runs
        (file_path, framework, status, duration_ms, started_at, finished_at, output_tail,
         run_group_id, source, branch, commit_sha, harness_slug, workspace_id, worktree_dirty, execution_details)
      VALUES
        (${row.filePath}, 'llm-test', ${row.status}, ${row.durationMs}, ${row.startedAt}, ${row.finishedAt},
         ${row.outputTail}, ${runGroupId}, ${resolveTestRunSource()}, ${branch ?? null}, ${after.commit ?? null},
         ${harnessSlug}, ${workspaceId}, ${worktreeDirty}, ${JSON.stringify(row.executionDetails)}::jsonb)
      RETURNING id
    `) as unknown as Array<{ id: string | number }>;
    const id = inserted[0]?.id;
    return id === undefined ? null : Number(id);
  } catch {
    return null;
  }
}
