/**
 * pipeline-events.test.ts — pure unit coverage for the window-fold logic (mig 177).
 * The append/summarize/recent DB round-trip is covered in
 * pipeline-events.integration.test.ts (real Postgres).
 */
import { describe, expect, it } from 'vitest';
import { foldPipelineWindow, emptyWindow } from './pipeline-events';

describe('foldPipelineWindow', () => {
  it('folds (kind,status,count) rows into the typed per-kind summary', () => {
    const w = foldPipelineWindow(
      [
        { kind: 'git_sync', status: 'synced', n: 100 },
        { kind: 'git_sync', status: 'nothing', n: 40 },
        { kind: 'git_sync', status: 'conflict', n: 3 },
        { kind: 'git_sync', status: 'error', n: 1 },
        { kind: 'merge_resolver', status: 'ok', n: 2 },
        { kind: 'merge_resolver', status: 'failed', n: 1 },
        { kind: 'green_checkpoint', status: 'advanced', n: 5 },
        { kind: 'green_checkpoint', status: 'up-to-date', n: 18 },
        { kind: 'green_checkpoint', status: 'not-green', n: 2 },
      ],
      1000,
    );
    expect(w.sinceMs).toBe(1000);
    expect(w.gitSync).toEqual({ total: 144, synced: 100, nothing: 40, conflict: 3, error: 1 });
    expect(w.mergeResolver).toEqual({ total: 3, ok: 2, failed: 1, error: 0 });
    expect(w.greenCheckpoint).toMatchObject({ total: 25, advanced: 5, upToDate: 18, notGreen: 2 });
  });

  it('counts unknown statuses toward the kind total but not a named bucket', () => {
    const w = foldPipelineWindow([{ kind: 'git_sync', status: 'weird-future-status', n: 7 }], 0);
    expect(w.gitSync.total).toBe(7);
    expect(w.gitSync.synced + w.gitSync.nothing + w.gitSync.conflict + w.gitSync.error).toBe(0);
  });

  it('coerces string counts (postgres count(*) can arrive as text) and ignores unknown kinds', () => {
    const w = foldPipelineWindow(
      [
        { kind: 'git_sync', status: 'synced', n: '12' },
        { kind: 'deploy', status: 'ok', n: 9 }, // not surfaced in the windowed summary
      ],
      0,
    );
    expect(w.gitSync.synced).toBe(12);
    expect(w.gitSync.total).toBe(12);
  });

  it('emptyWindow is all zeros', () => {
    const w = emptyWindow(42);
    expect(w.sinceMs).toBe(42);
    expect(w.gitSync.total).toBe(0);
    expect(w.mergeResolver.total).toBe(0);
    expect(w.greenCheckpoint.total).toBe(0);
  });
});
