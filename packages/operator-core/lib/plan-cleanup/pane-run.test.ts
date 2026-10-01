/**
 * WI-10004730 — the Plans pane must show the run that needs the owner, not
 * merely the newest one. Measured 2026-10-01: failed single-plan run
 * bulk-c5ef8aea (2026-09-06) was newer than review run bulk-bc6d1eeb
 * (2026-09-01, 26 pending recommendations), so the pane pinned the failure and
 * the review work disappeared from the only surface that offers it.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BulkRunRow } from '../attention/bulk-run-store';
import { selectPlanCleanupPaneRun } from './pane-run';

function run(runId: string, phase: BulkRunRow['phase'], createdAt: string): BulkRunRow {
  return {
    runId,
    workspaceId: 'workspace-1',
    harnessSlug: 'papercusp',
    requestedBy: 'owner',
    resolverOwner: null,
    phase,
    runKind: 'plan-cleanup',
    seedRefs: ['plan-a'],
    filterSnapshot: {},
    launchSnapshot: {},
    totalItems: 1,
    autoResolved: 0,
    recommended: 0,
    skipped: 0,
    failed: 0,
    error: phase === 'failed' ? 'settle refused: no evidence' : null,
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    finishedAt: null,
    heartbeatAt: null,
  };
}

/** The two store reads over one in-memory run table, mirroring their SQL. */
function storeOver(rows: BulkRunRow[]) {
  const newestFirst = [...rows].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return {
    getActive: vi.fn(async () => newestFirst.find((r) => ['pending', 'running', 'review'].includes(r.phase)) ?? null),
    getLatest: vi.fn(async () => newestFirst[0] ?? null),
  };
}

describe('selectPlanCleanupPaneRun', () => {
  const review = run('bulk-bc6d1eeb', 'review', '2026-09-01T10:00:00.000Z');
  const failed = run('bulk-c5ef8aea', 'failed', '2026-09-06T10:00:00.000Z');

  it('shows an older REVIEW run ahead of a newer FAILED run (the measured incident)', async () => {
    const store = storeOver([review, failed]);
    expect((await selectPlanCleanupPaneRun(store))?.runId).toBe('bulk-bc6d1eeb');
  });

  it('control: the pre-fix rule (newest of any phase) shows the failed run instead', async () => {
    const store = storeOver([review, failed]);
    expect((await store.getLatest())?.runId).toBe('bulk-c5ef8aea');
  });

  it('falls back to the newest run when nothing is open, so a fresh failure still reports itself', async () => {
    const complete = run('bulk-old', 'complete', '2026-08-24T10:00:00.000Z');
    const store = storeOver([complete, failed]);
    expect((await selectPlanCleanupPaneRun(store))?.runId).toBe('bulk-c5ef8aea');
    expect(store.getLatest).toHaveBeenCalledTimes(1);
  });

  it('does not consult the latest read when an open run exists', async () => {
    const store = storeOver([review, failed]);
    await selectPlanCleanupPaneRun(store);
    expect(store.getLatest).not.toHaveBeenCalled();
  });

  it('returns null on an empty workspace', async () => {
    expect(await selectPlanCleanupPaneRun(storeOver([]))).toBeNull();
  });
});
