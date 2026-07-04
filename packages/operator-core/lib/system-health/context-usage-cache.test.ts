import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTEXT_USAGE_STALE_MS,
  getContextUsage,
  isContextGaugeEnabled,
  recordContextUsage,
  resetContextUsageCacheForTests,
  setContextGaugeEnabled,
} from './context-usage-cache';

afterEach(() => resetContextUsageCacheForTests());

describe('context-usage-cache', () => {
  it('records then reads back an owner usage', () => {
    recordContextUsage('su-a', 90_000, 300_000, 1_000);
    expect(getContextUsage('su-a', 1_000)).toEqual({ tokens: 90_000, limit: 300_000 });
  });

  it('returns null for an unknown owner', () => {
    expect(getContextUsage('su-nobody')).toBeNull();
  });

  it('evicts an entry older than the stale TTL', () => {
    recordContextUsage('su-a', 90_000, 300_000, 1_000);
    // just inside the TTL
    expect(getContextUsage('su-a', 1_000 + CONTEXT_USAGE_STALE_MS)).not.toBeNull();
    // just past it
    expect(getContextUsage('su-a', 1_000 + CONTEXT_USAGE_STALE_MS + 1)).toBeNull();
  });

  it('ignores a non-finite or non-positive-limit write', () => {
    recordContextUsage('su-a', Number.NaN, 300_000, 1_000);
    expect(getContextUsage('su-a', 1_000)).toBeNull();
    recordContextUsage('su-b', 90_000, 0, 1_000);
    expect(getContextUsage('su-b', 1_000)).toBeNull();
  });

  it('ignores an empty owner id', () => {
    recordContextUsage('', 90_000, 300_000, 1_000);
    expect(getContextUsage('', 1_000)).toBeNull();
  });

  it('last write wins for the same owner', () => {
    recordContextUsage('su-a', 90_000, 300_000, 1_000);
    recordContextUsage('su-a', 250_000, 300_000, 2_000);
    expect(getContextUsage('su-a', 2_000)).toEqual({ tokens: 250_000, limit: 300_000 });
  });

  describe('gauge-enabled mirror', () => {
    it('defaults to enabled', () => {
      expect(isContextGaugeEnabled()).toBe(true);
    });
    it('reflects setContextGaugeEnabled', () => {
      setContextGaugeEnabled(false);
      expect(isContextGaugeEnabled()).toBe(false);
      setContextGaugeEnabled(true);
      expect(isContextGaugeEnabled()).toBe(true);
    });
    it('reset restores enabled', () => {
      setContextGaugeEnabled(false);
      resetContextUsageCacheForTests();
      expect(isContextGaugeEnabled()).toBe(true);
    });
  });
});
