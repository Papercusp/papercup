/**
 * fleet/bee-completion-reconcile — unit coverage for the post-bee-exit work-item
 * completion safety net (WI-222). Verifies the conservative completion SIGNAL (the
 * pure predicate) and the reconcile wiring (only in_progress/validating → passed,
 * via the canonical setWorkItemState, best-effort) with the DB seams injected.
 */
import { describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '../work-items';
import {
  shouldReconcileBeeCompletion,
  reconcileBeeCompletion,
  maybeReconcileBeeCompletion,
} from './bee-completion-reconcile';

// runWithWorkspace just runs the callback under an ALS scope — keep it real (it has
// no side effects beyond setting the active-workspace store for the callback).

function fakeWorkItem(state: string): WorkItem {
  return { id: 'F-1', kind: 'feature', family: 'feature', harness: 'h', state } as WorkItem;
}

describe('shouldReconcileBeeCompletion (the completion signal)', () => {
  const base = { role: 'bee', exitCode: 0, aborted: false, featureId: 'F-1' };

  it('is true for a clean bee exit on a concrete feature', () => {
    expect(shouldReconcileBeeCompletion(base)).toBe(true);
  });

  it('is false for a non-bee role', () => {
    expect(shouldReconcileBeeCompletion({ ...base, role: 'worker' })).toBe(false);
    expect(shouldReconcileBeeCompletion({ ...base, role: 'validator' })).toBe(false);
  });

  it('is false for a non-zero / null exit (crash) or a cancelled spawn', () => {
    expect(shouldReconcileBeeCompletion({ ...base, exitCode: 1 })).toBe(false);
    expect(shouldReconcileBeeCompletion({ ...base, exitCode: null })).toBe(false);
    expect(shouldReconcileBeeCompletion({ ...base, aborted: true })).toBe(false);
  });

  it('is false without a concrete featureId', () => {
    expect(shouldReconcileBeeCompletion({ ...base, featureId: null })).toBe(false);
    expect(shouldReconcileBeeCompletion({ ...base, featureId: undefined })).toBe(false);
    expect(shouldReconcileBeeCompletion({ ...base, featureId: '' })).toBe(false);
    expect(shouldReconcileBeeCompletion({ ...base, featureId: '-' })).toBe(false);
  });
});

describe('reconcileBeeCompletion (the conservative flip)', () => {
  it('flips in_progress → passed via setWorkItemState and reports true', async () => {
    const getWorkItem = vi.fn().mockResolvedValue(fakeWorkItem('in_progress'));
    const setWorkItemState = vi.fn().mockResolvedValue(fakeWorkItem('passed'));
    const audit = vi.fn();
    const flipped = await reconcileBeeCompletion(
      { harnessSlug: 'h', featureId: 'F-1', workspaceId: 'ws' },
      { getWorkItem, setWorkItemState, audit, log: () => {} },
    );
    expect(flipped).toBe(true);
    expect(setWorkItemState).toHaveBeenCalledWith('F-1', 'passed', {
      harness: 'h',
      by: 'hive-bee-exit',
      skipCompletionGate: true,
    });
    expect(audit).toHaveBeenCalledWith('h', 'F-1', 'in_progress');
  });

  it('flips validating → passed (validator omitted its write)', async () => {
    const getWorkItem = vi.fn().mockResolvedValue(fakeWorkItem('validating'));
    const setWorkItemState = vi.fn().mockResolvedValue(fakeWorkItem('passed'));
    const flipped = await reconcileBeeCompletion(
      { harnessSlug: 'h', featureId: 'F-1', workspaceId: 'ws' },
      { getWorkItem, setWorkItemState, audit: () => {}, log: () => {} },
    );
    expect(flipped).toBe(true);
  });

  it('never force-passes todo/failing/deprecated/blocked/passed — setWorkItemState is not called', async () => {
    for (const state of ['todo', 'failing', 'deprecated', 'blocked', 'passed']) {
      const getWorkItem = vi.fn().mockResolvedValue(fakeWorkItem(state));
      const setWorkItemState = vi.fn();
      const flipped = await reconcileBeeCompletion(
        { harnessSlug: 'h', featureId: 'F-1', workspaceId: 'ws' },
        { getWorkItem, setWorkItemState, audit: () => {}, log: () => {} },
      );
      expect(flipped, `state=${state}`).toBe(false);
      expect(setWorkItemState, `state=${state}`).not.toHaveBeenCalled();
    }
  });

  it('returns false when the work item no longer exists', async () => {
    const getWorkItem = vi.fn().mockResolvedValue(null);
    const setWorkItemState = vi.fn();
    const flipped = await reconcileBeeCompletion(
      { harnessSlug: 'h', featureId: 'F-1', workspaceId: 'ws' },
      { getWorkItem, setWorkItemState, audit: () => {}, log: () => {} },
    );
    expect(flipped).toBe(false);
    expect(setWorkItemState).not.toHaveBeenCalled();
  });

  it('does not audit when the canonical write did not actually settle to passed', async () => {
    const getWorkItem = vi.fn().mockResolvedValue(fakeWorkItem('in_progress'));
    // e.g. a concurrent transition raced it back to failing — the canonical setter
    // returns a non-passed row, so we report no flip and skip the audit.
    const setWorkItemState = vi.fn().mockResolvedValue(fakeWorkItem('failing'));
    const audit = vi.fn();
    const flipped = await reconcileBeeCompletion(
      { harnessSlug: 'h', featureId: 'F-1', workspaceId: 'ws' },
      { getWorkItem, setWorkItemState, audit, log: () => {} },
    );
    expect(flipped).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('maybeReconcileBeeCompletion (gate + best-effort)', () => {
  it('no-ops (without touching the DB seams) when the predicate is false', async () => {
    const getWorkItem = vi.fn();
    const setWorkItemState = vi.fn();
    const flipped = await maybeReconcileBeeCompletion(
      { role: 'worker', exitCode: 0, aborted: false, featureId: 'F-1', harnessSlug: 'h', workspaceId: 'ws' },
      { getWorkItem, setWorkItemState, audit: () => {}, log: () => {} },
    );
    expect(flipped).toBe(false);
    expect(getWorkItem).not.toHaveBeenCalled();
    expect(setWorkItemState).not.toHaveBeenCalled();
  });

  it('swallows a thrown error and reports false (never fails the spawn finalizer)', async () => {
    const getWorkItem = vi.fn().mockRejectedValue(new Error('PG down'));
    const flipped = await maybeReconcileBeeCompletion(
      { role: 'bee', exitCode: 0, aborted: false, featureId: 'F-1', harnessSlug: 'h', workspaceId: 'ws' },
      { getWorkItem, setWorkItemState: vi.fn(), audit: () => {}, log: () => {} },
    );
    expect(flipped).toBe(false);
  });

  it('flips a clean bee exit through to passed', async () => {
    const getWorkItem = vi.fn().mockResolvedValue(fakeWorkItem('in_progress'));
    const setWorkItemState = vi.fn().mockResolvedValue(fakeWorkItem('passed'));
    const flipped = await maybeReconcileBeeCompletion(
      { role: 'bee', exitCode: 0, aborted: false, featureId: 'F-1', harnessSlug: 'h', workspaceId: 'ws' },
      { getWorkItem, setWorkItemState, audit: () => {}, log: () => {} },
    );
    expect(flipped).toBe(true);
    expect(setWorkItemState).toHaveBeenCalledWith('F-1', 'passed', {
      harness: 'h',
      by: 'hive-bee-exit',
      skipCompletionGate: true,
    });
  });
});
