import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetStateChannelForTests,
  _stateChannelStatsForTests,
  closeRun,
  dropStateSnapshotsForWorkspaceSwitch,
  getSnapshot,
  openRun,
  setOpenCards,
  setToolState,
  subscribe,
} from './state-channel';
import type { OpenCardSnapshot } from './types';
import { dispatchWorkspaceSwitch } from './workspace-lifecycle';

const ws = 'workspace-X';

function card(id: string): OpenCardSnapshot {
  return {
    correlationId: id,
    prompt: `prompt-${id}`,
    dataSchemaJson: { type: 'object' },
    createdAt: Date.now(),
  };
}

describe('state-channel', () => {
  beforeEach(() => {
    // Note: do NOT reset workspace-lifecycle subscribers. Modules subscribe
    // lazily at first registry() touch; resetting the global subscriber set
    // would unsubscribe sibling modules (replay-buffer, etc.) that imported
    // earlier in the test run. Test isolation is provided by clearing the
    // state-channel's run map only.
    _resetStateChannelForTests();
  });
  afterEach(() => {
    _resetStateChannelForTests();
  });

  it('openRun creates an empty snapshot at version 0', () => {
    openRun({ workspaceId: ws, runId: 'r1' });
    const s = getSnapshot('r1');
    expect(s).not.toBeNull();
    expect(s!.version).toBe(0);
    expect(s!.snapshot.openCards).toEqual([]);
  });

  it('setOpenCards bumps version monotonically and re-emits snapshot', () => {
    openRun({ workspaceId: ws, runId: 'r1' });
    setOpenCards('r1', [card('a')]);
    setOpenCards('r1', [card('a'), card('b')]);
    setOpenCards('r1', [card('b')]);
    const s = getSnapshot('r1')!;
    expect(s.version).toBe(3);
    expect(s.snapshot.openCards.map((c) => c.correlationId)).toEqual(['b']);
  });

  it('subscribe receives current snapshot immediately, then on every change', () => {
    openRun({ workspaceId: ws, runId: 'r1' });
    setOpenCards('r1', [card('a')]);
    const cb = vi.fn();
    const off = subscribe('r1', cb);

    // Initial emit on subscribe.
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0].snapshot.openCards.length).toBe(1);

    setOpenCards('r1', [card('a'), card('b')]);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[1][0].version).toBe(2);

    off();
    setOpenCards('r1', []);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('subscribe on a non-existent run returns a no-op unsubscribe and never fires', () => {
    const cb = vi.fn();
    const off = subscribe('missing', cb);
    expect(cb).not.toHaveBeenCalled();
    expect(() => off()).not.toThrow();
  });

  it('setToolState merges with openCards (both surfaces share the snapshot)', () => {
    openRun({ workspaceId: ws, runId: 'r1' });
    setOpenCards('r1', [card('a')]);
    setToolState('r1', { results: ['hit-1'], phase: 'querying' });
    const s = getSnapshot('r1')!;
    expect(s.snapshot.openCards.map((c) => c.correlationId)).toEqual(['a']);
    expect(s.snapshot.toolState).toEqual({ results: ['hit-1'], phase: 'querying' });
    expect(s.version).toBe(2);
  });

  it('closeRun marks the run; snapshot remains queryable until GC', () => {
    openRun({ workspaceId: ws, runId: 'r1' });
    setOpenCards('r1', [card('a')]);
    closeRun('r1');
    // Still queryable — retention window is 5min.
    expect(getSnapshot('r1')).not.toBeNull();
  });

  it('dropStateSnapshotsForWorkspaceSwitch isolates by workspaceId', () => {
    openRun({ workspaceId: 'workspace-A', runId: 'rA' });
    openRun({ workspaceId: 'workspace-B', runId: 'rB' });
    dropStateSnapshotsForWorkspaceSwitch('workspace-A');
    expect(getSnapshot('rA')).toBeNull();
    expect(getSnapshot('rB')).not.toBeNull();
  });

  it('subscribes to onWorkspaceSwitch — dispatch drops scoped snapshots (H4)', async () => {
    openRun({ workspaceId: 'workspace-A', runId: 'rA' });
    openRun({ workspaceId: 'workspace-B', runId: 'rB' });
    await dispatchWorkspaceSwitch('workspace-A');
    expect(getSnapshot('rA')).toBeNull();
    expect(getSnapshot('rB')).not.toBeNull();
  });

  it('subscriber throw is isolated; other subscribers still receive emit', () => {
    openRun({ workspaceId: ws, runId: 'r1' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    subscribe('r1', () => {
      throw new Error('boom');
    });
    const good = vi.fn();
    subscribe('r1', good);

    setOpenCards('r1', [card('a')]);
    // good is called twice: initial subscribe + the setOpenCards mutation.
    expect(good).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('stats reflect runs and subscribers', () => {
    openRun({ workspaceId: ws, runId: 'r1' });
    openRun({ workspaceId: ws, runId: 'r2' });
    subscribe('r1', () => {});
    subscribe('r1', () => {});
    subscribe('r2', () => {});
    const stats = _stateChannelStatsForTests();
    expect(stats.runCount).toBe(2);
    expect(stats.subscriberCount).toBe(3);
  });
});
