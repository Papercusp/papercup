/**
 * bootstrap-progress-poller tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { startBootstrapProgressPoller } from '../bootstrap-progress-poller';
import {
  _resetTrackerForTests,
  _setNowForTests,
  getBootstrapProgress,
} from '../bootstrap-progress';

afterEach(() => {
  _resetTrackerForTests();
});

function fakeLength(initialLength = 0): {
  readLength: () => number;
  setLength: (n: number) => void;
} {
  let length = initialLength;
  return {
    readLength: () => length,
    setLength: (n: number) => {
      length = n;
    },
  };
}

describe('startBootstrapProgressPoller', () => {
  it('records the initial remote applied frontier on creation', () => {
    _setNowForTests(() => 1_000);
    const { readLength } = fakeLength(7);
    const poller = startBootstrapProgressPoller({
      workspaceId: 'ws-1',
      harnessSlug: 'papercup',
      readProgress: () => ({ headApplied: false, appliedFrontier: readLength(), targetFrontier: 10 }),
      setIntervalImpl: ((() => 0) as unknown as typeof setInterval),
      clearIntervalImpl: (() => {}) as unknown as typeof clearInterval,
    });
    expect(getBootstrapProgress('ws-1', 'papercup')!.mergedOps).toBe(7);
    poller.stop();
  });

  it('pollOnce updates when the length grows', () => {
    _setNowForTests(() => 1_000);
    const { readLength, setLength } = fakeLength(3);
    const poller = startBootstrapProgressPoller({
      workspaceId: 'ws-1',
      harnessSlug: 'papercup',
      readProgress: () => ({ headApplied: true, appliedFrontier: readLength(), targetFrontier: 10 }),
      setIntervalImpl: ((() => 0) as unknown as typeof setInterval),
      clearIntervalImpl: (() => {}) as unknown as typeof clearInterval,
    });
    setLength(9);
    poller.pollOnce();
    expect(getBootstrapProgress('ws-1', 'papercup')!.mergedOps).toBe(9);
    poller.stop();
  });

  it('stop is idempotent', () => {
    const cleared: number[] = [];
    let nextId = 1;
    const setI = ((fn: () => void) => {
      // store the fn so it could be invoked (unused here)
      void fn;
      const id = nextId++;
      return id as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;
    const clearI = ((id: number) => {
      cleared.push(id);
    }) as unknown as typeof clearInterval;
    const { readLength } = fakeLength(0);
    const poller = startBootstrapProgressPoller({
      workspaceId: 'ws-1',
      harnessSlug: 'papercup',
      readProgress: () => ({ headApplied: false, appliedFrontier: readLength(), targetFrontier: 10 }),
      setIntervalImpl: setI,
      clearIntervalImpl: clearI,
    });
    poller.stop();
    poller.stop();
    expect(cleared).toHaveLength(1);
  });

  it('readLength throwing is handled defensively (no record)', () => {
    _setNowForTests(() => 1_000);
    const poller = startBootstrapProgressPoller({
      workspaceId: 'ws-1',
      harnessSlug: 'papercup',
      readProgress: () => {
        throw new Error('store closed');
      },
      setIntervalImpl: ((() => 0) as unknown as typeof setInterval),
      clearIntervalImpl: (() => {}) as unknown as typeof clearInterval,
    });
    // No record should have been written
    expect(getBootstrapProgress('ws-1', 'papercup')).toBeNull();
    poller.stop();
  });

  it('handles a non-number length defensively', () => {
    _setNowForTests(() => 1_000);
    const poller = startBootstrapProgressPoller({
      workspaceId: 'ws-1',
      harnessSlug: 'papercup',
      readProgress: () => ({ headApplied: false, appliedFrontier: NaN, targetFrontier: 10 }),
      setIntervalImpl: ((() => 0) as unknown as typeof setInterval),
      clearIntervalImpl: (() => {}) as unknown as typeof clearInterval,
    });
    expect(getBootstrapProgress('ws-1', 'papercup')).toBeNull();
    poller.stop();
  });
  it('keeps separate handle state for the same workspace/slug and never completes before admission', () => {
    let now = 0;
    let applied = 1;
    const timers = {
      setIntervalImpl: ((() => 0) as unknown as typeof setInterval),
      clearIntervalImpl: (() => {}) as unknown as typeof clearInterval,
    };
    const a = startBootstrapProgressPoller({
      workspaceId: 'ws', harnessSlug: 'same', now: () => now, ...timers,
      readProgress: () => ({ headApplied: true, appliedFrontier: applied, targetFrontier: 10 }),
    });
    const b = startBootstrapProgressPoller({
      workspaceId: 'ws', harnessSlug: 'same', now: () => now, ...timers,
      readProgress: () => ({ headApplied: false, appliedFrontier: 0, targetFrontier: 0 }),
    });
    try {
      now = 31_000;
      b.pollOnce();
      expect(b.snapshot()).toMatchObject({ joinState: 'joining', caughtUp: false });
      for (let n = 2; n <= 10; n += 1) {
        now += 120_001;
        applied = n;
        a.pollOnce();
        expect(a.snapshot()?.joinState).toBe(n === 10 ? 'complete' : 'usable');
      }
      expect(a.snapshot()?.caughtUp).toBe(true);
      expect(b.snapshot()?.caughtUp).toBe(false);
    } finally {
      a.stop();
      b.stop();
    }
  });
});
