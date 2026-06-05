/**
 * boot-history tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetBootHistoryForTests,
  _setCapForTests,
  _setNowForTests,
  bootHistoryDepth,
  listBootHistory,
  recordBootEvent,
} from '../boot-history';

afterEach(() => {
  _resetBootHistoryForTests();
});

describe('boot-history', () => {
  it('starts empty', () => {
    expect(listBootHistory()).toEqual([]);
    expect(bootHistoryDepth()).toBe(0);
  });

  it('records events with current timestamp', () => {
    _setNowForTests(() => 1_000);
    recordBootEvent('ws-1', 'papercup', 'boot_start');
    recordBootEvent('ws-1', 'papercup', 'boot_ok');
    const hist = listBootHistory();
    expect(hist).toHaveLength(2);
    expect(hist[0]?.kind).toBe('boot_ok');
    expect(hist[1]?.kind).toBe('boot_start');
    expect(hist.every((e) => e.ts === 1_000)).toBe(true);
  });

  it('sorts newest first', () => {
    let t = 0;
    _setNowForTests(() => ++t);
    recordBootEvent('ws-1', 'a', 'boot_start');
    recordBootEvent('ws-1', 'a', 'boot_ok');
    recordBootEvent('ws-1', 'a', 'close');
    const hist = listBootHistory();
    expect(hist.map((e) => e.kind)).toEqual([
      'close',
      'boot_ok',
      'boot_start',
    ]);
  });

  it('caps buffer at default 200 (FIFO eviction)', () => {
    for (let i = 0; i < 250; i += 1) {
      recordBootEvent('ws-1', `h${i}`, 'boot_start');
    }
    expect(bootHistoryDepth()).toBe(200);
    const hist = listBootHistory({ limit: 200 });
    // Oldest 50 evicted; first remaining should be h50
    expect(hist[hist.length - 1]?.harnessSlug).toBe('h50');
    expect(hist[0]?.harnessSlug).toBe('h249');
  });

  it('respects custom cap', () => {
    _setCapForTests(5);
    for (let i = 0; i < 10; i += 1) {
      recordBootEvent('ws-1', `h${i}`, 'boot_start');
    }
    expect(bootHistoryDepth()).toBe(5);
  });

  it('filters by workspaceId', () => {
    recordBootEvent('ws-1', 'a', 'boot_start');
    recordBootEvent('ws-2', 'a', 'boot_start');
    recordBootEvent('ws-1', 'b', 'boot_start');
    const hist = listBootHistory({ workspaceId: 'ws-1' });
    expect(hist).toHaveLength(2);
    expect(hist.every((e) => e.workspaceId === 'ws-1')).toBe(true);
  });

  it('filters by harnessSlug', () => {
    recordBootEvent('ws-1', 'a', 'boot_start');
    recordBootEvent('ws-1', 'b', 'boot_start');
    recordBootEvent('ws-1', 'a', 'boot_ok');
    const hist = listBootHistory({ harnessSlug: 'a' });
    expect(hist).toHaveLength(2);
    expect(hist.every((e) => e.harnessSlug === 'a')).toBe(true);
  });

  it('filters by kinds', () => {
    recordBootEvent('ws-1', 'a', 'boot_start');
    recordBootEvent('ws-1', 'a', 'boot_ok');
    recordBootEvent('ws-1', 'a', 'boot_fail', 'corestore lock');
    recordBootEvent('ws-1', 'a', 'close');
    const hist = listBootHistory({ kinds: ['boot_fail', 'close'] });
    expect(hist).toHaveLength(2);
    expect(hist.map((e) => e.kind).sort()).toEqual(['boot_fail', 'close']);
  });

  it('limit caps output', () => {
    for (let i = 0; i < 20; i += 1) {
      recordBootEvent('ws-1', `h${i}`, 'boot_start');
    }
    expect(listBootHistory({ limit: 5 })).toHaveLength(5);
  });

  it('returns fresh array each call', () => {
    recordBootEvent('ws-1', 'a', 'boot_start');
    const a = listBootHistory();
    const b = listBootHistory();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('stores optional message', () => {
    recordBootEvent('ws-1', 'a', 'boot_fail', 'corestore lock contention');
    const hist = listBootHistory();
    expect(hist[0]?.message).toBe('corestore lock contention');
  });
});
