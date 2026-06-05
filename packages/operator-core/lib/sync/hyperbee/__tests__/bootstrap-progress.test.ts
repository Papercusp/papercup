/**
 * bootstrap-progress tracker tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetTrackerForTests,
  _setNowForTests,
  getBootstrapProgress,
  listBootstrapProgress,
  recordMergedOps,
} from '../bootstrap-progress';

afterEach(() => {
  _resetTrackerForTests();
});

describe('bootstrap-progress tracker', () => {
  it('returns null when no progress recorded', () => {
    expect(getBootstrapProgress('ws-1', 'papercup')).toBeNull();
  });

  it('records initial progress + reads it back', () => {
    let t = 1_000;
    _setNowForTests(() => t);
    recordMergedOps('ws-1', 'papercup', 5);
    const snap = getBootstrapProgress('ws-1', 'papercup');
    expect(snap).not.toBeNull();
    expect(snap!.mergedOps).toBe(5);
    expect(snap!.highestSeen).toBe(5);
    expect(snap!.lastChangeMs).toBe(1_000);
  });

  it('grows on subsequent record + bumps lastChangeMs', () => {
    let t = 1_000;
    _setNowForTests(() => t);
    recordMergedOps('ws-1', 'papercup', 5);
    t = 2_000;
    recordMergedOps('ws-1', 'papercup', 8);
    const snap = getBootstrapProgress('ws-1', 'papercup');
    expect(snap!.mergedOps).toBe(8);
    expect(snap!.lastChangeMs).toBe(2_000);
  });

  it('does NOT bump lastChangeMs when value unchanged', () => {
    let t = 1_000;
    _setNowForTests(() => t);
    recordMergedOps('ws-1', 'papercup', 5);
    t = 2_000;
    recordMergedOps('ws-1', 'papercup', 5);
    expect(getBootstrapProgress('ws-1', 'papercup')!.lastChangeMs).toBe(1_000);
  });

  it('preserves highestSeen on regression (back-fill race)', () => {
    let t = 1_000;
    _setNowForTests(() => t);
    recordMergedOps('ws-1', 'papercup', 10);
    t = 2_000;
    recordMergedOps('ws-1', 'papercup', 7);
    const snap = getBootstrapProgress('ws-1', 'papercup');
    expect(snap!.mergedOps).toBe(7);
    expect(snap!.highestSeen).toBe(10);
  });

  it('caughtUp=false while within idle window', () => {
    let t = 1_000;
    _setNowForTests(() => t);
    recordMergedOps('ws-1', 'papercup', 5);
    t = 10_000;
    expect(
      getBootstrapProgress('ws-1', 'papercup', { idleMs: 30_000 })!.caughtUp,
    ).toBe(false);
  });

  it('caughtUp=true after idleMs elapsed since last change', () => {
    let t = 1_000;
    _setNowForTests(() => t);
    recordMergedOps('ws-1', 'papercup', 5);
    t = 1_000 + 30_000;
    expect(
      getBootstrapProgress('ws-1', 'papercup', { idleMs: 30_000 })!.caughtUp,
    ).toBe(true);
  });

  it('caughtUp uses default idle (30s) when not passed', () => {
    let t = 1_000;
    _setNowForTests(() => t);
    recordMergedOps('ws-1', 'papercup', 5);
    t = 1_000 + 29_999;
    expect(getBootstrapProgress('ws-1', 'papercup')!.caughtUp).toBe(false);
    t = 1_000 + 30_000;
    expect(getBootstrapProgress('ws-1', 'papercup')!.caughtUp).toBe(true);
  });

  it('keys (workspaceId, harnessSlug) independently', () => {
    _setNowForTests(() => 1_000);
    recordMergedOps('ws-1', 'a', 1);
    recordMergedOps('ws-1', 'b', 2);
    recordMergedOps('ws-2', 'a', 3);
    expect(getBootstrapProgress('ws-1', 'a')!.mergedOps).toBe(1);
    expect(getBootstrapProgress('ws-1', 'b')!.mergedOps).toBe(2);
    expect(getBootstrapProgress('ws-2', 'a')!.mergedOps).toBe(3);
    expect(getBootstrapProgress('ws-2', 'b')).toBeNull();
  });

  it('listBootstrapProgress enumerates everything', () => {
    _setNowForTests(() => 1_000);
    recordMergedOps('ws-1', 'a', 1);
    recordMergedOps('ws-1', 'b', 2);
    const list = listBootstrapProgress();
    expect(list).toHaveLength(2);
    const keys = list.map((s) => `${s.workspaceId}::${s.harnessSlug}`).sort();
    expect(keys).toEqual(['ws-1::a', 'ws-1::b']);
  });

  it('listBootstrapProgress empty when no records', () => {
    expect(listBootstrapProgress()).toEqual([]);
  });

  it('listBootstrapProgress threads idleMs through', () => {
    let t = 1_000;
    _setNowForTests(() => t);
    recordMergedOps('ws-1', 'a', 5);
    t = 1_500;
    const list = listBootstrapProgress({ idleMs: 100 });
    expect(list[0]?.caughtUp).toBe(true);
  });
});
