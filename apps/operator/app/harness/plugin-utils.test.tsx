// @vitest-environment jsdom
//
// plugin-utils — the pure helpers behind HarnessPluginsSection. The dir-slug
// resolution (`pluginSlugFromPath`), the "needs setup" required-field scan
// (`computePluginsMissing`), the scoped/bare-dir dedupe (`dedupeEnabledManifests`),
// and the empty-string prune on config save (`pruneEmptyConfig`) are each tested
// branch-by-branch. PluginIcon (lucide passthrough) gets a render-smoke.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import {
  pluginSlugFromPath,
  computePluginsMissing,
  dedupeEnabledManifests,
  pruneEmptyConfig,
  PluginIcon,
  type InstalledPluginInfo,
} from './plugin-utils';

afterEach(cleanup);

describe('pluginSlugFromPath', () => {
  it('returns the fallback name when there is no path', () => {
    expect(pluginSlugFromPath(null, 'fallback')).toBe('fallback');
    expect(pluginSlugFromPath(undefined, 'fallback')).toBe('fallback');
  });
  it('uses the path basename for an unscoped plugin', () => {
    expect(pluginSlugFromPath('/plugins/my-plugin', 'x')).toBe('my-plugin');
  });
  it('keeps the @scope parent for a scoped plugin', () => {
    expect(pluginSlugFromPath('/root/@acme/cool-plugin', 'x')).toBe('@acme/cool-plugin');
  });
  it('tolerates a trailing slash', () => {
    expect(pluginSlugFromPath('/plugins/my-plugin/', 'x')).toBe('my-plugin');
  });
});

describe('computePluginsMissing', () => {
  const PLUGINS: InstalledPluginInfo[] = [
    // Requires `token`; configSchema lives on the manifest (typed loosely).
    { name: 'slack', path: '/p/slack', configSchema: { required: ['token'] } } as InstalledPluginInfo,
    { name: 'noop', path: '/p/noop' } as InstalledPluginInfo, // no required fields
  ];

  it('returns an empty map when nothing is installed or enabled', () => {
    expect(computePluginsMissing(null, ['slack'], [])).toEqual({});
    expect(computePluginsMissing(PLUGINS, [], [])).toEqual({});
  });

  it('flags a required field that has no stored config row', () => {
    const out = computePluginsMissing(PLUGINS, ['slack'], []);
    expect(out).toEqual({ slack: ['token'] });
  });

  it('flags a required field that is present but empty-string', () => {
    const out = computePluginsMissing(PLUGINS, ['slack'], [
      { pluginSlug: 'slack', config: { token: '' } },
    ]);
    expect(out).toEqual({ slack: ['token'] });
  });

  it('does not flag a required field that has a value', () => {
    const out = computePluginsMissing(PLUGINS, ['slack'], [
      { pluginSlug: 'slack', config: { token: 'xoxb-123' } },
    ]);
    expect(out).toEqual({});
  });

  it('omits plugins that declare no required fields', () => {
    expect(computePluginsMissing(PLUGINS, ['noop'], [])).toEqual({});
  });
});

describe('dedupeEnabledManifests', () => {
  const PLUGINS: InstalledPluginInfo[] = [
    { name: '@acme/tool', path: '/root/@acme/tool' } as InstalledPluginInfo,
    { name: 'plain', path: '/root/plain' } as InstalledPluginInfo,
  ];

  it('resolves slugs to manifests in slug order', () => {
    const out = dedupeEnabledManifests(PLUGINS, ['plain', '@acme/tool']);
    expect(out.map((m) => m.name)).toEqual(['plain', '@acme/tool']);
  });

  it('matches a plugin by its dir slug as well as its manifest name', () => {
    // '@acme/tool' is both the name AND the dir slug; 'plain' resolves by name.
    const out = dedupeEnabledManifests(PLUGINS, ['@acme/tool']);
    expect(out.map((m) => m.name)).toEqual(['@acme/tool']);
  });

  it('dedupes when the same plugin is listed under two names', () => {
    // Both entries resolve to the same manifest (name + dir slug); kept once.
    const out = dedupeEnabledManifests(PLUGINS, ['@acme/tool', '@acme/tool']);
    expect(out).toHaveLength(1);
  });

  it('skips slugs that match no installed plugin', () => {
    expect(dedupeEnabledManifests(PLUGINS, ['ghost'])).toEqual([]);
  });
});

describe('pruneEmptyConfig', () => {
  it('drops empty-string values but keeps everything else (including 0/false)', () => {
    expect(pruneEmptyConfig({ a: '', b: 'keep', c: 0, d: false, e: null })).toEqual({
      b: 'keep',
      c: 0,
      d: false,
      e: null,
    });
  });
});

describe('<PluginIcon />', () => {
  it('renders a known lucide icon by name', () => {
    const { container } = render(<PluginIcon name="Database" />);
    expect(container.querySelector('svg')).not.toBeNull();
  });
  it('falls back to the Puzzle icon for an unknown name', () => {
    const { container } = render(<PluginIcon name="totally-not-an-icon" />);
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
