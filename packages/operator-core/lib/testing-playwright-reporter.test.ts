import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const runtime = vi.hoisted(() => ({ reportRuntimeVintage: vi.fn(), listRuntimeVintage: vi.fn(),
  measureRuntimeVintageEnvironment: vi.fn(() => 'b'.repeat(64)) }));
vi.mock('./runtime-vintage', () => runtime);
import Reporter, { prepareNativeRuntimeReader } from '@papercusp/operator-core/lib/testing-playwright-reporter';
import OperatorReporter from '../../../apps/operator/test/reporters/admin-test-runs-reporter-playwright';
import { parseTestRunExecutionDetails } from '@papercusp/test-config/execution-details';

afterEach(() => vi.unstubAllEnvs());

describe('portable Playwright ledger reporter', () => {
  it('prepares the owned native observer from source custody and the loaded executable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-runtime-reader-'));
    const receipt = join(dir, 'receipt.json');
    try {
      writeFileSync(receipt, JSON.stringify({ schemaVersion: 'verifier-source-v1', sourceCommit: 'a'.repeat(40) }));
      vi.stubEnv('VERIFY_TAURI_PID', String(process.pid));
      vi.stubEnv('PAPERCUSP_VERIFY_TAURI_ISOLATED', '1');
      vi.stubEnv('VERIFY_TAURI_SOURCE_REF', 'a'.repeat(40));
      vi.stubEnv('VERIFY_TAURI_SOURCE_RECEIPT', receipt);
      vi.stubEnv('OPERATOR_SOURCE_ROOT', dir);
      vi.stubEnv('PAPERCUSP_WORKSPACE_ID', 'owned-runtime');
      runtime.listRuntimeVintage.mockResolvedValue([]);
      const reader = await prepareNativeRuntimeReader(dir, 'a'.repeat(40));
      expect(runtime.reportRuntimeVintage).toHaveBeenLastCalledWith(expect.objectContaining({
        workspaceId: 'owned-runtime', pid: process.pid, treeSha: 'a'.repeat(40),
        bundleVersion: expect.stringMatching(/^executable-sha256:[a-f0-9]{64}$/),
      }));
      expect(await reader!()).toMatchObject({ units: [`verify-tauri-headless:${process.pid}`], fingerprint: 'b'.repeat(64) });
      runtime.measureRuntimeVintageEnvironment.mockReturnValueOnce(null as never);
      expect(await reader!()).toBeNull();
      await expect(prepareNativeRuntimeReader(dir, 'c'.repeat(40))).rejects.toThrow('source receipt mismatch');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['stable', 'changed', 'unavailable', 'invalid', 'error', 'timed-out'])(
    'records original before/after runtime capture with explicit %s outcome', async outcome => {
      vi.stubEnv('PAPERCUSP_DISABLE_TEST_RUNS_REPORTER', '');
      const witness = { schemaVersion: 1 as const, units: ['owned-native'], fingerprint: 'a'.repeat(64),
        observedAt: '2000-01-01T00:00:00.000Z' };
      const read = vi.fn(async () => witness);
      if (outcome === 'changed') read.mockResolvedValueOnce(witness).mockResolvedValueOnce({ ...witness, fingerprint: 'b'.repeat(64) });
      if (outcome === 'unavailable') read.mockResolvedValue(null as never);
      if (outcome === 'invalid') read.mockResolvedValue({ ...witness, fingerprint: 'caller-claim' });
      if (outcome === 'error') read.mockRejectedValue(new Error('observer failed'));
      if (outcome === 'timed-out') { vi.useFakeTimers(); read.mockImplementation(() => new Promise(() => {})); }
      sql.mockReset().mockResolvedValue([{ id: '6789' }]);
      try {
        const reporter = new Reporter({ readRuntimeEnvironment: read });
        const begin = reporter.onBegin();
        if (outcome === 'timed-out') await vi.advanceTimersByTimeAsync(1001);
        await begin;
        reporter.onTestEnd({ title: 'native proof', location: { file: '/portal/native.spec.ts' } } as never,
          { status: 'passed', startTime: new Date(), duration: 1, errors: [] } as never);
        const end = reporter.onEnd();
        if (outcome === 'timed-out') await vi.advanceTimersByTimeAsync(1001);
        await end; await reporter.onExit();
        const details = sql.mock.calls[0]!.at(-1) as any;
        expect(parseTestRunExecutionDetails(details)).toEqual(details);
        const status = outcome === 'stable' || outcome === 'changed' ? 'captured' : outcome;
        expect(details.runtimeEnvironmentBeforeCaptureStatus).toBe(status);
        expect(details.runtimeEnvironmentAfterCaptureStatus).toBe(status);
        if (status === 'captured') {
          expect(details.runtimeEnvironmentBefore.observedAt).not.toBe(witness.observedAt);
          expect(details.runtimeEnvironmentAfter.fingerprint).toBe(outcome === 'changed' ? 'b'.repeat(64) : witness.fingerprint);
        } else {
          expect(details).not.toHaveProperty('runtimeEnvironmentBefore');
          expect(details).not.toHaveProperty('runtimeEnvironmentAfter');
        }
      } finally { vi.useRealTimers(); }
    });

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
