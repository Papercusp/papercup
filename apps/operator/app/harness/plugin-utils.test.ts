/**
 * plugin-utils.test.ts — whole-app-test-coverage-breadth.
 *
 * Covers the one genuinely pure exported helper in plugin-utils.tsx:
 * `pluginSlugFromPath`, the path → CLI-enable/disable-key derivation. The
 * React parts (PluginIcon + PLUGIN_ICON_MAP icon components) are rendering glue
 * and are exercised elsewhere; this file pins the slug grammar:
 *   - basename for a plain dir path
 *   - `@scope/basename` when the parent dir is an `@scope`
 *   - trailing-slash tolerance
 *   - the fallbackName path (null/undefined/empty input)
 *
 * Run with:
 *   npx vitest run app/harness/plugin-utils.test.ts
 */
import { describe, expect, it } from 'vitest';
import { pluginSlugFromPath } from './plugin-utils';

describe('pluginSlugFromPath', () => {
  it('returns the basename for a plain (unscoped) dir path', () => {
    expect(pluginSlugFromPath('/home/u/.papercusp/plugins/my-plugin', 'fallback')).toBe(
      'my-plugin',
    );
    expect(pluginSlugFromPath('plugins/solo', 'fallback')).toBe('solo');
  });

  it('keeps the @scope parent when the basename sits under an @scope dir', () => {
    expect(pluginSlugFromPath('/plugins/@papercusp/slack', 'fallback')).toBe(
      '@papercusp/slack',
    );
    expect(pluginSlugFromPath('@acme/widget', 'fallback')).toBe('@acme/widget');
  });

  it('does NOT prepend a non-@ parent', () => {
    // Only an @-prefixed parent is treated as a scope; a normal parent dir is dropped.
    expect(pluginSlugFromPath('/a/b/regular/leaf', 'fallback')).toBe('leaf');
  });

  it('tolerates a single trailing slash on both scoped and unscoped paths', () => {
    expect(pluginSlugFromPath('/plugins/my-plugin/', 'fallback')).toBe('my-plugin');
    expect(pluginSlugFromPath('/plugins/@papercusp/slack/', 'fallback')).toBe(
      '@papercusp/slack',
    );
  });

  it('falls back to fallbackName for null / undefined / empty path', () => {
    expect(pluginSlugFromPath(null, 'fb')).toBe('fb');
    expect(pluginSlugFromPath(undefined, 'fb')).toBe('fb');
    expect(pluginSlugFromPath('', 'fb')).toBe('fb');
  });

  it('handles a bare slug with no slashes (basename === whole string)', () => {
    expect(pluginSlugFromPath('lone', 'fallback')).toBe('lone');
  });

  it('an @scope segment with no leaf below it is not treated as a scope', () => {
    // Path ends at the @scope dir itself — last is the @scope, parent is "plugins".
    expect(pluginSlugFromPath('/plugins/@papercusp', 'fallback')).toBe('@papercusp');
  });
});
