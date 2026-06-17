/**
 * Unit coverage for the in-memory admin-test-run store (admin-test-runs-store.ts).
 *
 * runAdminTestSuites (the actual suite runner) is mocked to a pending promise
 * that rejects on abort, so the store's own invariants are what's under test:
 * the running-snapshot shape, snapshot CLONING (a caller mutating a returned
 * snapshot must never corrupt the store), the MAX_RUNS eviction cap (memory-leak
 * guard), and the cancel→cancelled lifecycle.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./admin-test-suites', () => ({
  runAdminTestSuites: vi.fn(
    (_sel: unknown, _cbs: unknown, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  ),
}));

import { startAdminTestRun, getAdminTestRunSnapshot, cancelAdminTestRun } from './admin-test-runs-store';

beforeEach(() => {
  (globalThis as { __papercuspAdminTestRuns?: unknown }).__papercuspAdminTestRuns = undefined;
});

describe('admin-test-runs-store', () => {
  it('start returns a running snapshot with the selection + empty buffers', () => {
    const snap = startAdminTestRun('all-safe');
    expect(snap).toMatchObject({
      selection: 'all-safe',
      status: 'running',
      error: null,
      results: [],
      logs: [],
      finishedAt: null,
    });
    expect(snap.runId).toMatch(/^testrun-/);
  });

  it('getAdminTestRunSnapshot returns a CLONE — mutating it never corrupts the store', () => {
    const { runId } = startAdminTestRun('all-safe');
    const a = getAdminTestRunSnapshot(runId)!;
    a.logs.push({ id: 9, suiteId: 'system', level: 'info', line: 'tamper', ts: 0 } as never);
    a.status = 'error';
    const b = getAdminTestRunSnapshot(runId)!;
    expect(b.logs).toHaveLength(0); // store untouched by the caller's mutation
    expect(b.status).toBe('running');
  });

  it('returns null for an unknown run (get + cancel)', () => {
    expect(getAdminTestRunSnapshot('nope')).toBeNull();
    expect(cancelAdminTestRun('nope')).toBeNull();
  });

  it('caps the store at MAX_RUNS (20), evicting older runs', () => {
    const ids: string[] = [];
    for (let i = 0; i < 22; i++) ids.push(startAdminTestRun('all-safe').runId);
    const alive = ids.filter((id) => getAdminTestRunSnapshot(id) !== null);
    expect(alive).toHaveLength(20); // 22 started − 2 evicted
  });

  it('cancel aborts a running run → status transitions to cancelled', async () => {
    const { runId } = startAdminTestRun('all-safe');
    const out = cancelAdminTestRun(runId);
    expect(out).not.toBeNull();
    // The abort rejects the (mocked) runner; the IIFE catch flips status to cancelled.
    await vi.waitFor(() => expect(getAdminTestRunSnapshot(runId)?.status).toBe('cancelled'));
  });
});
