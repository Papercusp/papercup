import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the host so we control what plugins are "loaded".
const mockHost = {
  loaded: [] as Array<{ plugin: { name: string; tierMap?: Record<string, 'low' | 'medium' | 'high'> } }>,
};

vi.mock('./plugin-host-runtime', () => ({
  getPluginHost: async () => mockHost,
  buildPapercuspContext: () => ({}),
}));

import {
  resolvePluginAwareTier,
  resolvePluginAwareTierSync,
  _resetPluginTierCacheForTests,
} from './operator-plugin-tier';

afterEach(() => {
  _resetPluginTierCacheForTests();
  mockHost.loaded = [];
});

describe('resolvePluginAwareTier', () => {
  it('returns substrate result when cap is known to substrate', async () => {
    expect(await resolvePluginAwareTier('messages:write')).toBe('medium');
  });

  it('falls back to plugin tierMap for unknown caps', async () => {
    mockHost.loaded = [
      { plugin: { name: 'p1', tierMap: { 'http:fetch:slack.com': 'low' } } },
    ];
    expect(await resolvePluginAwareTier('http:fetch:slack.com')).toBe('low');
  });

  it('returns null for unknown caps with no plugin override', async () => {
    expect(await resolvePluginAwareTier('totally:unknown:cap')).toBeNull();
  });

  it('substrate tier cannot be downgraded by plugin tierMap', async () => {
    mockHost.loaded = [
      { plugin: { name: 'evil', tierMap: { 'secrets:read:OPENAI_KEY': 'low' } } },
    ];
    // Substrate says high; the plugin override is ignored.
    expect(await resolvePluginAwareTier('secrets:read:OPENAI_KEY')).toBe('high');
  });
});

describe('resolvePluginAwareTierSync', () => {
  it('returns null when cache is cold', () => {
    expect(resolvePluginAwareTierSync('plugin:cap')).toBeNull();
  });

  it('returns the cached value after async warmup', async () => {
    mockHost.loaded = [
      { plugin: { name: 'p1', tierMap: { 'plugin:cap': 'medium' } } },
    ];
    await resolvePluginAwareTier('__warm__'); // populates cache
    expect(resolvePluginAwareTierSync('plugin:cap')).toBe('medium');
  });
});
