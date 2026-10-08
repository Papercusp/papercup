import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { sql } = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('postgres', () => ({ default: () => sql }));
vi.mock('@papercusp/operator-core/lib/testing-worktree', () => ({
  resolveReporterSourceRoot: () => '/portal',
  captureTestSourceSnapshot: () => ({ commit: 'a'.repeat(40), porcelain: '' }),
  computeWorktreeDirty: () => false,
}));
vi.mock('@papercusp/operator-core/lib/agent-tools/capability/base-dir', () => ({
  resolveAgentWorkspaceRoot: () => '/operator',
}));
import Reporter from '@papercusp/operator-core/lib/testing-playwright-reporter';
import OperatorReporter from '../../../apps/operator/test/reporters/admin-test-runs-reporter-playwright';
import { parseTestRunExecutionDetails } from '@papercusp/test-config/execution-details';

afterEach(() => vi.unstubAllEnvs());

describe('portable Playwright ledger reporter', () => {
  it('keeps operator profiles on the same maintained implementation', () => {
    expect(OperatorReporter).toBe(Reporter);
  });

  it('records exact Portal case identities, runtime scope and returned ledger custody', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'portal-reporter-'));
    const receipts = join(dir, 'receipts.jsonl');
    try {
      vi.stubEnv('PAPERCUSP_DISABLE_TEST_RUNS_REPORTER', '');
      vi.stubEnv('PAPERCUSP_MUTATION_PROBE', '');
      vi.stubEnv('PAPERCUSP_TEST_RUN_HARNESS', 'portal');
      vi.stubEnv('PAPERCUSP_TEST_RUN_WORKSPACE', 'papercusp-workspace');
      vi.stubEnv('PAPERCUSP_TEST_RUN_GROUP', 'portal-e2e-proof');
      vi.stubEnv('PAPERCUSP_TEST_RUN_RECEIPT_FILE', receipts);
      sql.mockReset().mockResolvedValue([{ id: '12345' }]);
      const reporter = new Reporter();
      reporter.onBegin({ rootDir: '/portal/e2e' });
      for (const [title, status] of [['new account', 'passed'], ['stale curriculum', 'failed']] as const) {
        reporter.onTestEnd({
          title, titlePath: () => ['', '', 'portal-product-tutorial.spec.ts', 'account-first', title],
          location: { file: '/portal/e2e/portal-product-tutorial.spec.ts' },
        } as never, {
          status, startTime: new Date(0), duration: 10,
          errors: status === 'failed' ? [{ message: 'curriculum mismatch' }] : [],
        } as never);
      }
      await reporter.onEnd();
      await reporter.onExit();
      expect(sql).toHaveBeenCalledOnce();
      const values = sql.mock.calls[0]!.slice(1);
      expect(values[0]).toBe('e2e/portal-product-tutorial.spec.ts');
      expect(values[1]).toBe('fail');
      const details = values.at(-1);
      expect(details).toMatchObject({
        root: '/portal', testLayer: 'e2e', harnessSlug: 'portal',
        workspaceId: 'papercusp-workspace', runGroupId: 'portal-e2e-proof',
        passed: 1, failed: 1, skipped: 0, worktreeDirty: false,
        passedCaseTitles: ['account-first > new account'],
        failedCaseTitles: ['account-first > stale curriculum'],
      });
      expect(parseTestRunExecutionDetails(details)).toEqual(details);
      expect(JSON.parse(readFileSync(receipts, 'utf8').trim())).toEqual({
        filePath: 'e2e/portal-product-tutorial.spec.ts', status: 'fail', outcome: 'inserted', id: '12345',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
