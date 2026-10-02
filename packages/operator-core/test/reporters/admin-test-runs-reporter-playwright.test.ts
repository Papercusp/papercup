import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestCase, TestResult } from '@playwright/test/reporter';

const { sql } = vi.hoisted(() => ({ sql: Object.assign(vi.fn(), { json: vi.fn((value: unknown) => value) }) }));
const rootMocks = vi.hoisted(() => ({
  resolveAgentWorkspaceRoot: vi.fn(() => '/repo'),
  captureWorktreeSnapshot: vi.fn(() => ({ commit: null, porcelain: null })),
}));
vi.mock('postgres', () => ({ default: () => sql }));
vi.mock('@papercusp/operator-core/lib/testing-branch-resolve', () => ({
  resolveGitContext: async () => ({ branch: 'staging', commit: 'a'.repeat(40) }),
}));
vi.mock('@papercusp/operator-core/lib/agent-tools/capability/base-dir', () => ({
  resolveAgentWorkspaceRoot: rootMocks.resolveAgentWorkspaceRoot,
}));
vi.mock('@papercusp/operator-core/lib/testing-worktree', async importOriginal => ({
  ...(await importOriginal<typeof import('@papercusp/operator-core/lib/testing-worktree')>()),
  captureWorktreeSnapshot: rootMocks.captureWorktreeSnapshot,
}));

import Reporter from './admin-test-runs-reporter-playwright';

const scopeKeys = ['PAPERCUSP_TEST_RUN_HARNESS', 'HARNESS_SLUG', 'PAPERCUSP_HARNESS_SLUG',
  'PAPERCUSP_WORKSPACE_ID', 'PAPERCUSP_WORKSPACE', 'PAPERCUSP_DISABLE_TEST_RUNS_REPORTER'] as const;

async function record(status: TestResult['status'] = 'passed') {
  const reporter = new Reporter();
  reporter.onTestEnd({ location: { file: '/repo/e2e/reader.spec.ts' } } as TestCase,
    { status, startTime: new Date('2026-10-01T19:00:00Z'), duration: 25, errors: [] } as unknown as TestResult);
  reporter.onEnd();
  await reporter.onExit();
}

describe('Playwright execution ledger attribution', () => {
  beforeEach(() => {
    sql.mockReset().mockResolvedValue([]);
    sql.json.mockClear();
    rootMocks.resolveAgentWorkspaceRoot.mockReset().mockReturnValue('/repo');
    rootMocks.captureWorktreeSnapshot.mockReset().mockReturnValue({ commit: null, porcelain: null });
    for (const key of scopeKeys) vi.stubEnv(key, '');
    vi.stubEnv('PAPERCUSP_TEST_RUN_GROUP', 'reader-proof');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('records explicit scope, runtime layer and observed outcomes in the actual insert', async () => {
    vi.stubEnv('PAPERCUSP_TEST_RUN_HARNESS', 'portal-proof');
    vi.stubEnv('HARNESS_SLUG', 'less-specific');
    vi.stubEnv('PAPERCUSP_WORKSPACE_ID', 'workspace-proof');
    await record();
    expect(sql).toHaveBeenCalledOnce();
    expect(sql.mock.calls[0]![0].join('?')).toContain('harness_slug, workspace_id, worktree_dirty, execution_details');
    expect(sql.mock.calls[0]!.slice(1)).toContain('portal-proof');
    expect(sql.mock.calls[0]!.slice(1)).toContain('workspace-proof');
    expect(sql.json).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: 1, root: '/repo', filePath: 'e2e/reader.spec.ts', runGroupId: 'reader-proof',
      harnessSlug: 'portal-proof', workspaceId: 'workspace-proof', testLayer: 'e2e',
      passed: 1, failed: 0, skipped: 0, worktreeDirty: true,
    }));
  });

  it('uses the browser run checkout for both snapshots and the persisted path and commit', async () => {
    rootMocks.resolveAgentWorkspaceRoot.mockImplementation((ctx?: { projectDir?: string }) => ctx?.projectDir ? '/proof' : '/repo');
    rootMocks.captureWorktreeSnapshot.mockReturnValue({ commit: 'proof-sha', porcelain: '' } as never);
    const reporter = new Reporter();
    reporter.onBegin({ rootDir: '/proof/packages/operator-core/e2e' });
    reporter.onTestEnd({ location: { file: '/proof/packages/operator-core/e2e/reader.spec.ts' } } as TestCase,
      { status: 'passed', startTime: new Date(0), duration: 25, errors: [] } as unknown as TestResult);
    reporter.onEnd();
    await reporter.onExit();
    expect(rootMocks.captureWorktreeSnapshot.mock.calls).toEqual([['/proof'], ['/proof']]);
    expect(sql.mock.calls[0]!.slice(1)[0]).toBe('packages/operator-core/e2e/reader.spec.ts');
    expect(sql.json).toHaveBeenCalledWith(expect.objectContaining({ root: '/proof', commitSha: 'proof-sha', worktreeDirty: false }));
  });

  it('reuses interactive scope aliases and preserves failed execution', async () => {
    vi.stubEnv('PAPERCUSP_HARNESS_SLUG', 'interactive-harness');
    vi.stubEnv('PAPERCUSP_WORKSPACE', 'interactive-workspace');
    await record('failed');
    expect(sql.mock.calls[0]!.slice(1)).toContain('fail');
    expect(sql.json).toHaveBeenCalledWith(expect.objectContaining({
      harnessSlug: 'interactive-harness', workspaceId: 'interactive-workspace', passed: 0, failed: 1,
    }));
  });

  it('keeps deliberately unscoped CI rows unscoped', async () => {
    await record('skipped');
    expect(sql.json).toHaveBeenCalledWith(expect.objectContaining({
      harnessSlug: null, workspaceId: null, passed: 0, failed: 0, skipped: 1,
    }));
  });

  it('keeps reporter persistence failures from changing the test outcome', async () => {
    sql.mockRejectedValue(new Error('database unavailable'));
    await expect(record()).resolves.toBeUndefined();
    expect(sql).toHaveBeenCalledOnce();
  });
});
