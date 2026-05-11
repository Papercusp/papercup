import { describe, it, expect } from 'vitest';
import { readVersionPin } from './version-pin';

describe('readVersionPin', () => {
  it('prefers v2 versionPin when present', () => {
    expect(readVersionPin({ versionPin: { mode: 'exact' } }))
      .toEqual({ mode: 'exact' });
    expect(readVersionPin({ versionPin: { mode: 'semver' } }))
      .toEqual({ mode: 'semver' });
    expect(readVersionPin({ versionPin: { mode: 'hash' } }))
      .toEqual({ mode: 'hash' });
  });

  it('preserves allowOverride when valid', () => {
    expect(readVersionPin({ versionPin: { mode: 'exact', allowOverride: 'security-patch' } }))
      .toEqual({ mode: 'exact', allowOverride: 'security-patch' });
    expect(readVersionPin({ versionPin: { mode: 'exact', allowOverride: 'always' } }))
      .toEqual({ mode: 'exact', allowOverride: 'always' });
    expect(readVersionPin({ versionPin: { mode: 'exact', allowOverride: 'never' } }))
      .toEqual({ mode: 'exact', allowOverride: 'never' });
  });

  it('drops invalid allowOverride values', () => {
    expect(readVersionPin({ versionPin: { mode: 'exact', allowOverride: 'nonsense' } }))
      .toEqual({ mode: 'exact' });
  });

  it('falls back to v1 pluginVersionPinned: true → exact', () => {
    expect(readVersionPin({ pluginVersionPinned: true }))
      .toEqual({ mode: 'exact' });
  });

  it('falls back to v1 pluginVersionPinned: false → semver', () => {
    expect(readVersionPin({ pluginVersionPinned: false }))
      .toEqual({ mode: 'semver' });
  });

  it('prefers v2 over v1 when both are present', () => {
    expect(readVersionPin({ versionPin: { mode: 'hash' }, pluginVersionPinned: true }))
      .toEqual({ mode: 'hash' });
  });

  it('returns undefined for empty / unknown / malformed inputs', () => {
    expect(readVersionPin({})).toBeUndefined();
    expect(readVersionPin({ versionPin: 'string' })).toBeUndefined();
    expect(readVersionPin({ versionPin: { mode: 'bogus' } })).toBeUndefined();
    expect(readVersionPin({ versionPin: null })).toBeUndefined();
    expect(readVersionPin({ versionPin: [] })).toBeUndefined();
    expect(readVersionPin({ pluginVersionPinned: 'yes' })).toBeUndefined();
  });
});
