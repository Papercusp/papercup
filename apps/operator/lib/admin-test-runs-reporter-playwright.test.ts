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
    mocks.resolveAgentWorkspaceRoot.mockImplementation(() => '/repo');
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
    // EI-24799048791133095: the jsonb param is the OBJECT, never pre-stringified
    // text (postgres-js would encode that twice into a jsonb STRING scalar).
    const stored = values.at(-1);
    expect(typeof stored).toBe('object');
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

  it('records the actual isolated Playwright checkout despite an ambient agent tree', async () => {
    mocks.resolveAgentWorkspaceRoot.mockImplementation((ctx?: { projectDir?: string }) => ctx?.projectDir ? '/proof' : '/repo');
    const snapshot = { commit: 'proof-sha', porcelain: '' };
    mocks.captureWorktreeSnapshot.mockReturnValue(snapshot);
    mocks.computeWorktreeDirty.mockReturnValue(false);
    const reporter = new AdminTestRunsPlaywrightReporter();
    reporter.onBegin({ rootDir: '/proof/apps/operator/e2e' });
    reporter.onTestEnd(
      { location: { file: '/proof/apps/operator/e2e/tutorial.spec.ts' } } as never,
      { startTime: new Date(0), duration: 17, status: 'passed', errors: [] } as never,
    );
    reporter.onEnd();
    await reporter.onExit();
    expect(mocks.captureWorktreeSnapshot.mock.calls).toEqual([['/proof'], ['/proof']]);
    const values = mocks.sql.mock.calls[0]!.slice(1);
    expect(values[0]).toBe('apps/operator/e2e/tutorial.spec.ts');
    expect(values[9]).toBe('proof-sha');
    expect(values.at(-1)).toMatchObject({ root: '/proof', commitSha: 'proof-sha', worktreeDirty: false });
    expect(mocks.resolveGitContext).not.toHaveBeenCalled();
  });

  it.each([
    [{ commit: null, porcelain: '' }, { commit: 'sha', porcelain: '' }, 'HEAD unreadable'],
    [{ commit: 'sha', porcelain: '' }, { commit: 'sha', porcelain: null }, 'git status unreadable after'],
    [{ commit: 'before', porcelain: '' }, { commit: 'after', porcelain: '' }, 'HEAD moved before -> after'],
    [{ commit: 'sha', porcelain: ' M source.ts' }, { commit: 'sha', porcelain: '' }, 'before the run:  M source.ts'],
    [{ commit: 'sha', porcelain: '' }, { commit: 'sha', porcelain: '?? generated.json' }, 'after the run: ?? generated.json'],
  ])('retains the dirty snapshot cause in the existing output field (%s)', async (before, after, reason) => {
    mocks.captureWorktreeSnapshot.mockReturnValueOnce(before).mockReturnValueOnce(after);
    mocks.computeWorktreeDirty.mockReturnValue(true);
    const reporter = new AdminTestRunsPlaywrightReporter();
    reporter.onBegin();
    reporter.onTestEnd({ location: { file: '/repo/e2e/example.spec.ts' } } as never,
      { startTime: new Date(0), duration: 1, status: 'failed', errors: [{ message: 'original assertion failure' }] } as never);
    reporter.onEnd();
    await reporter.onExit();
    const values = mocks.sql.mock.calls[0]!.slice(1);
    expect(values[5]).toContain('original assertion failure');
    expect(values[5]).toContain(reason);
    expect(values[5]).toContain('[worktree provenance]');
    expect(values.at(-2)).toBe(true);
    const details = parseTestRunExecutionDetails(values.at(-1));
    expect(details).toMatchObject({ worktreeDirty: true });
    expect(details).not.toHaveProperty('worktreeDirtyReason');
  });

  it('does not add diagnostics to clean runs', async () => {
    mocks.captureWorktreeSnapshot.mockReturnValue({ commit: 'sha', porcelain: '' });
    mocks.computeWorktreeDirty.mockReturnValue(false);
    const reporter = new AdminTestRunsPlaywrightReporter();
    reporter.onBegin();
    reporter.onTestEnd({ location: { file: '/repo/e2e/example.spec.ts' } } as never,
      { startTime: new Date(0), duration: 1, status: 'passed', errors: [] } as never);
    reporter.onEnd();
    await reporter.onExit();
    expect(mocks.sql.mock.calls[0]!.slice(1)[5]).toBeNull();
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
