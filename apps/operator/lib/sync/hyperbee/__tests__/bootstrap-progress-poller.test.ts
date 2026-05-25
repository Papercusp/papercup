/**
 * bootstrap-progress-poller tests.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBootstrapProgressPoller } from '../bootstrap-progress-poller';
import {
  _resetTrackerForTests,
  _setNowForTests,
  getBootstrapProgress,
} from '../bootstrap-progress';
import type { AutobaseHarnessHandle } from '../autobase-setup';

afterEach(() => {
  _resetTrackerForTests();
});

function fakeBase(initialLength = 0): {
  base: AutobaseHarnessHandle;
  setLength: (n: number) => void;
} {
  let length = initialLength;
  const view = {
    get length() {
      return length;
    },
  };
  const handle: AutobaseHarnessHandle = {
    base: { view } as unknown as AutobaseHarnessHandle['base'],
    append: vi.fn(),
    close: vi.fn(),
  };
  return {
    base: handle,
    setLength: (n: number) => {
      length = n;
    },
  };
}

describe('startBootstrapProgressPoller', () => {
  it('records the initial view length on creation', () => {
    _setNowForTests(() => 1_000);
    const { base } = fakeBase(7);
    const poller = startBootstrapProgressPoller({
      workspaceId: 'ws-1',
      harnessSlug: 'papercup',
      base,
      setIntervalImpl: ((() => 0) as unknown as typeof setInterval),
      clearIntervalImpl: (() => {}) as unknown as typeof clearInterval,
    });
    expect(getBootstrapProgress('ws-1', 'papercup')!.mergedOps).toBe(7);
    poller.stop();
  });

  it('pollOnce updates when view length grows', () => {
    _setNowForTests(() => 1_000);
    const { base, setLength } = fakeBase(3);
    const poller = startBootstrapProgressPoller({
      workspaceId: 'ws-1',
      harnessSlug: 'papercup',
      base,
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
    const { base } = fakeBase(0);
    const poller = startBootstrapProgressPoller({
      workspaceId: 'ws-1',
      harnessSlug: 'papercup',
      base,
      setIntervalImpl: setI,
      clearIntervalImpl: clearI,
    });
    poller.stop();
    poller.stop();
    expect(cleared).toHaveLength(1);
  });

  it('readViewLength handles missing view shape', () => {
    _setNowForTests(() => 1_000);
    const handle: AutobaseHarnessHandle = {
      base: {} as unknown as AutobaseHarnessHandle['base'],
      append: vi.fn(),
      close: vi.fn(),
    };
    const poller = startBootstrapProgressPoller({
      workspaceId: 'ws-1',
      harnessSlug: 'papercup',
      base: handle,
      setIntervalImpl: ((() => 0) as unknown as typeof setInterval),
      clearIntervalImpl: (() => {}) as unknown as typeof clearInterval,
    });
    // No record should have been written
    expect(getBootstrapProgress('ws-1', 'papercup')).toBeNull();
    poller.stop();
  });

  it('handles a non-number view.length defensively', () => {
    _setNowForTests(() => 1_000);
    const handle: AutobaseHarnessHandle = {
      base: { view: { length: 'oops' } } as unknown as AutobaseHarnessHandle['base'],
      append: vi.fn(),
      close: vi.fn(),
    };
    const poller = startBootstrapProgressPoller({
      workspaceId: 'ws-1',
      harnessSlug: 'papercup',
      base: handle,
      setIntervalImpl: ((() => 0) as unknown as typeof setInterval),
      clearIntervalImpl: (() => {}) as unknown as typeof clearInterval,
    });
    expect(getBootstrapProgress('ws-1', 'papercup')).toBeNull();
    poller.stop();
  });
});
