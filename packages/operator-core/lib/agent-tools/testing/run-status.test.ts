/**
 * testing:run-status — handler coverage for detached testing:run snapshots.
 *
 * The store lifecycle is covered by testing-run-store.test.ts; this suite
 * pins the MCP-facing found/unknown response and the guidance that makes the
 * timeout recovery callable.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../testing-run-store', async (orig) => ({
  ...(await orig<typeof import('../../testing-run-store')>()),
  getRun: vi.fn(),
  getRunAsync: vi.fn(),
  getTestRunLedgerRecoveryAsync: vi.fn(),
}));

import {
  getRunAsync,
  getTestRunLedgerRecoveryAsync,
  TestingRunSnapshotUnavailableError,
  type DetachedRunLedgerRecovery,
  type RunSnapshot,
} from '../../testing-run-store';
import { detachedRecoveryHint, detachedTestTimeoutHint } from './run';

const getRunMock = vi.mocked(getRunAsync);
const ledgerRecoveryMock = vi.mocked(getTestRunLedgerRecoveryAsync);
const tool = (await import('./run-status')).default;

type Output = { data: Record<string, unknown> };

const call = (runId: string) => tool.handler({ runId } as never, {} as never) as Promise<Output>;

beforeEach(() => {
  getRunMock.mockReset();
  ledgerRecoveryMock.mockReset();
  ledgerRecoveryMock.mockResolvedValue(null);
});

describe('testing:run-status handler', () => {
  it('returns the bounded snapshot for a known detached run', async () => {
    const snapshot: RunSnapshot = {
      runId: 'run-1',
      kind: 'vitest',
      label: 'detached test',
      command: ['node', 'scripts/test-files.mjs'],
      status: 'running',
      exitCode: null,
      startedAt: 123,
      finishedAt: null,
      output: 'collected 1 test',
      truncated: false,
    };
    getRunMock.mockResolvedValue(snapshot);

    const out = await call(snapshot.runId);

    expect(out.data).toEqual({ ok: true, snapshot });
    expect(getRunMock).toHaveBeenCalledWith(snapshot.runId);
  });

  it('returns explicit unknown_run for an absent or evicted id', async () => {
    getRunMock.mockResolvedValue(null);

    const out = await call('missing-run');

    expect(out.data).toMatchObject({ ok: false, error: 'unknown_run', runId: 'missing-run' });
    expect(String(out.data.message)).toContain('not evidence that the test passed');
  });

  it('returns retryable snapshot_unavailable when the durable store cannot be read', async () => {
    getRunMock.mockRejectedValue(new TestingRunSnapshotUnavailableError());

    const out = await call('run-1');

    expect(out.data).toEqual({
      ok: false,
      error: 'snapshot_unavailable',
      runId: 'run-1',
      retryable: true,
      message: expect.stringContaining('Retry testing:run-status'),
    });
  });

  it('recovers a terminal verdict from per-file ledger rows when the lifecycle snapshot is unavailable', async () => {
    const ledgerRecovery: DetachedRunLedgerRecovery = {
      runId: 'run-ledger',
      status: 'pass',
      exitCode: 0,
      finishedAt: 1_700_000_005_000,
      fileCount: 2,
      files: [
        { filePath: 'lib/one.test.ts', status: 'pass', finishedAt: 1_700_000_004_000 },
        { filePath: 'lib/two.test.ts', status: 'pass', finishedAt: 1_700_000_005_000 },
      ],
      message: 'Recovered pass from 2 latest per-file test_runs row(s); the detached lifecycle snapshot is missing or unreadable.',
    };
    getRunMock.mockRejectedValue(new TestingRunSnapshotUnavailableError());
    ledgerRecoveryMock.mockResolvedValue(ledgerRecovery);

    const out = await call(ledgerRecovery.runId);

    expect(out.data).toEqual({ ok: true, ledgerRecovery });
    expect(ledgerRecoveryMock).toHaveBeenCalledWith(ledgerRecovery.runId);
  });

  it('also checks the per-file ledger when no lifecycle snapshot row exists', async () => {
    const ledgerRecovery: DetachedRunLedgerRecovery = {
      runId: 'run-ledger-missing-snapshot',
      status: 'fail',
      exitCode: 1,
      finishedAt: 1_700_000_005_000,
      fileCount: 1,
      files: [{ filePath: 'lib/failing.test.ts', status: 'fail', finishedAt: 1_700_000_005_000 }],
      message: 'Recovered fail from 1 latest per-file test_runs row(s); the detached lifecycle snapshot is missing or unreadable.',
    };
    getRunMock.mockResolvedValue(null);
    ledgerRecoveryMock.mockResolvedValue(ledgerRecovery);

    const out = await call(ledgerRecovery.runId);

    expect(out.data).toEqual({ ok: true, ledgerRecovery });
  });

  it('documents the callable timeout recovery poll surface', () => {
    expect(tool.description).toContain('testing:run-status { runId }');
    expect(tool.description).toContain('ledgerRecovery');
    expect(tool.guidance?.chaining).toContain('testing:run-status { runId }');
    expect(detachedTestTimeoutHint(['packages/operator-core/lib/example.test.ts'])).toContain('testing:run-status { runId }');
    expect(detachedTestTimeoutHint(['packages/operator-core/lib/example.integration.test.ts'])).toContain(
      'testing:run-status { runId }',
    );
  });
});

/**
 * The advertised detachedRunId is only pollable across an operator restart if its
 * durable snapshot actually landed. startRun's own write is fire-and-forget,
 * bounded at 1s and swallows failures, so the promise we print must track the
 * persist result rather than the mere existence of an id.
 */
describe('detachedRecoveryHint durability gate', () => {
  const runId = 'run-42';

  it('promises the poll surface when the durable snapshot landed', () => {
    const hint = detachedRecoveryHint({ runId, durable: true });

    expect(hint).toContain(runId);
    expect(hint).toContain(`poll it with testing:run-status { runId: '${runId}' }`);
  });

  it('warns when the initial snapshot is not confirmed before the response deadline', () => {
    const hint = detachedRecoveryHint({ runId, durable: false });

    // The id is still surfaced — it stays readable from this process's map.
    expect(hint).toContain(runId);
    // But we must not tell the caller the poll will answer, and must not let an
    // unknown_run be read as a pass.
    expect(hint).not.toContain(`poll it with testing:run-status { runId: '${runId}' }`);
    expect(hint).toContain('unknown_run');
    expect(hint).toContain('NOT evidence the tests passed');
    expect(hint).toContain('initial durable snapshot was NOT confirmed before the response deadline');
    expect(hint).not.toContain('could NOT be written');
  });

  it('emits nothing when no detached recovery was started', () => {
    expect(detachedRecoveryHint({ runId: undefined, durable: true })).toBe('');
    expect(detachedRecoveryHint({ runId: undefined, durable: false })).toBe('');
  });
});
