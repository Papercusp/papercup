import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { missingTestRunReceiptPaths } from '../../../libs/test-config/src/admin-test-runs-reporter.ts';

// scripts/test-files.mjs ships no declaration file yet (residue filed on WI-6554700010049076),
// so the router is loaded through a typed dynamic import that names the one export this
// suite exercises. The URL specifier keeps tsc from resolving the undeclared module.
type ReceiptWatcher = { close: () => void };
type WaitForTestRunReceiptUpdate = <State extends { complete: boolean; retryable?: boolean }>(
  filePath: string,
  readState: () => State,
  options?: {
    timeoutMs?: number;
    watchImpl?: (
      directory: string,
      options: { persistent: boolean },
      onChange: (event: string, fileName: string | null) => void,
    ) => ReceiptWatcher;
  },
) => Promise<State | { complete: false; retryable: false; error: unknown }>;
const testFilesRouterUrl = new URL('../../../scripts/test-files.mjs', import.meta.url).href;
const { waitForTestRunReceiptUpdate } =
  (await import(testFilesRouterUrl)) as { waitForTestRunReceiptUpdate: WaitForTestRunReceiptUpdate };

const expectedPath = 'packages/operator-core/lib/example.test.ts';
const baseReceipt = {
  receiptId: 'receipt-a',
  attempt: 0,
  filePath: expectedPath,
  status: 'pass',
  row: {
    filePath: expectedPath,
    startedAt: '2026-11-02T12:00:00.000Z',
    finishedAt: '2026-11-02T12:00:01.000Z',
  },
};
const timeoutReceipt = {
  ...baseReceipt,
  outcome: 'timeout' as const,
  reason: 'pg_insert_timeout_25000ms',
  replayable: false,
};
const insertedReceipt = {
  ...baseReceipt,
  outcome: 'inserted' as const,
  id: 'test-run-901',
};

const tempDirs: string[] = [];

function receiptFileWithTimeout() {
  const directory = mkdtempSync(join(tmpdir(), 'test-run-receipt-reconcile-'));
  tempDirs.push(directory);
  const file = join(directory, 'receipts.jsonl');
  writeFileSync(file, `${JSON.stringify(timeoutReceipt)}\n`);
  return { directory, file };
}

function readReceiptState(file: string) {
  const receiptLog = readFileSync(file, 'utf8');
  const missingPaths = missingTestRunReceiptPaths(receiptLog, [expectedPath]);
  return {
    complete: missingPaths.length === 0,
    retryable: missingPaths.length > 0,
    missingPaths,
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('test-run receipt reconciliation', () => {
  it('re-reads the original sink and accepts a late inserted receipt without rerunning tests', async () => {
    const { directory, file } = receiptFileWithTimeout();
    const measuredTestRun = vi.fn(() => 'original-run');
    measuredTestRun();
    const watcher = { on: vi.fn(), close: vi.fn() };
    const watchImpl = vi.fn((_directory, _options, onChange) => {
      queueMicrotask(() => {
        appendFileSync(file, `${JSON.stringify(insertedReceipt)}\n`);
        onChange('change', basename(file));
      });
      return watcher;
    });

    const result = await waitForTestRunReceiptUpdate(file, () => readReceiptState(file), {
      timeoutMs: 1_000,
      watchImpl,
    });

    expect(result).toEqual({ complete: true, retryable: false, missingPaths: [] });
    expect(watchImpl).toHaveBeenCalledWith(directory, { persistent: true }, expect.any(Function));
    expect(watcher.close).toHaveBeenCalledOnce();
    expect(measuredTestRun).toHaveBeenCalledOnce();
  });

  it('returns the missing paths at the deadline so the caller can refuse a terminal verdict', async () => {
    const { file } = receiptFileWithTimeout();
    const watcher = { on: vi.fn(), close: vi.fn() };
    vi.useFakeTimers();

    const pending = waitForTestRunReceiptUpdate(file, () => readReceiptState(file), {
      timeoutMs: 25,
      watchImpl: () => watcher,
    });
    await vi.advanceTimersByTimeAsync(25);

    await expect(pending).resolves.toEqual({
      complete: false,
      retryable: true,
      missingPaths: [expectedPath],
    });
    expect(watcher.close).toHaveBeenCalledOnce();
  });
});
