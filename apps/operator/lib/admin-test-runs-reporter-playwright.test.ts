/**
 * Regression guard for WI-6751.
 *
 * The Playwright reporter must attribute a run to its close-time commit and
 * mark it dirty whenever the shared worktree changed while the run was live.
 * A cached resolveGitContext() commit is display metadata, not provenance.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  captureWorktreeSnapshot: vi.fn(),
  computeWorktreeDirty: vi.fn(),
  resolveAgentWorkspaceRoot: vi.fn(() => '/repo'),
  resolveGitContext: vi.fn(async () => ({ branch: 'staging', commit: 'stale-cached-sha' })),
  resolveTestRunSource: vi.fn(() => 'admin-ui'),
  sql: vi.fn(async () => []),
}));

vi.mock('@papercusp/operator-core/lib/testing-worktree', () => ({
  captureWorktreeSnapshot: mocks.captureWorktreeSnapshot,
  computeWorktreeDirty: mocks.computeWorktreeDirty,
}));
vi.mock('@papercusp/operator-core/lib/agent-tools/capability/base-dir', () => ({
  resolveAgentWorkspaceRoot: mocks.resolveAgentWorkspaceRoot,
}));
vi.mock('@papercusp/operator-core/lib/testing-branch-resolve', () => ({
  resolveGitContext: mocks.resolveGitContext,
}));
vi.mock('@papercusp/operator-core/lib/testing-run-source', () => ({
  resolveTestRunSource: mocks.resolveTestRunSource,
}));
vi.mock('postgres', () => ({ default: () => mocks.sql }));

import AdminTestRunsPlaywrightReporter, {
  playwrightExecutionDetails,
} from '../test/reporters/admin-test-runs-reporter-playwright';
import { parseTestRunExecutionDetails, recordedTestLayer } from '@papercusp/test-config/execution-details';

describe('AdminTestRunsPlaywrightReporter worktree provenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER;
    delete process.env.PAPERCUSP_TEST_RUN_GROUP;
    delete process.env.PAPERCUSP_TEST_RUN_HARNESS;
    delete process.env.PAPERCUSP_WORKSPACE_ID;
  });

  it('uses the post-run commit and persists a dirty verdict from the before/after snapshots', async () => {
    const before = { commit: 'before-sha', porcelain: '' };
    const after = { commit: 'after-sha', porcelain: ' M peer-edit.ts' };
    mocks.captureWorktreeSnapshot.mockReturnValueOnce(before).mockReturnValueOnce(after);
    mocks.computeWorktreeDirty.mockReturnValue(true);

    const reporter = new AdminTestRunsPlaywrightReporter();
    const startedAt = new Date('2026-08-21T00:00:00.000Z');
    reporter.onBegin();
    reporter.onTestEnd(
      { location: { file: '/repo/specs/example.spec.ts' } } as never,
      { startTime: startedAt, duration: 17, status: 'passed', errors: [] } as never,
    );
    reporter.onEnd();
    await reporter.onExit();

    expect(mocks.captureWorktreeSnapshot).toHaveBeenCalledTimes(2);
    expect(mocks.computeWorktreeDirty).toHaveBeenCalledWith(before, after);
    expect(mocks.sql).toHaveBeenCalledTimes(1);

    const values = mocks.sql.mock.calls[0]!.slice(1);
    expect(values[0]).toBe('specs/example.spec.ts');
    // `playwright` is a SQL-template literal, so commit_sha is value slot 9.
    expect(values[9]).toBe('after-sha');
    expect(values).not.toContain('stale-cached-sha');
    // worktree_dirty precedes execution_details (EI-24434635346407728).
    expect(values.at(-2)).toBe(true);

    // The persisted execution_details must parse through the SAME reader the
    // acceptance-bar layer check uses, and must say e2e — otherwise no Playwright
    // run can ever satisfy a BAR clause whose requiredTestLayers includes e2e.
    const stored = JSON.parse(String(values.at(-1)));
    expect(parseTestRunExecutionDetails(stored)).toBeDefined();
    expect(recordedTestLayer(stored)).toBe('e2e');
    expect(stored).toMatchObject({
      filePath: 'specs/example.spec.ts',
      commitSha: 'after-sha',
      worktreeDirty: true,
      passed: 1,
      failed: 0,
      skipped: 0,
    });
  });
});

describe('playwrightExecutionDetails', () => {
  it('stamps the e2e runtime layer with counts that the shared parser accepts', () => {
    const details = playwrightExecutionDetails(
      {
        filePath: 'apps/operator/e2e/x.spec.ts',
        status: 'fail',
        durationMs: 5,
        startedAt: new Date(0),
        finishedAt: new Date(5),
        outputTail: null,
        worktreeDirty: false,
        passed: 2,
        failed: 1,
        skipped: 3,
      },
      { root: '/repo', runGroupId: 'g1', workspaceId: 'w1', harnessSlug: 'papercusp', commitSha: 'abc' },
    );
    expect(details.testLayer).toBe('e2e');
    const parsed = parseTestRunExecutionDetails(details);
    expect(parsed).toBeDefined();
    expect(recordedTestLayer(details)).toBe('e2e');
    expect(parsed).toMatchObject({ passed: 2, failed: 1, skipped: 3, collectionFailed: false, commitSha: 'abc' });
  });
});
