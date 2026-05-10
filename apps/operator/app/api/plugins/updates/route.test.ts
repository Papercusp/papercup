/**
 * Pure-helper tests for /api/plugins/updates. The route's I/O glue
 * (catalog fetch + filesystem scan) is exercised in smoke tests; here
 * we pin the version-comparison + capChange logic that decides whether
 * a row appears as an update and how the consent prompt looks.
 */
import { describe, it, expect } from 'vitest';
import { isNewerVersion, computeCapChange } from './route';

describe('isNewerVersion', () => {
  it('returns false for equal versions', () => {
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
  });

  it('returns true when available is strictly higher', () => {
    expect(isNewerVersion('1.0.1', '1.0.0')).toBe(true);
    expect(isNewerVersion('1.1.0', '1.0.9')).toBe(true);
    expect(isNewerVersion('2.0.0', '1.99.99')).toBe(true);
  });

  it('returns false when available is lower', () => {
    expect(isNewerVersion('0.1.0', '0.1.1')).toBe(false);
    expect(isNewerVersion('1.0.0', '2.0.0')).toBe(false);
  });

  it('strips a leading "v" from both sides', () => {
    expect(isNewerVersion('v1.0.1', '1.0.0')).toBe(true);
    expect(isNewerVersion('1.0.1', 'v1.0.0')).toBe(true);
  });

  it('handles missing patch segments (treats missing as 0)', () => {
    // '1.0' < '1.0.1' because the 3rd component is 0 vs 1
    expect(isNewerVersion('1.0.1', '1.0')).toBe(true);
    expect(isNewerVersion('1.0', '1.0.0')).toBe(false);
  });

  it('falls back to string compare for non-numeric segments', () => {
    expect(isNewerVersion('1.0.0-rc2', '1.0.0-rc1')).toBe(true);
    expect(isNewerVersion('1.0.0-alpha', '1.0.0-beta')).toBe(false);
  });

  it('handles prerelease tail of catalog vs installed', () => {
    // catalog "1.0.0" should beat installed "1.0.0-rc1" if the numeric
    // segments parse equal but the bare form has no extra tail to
    // compare against — '1.0.0' is naively > '1.0.0-rc1' because the
    // shorter array runs out first. Pin this current behavior so we
    // notice on accidental change.
    expect(isNewerVersion('1.0.0', '1.0.0-rc1')).toBe(false);
  });
});

describe('computeCapChange', () => {
  it('partitions caps into added / removed / unchanged', () => {
    const r = computeCapChange(
      ['http:fetch:foo.com', 'tasks:read'],
      ['http:fetch:foo.com', 'http:fetch:bar.com', 'tasks:write'],
    );
    expect(r).toEqual({
      added: ['http:fetch:bar.com', 'tasks:write'],
      removed: ['tasks:read'],
      unchanged: ['http:fetch:foo.com'],
    });
  });

  it('empty from = everything is added', () => {
    const r = computeCapChange([], ['x', 'y']);
    expect(r.added.sort()).toEqual(['x', 'y']);
    expect(r.removed).toEqual([]);
    expect(r.unchanged).toEqual([]);
  });

  it('empty to = everything is removed', () => {
    const r = computeCapChange(['x', 'y'], []);
    expect(r.added).toEqual([]);
    expect(r.removed.sort()).toEqual(['x', 'y']);
    expect(r.unchanged).toEqual([]);
  });

  it('omitted args default to []', () => {
    const r = computeCapChange();
    expect(r).toEqual({ added: [], removed: [], unchanged: [] });
  });

  it('output arrays are sorted', () => {
    const r = computeCapChange(['z'], ['a', 'b', 'c']);
    expect(r.added).toEqual(['a', 'b', 'c']);
    expect(r.removed).toEqual(['z']);
  });
});
