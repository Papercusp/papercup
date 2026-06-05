/**
 * Coverage for `resolveHarnessScope` + `harnessHasSubs`.
 * Per `plans-newbutton-and-subharness-scope-2026-05-25` P-013.
 */
import { describe, expect, it } from 'vitest';
import { harnessHasSubs, resolveHarnessScope } from '../scope';

describe('resolveHarnessScope', () => {
  it('returns just [slug] when no children exist', () => {
    const projects = [{ slug: 'papercup', parent_slug: null }];
    expect(resolveHarnessScope('papercup', projects)).toEqual(['papercup']);
  });

  it('includes direct children', () => {
    const projects = [
      { slug: 'papercup', parent_slug: null },
      { slug: 'papercup/libs/sync', parent_slug: 'papercup' },
      { slug: 'papercup/libs/ui', parent_slug: 'papercup' },
      { slug: 'sheets', parent_slug: null },
    ];
    const out = resolveHarnessScope('papercup', projects);
    expect(out).toContain('papercup');
    expect(out).toContain('papercup/libs/sync');
    expect(out).toContain('papercup/libs/ui');
    expect(out).not.toContain('sheets');
    expect(out).toHaveLength(3);
  });

  it('includes transitive descendants up to maxDepth', () => {
    const projects = [
      { slug: 'root', parent_slug: null },
      { slug: 'root/a', parent_slug: 'root' },
      { slug: 'root/a/b', parent_slug: 'root/a' },
      { slug: 'root/a/b/c', parent_slug: 'root/a/b' },
    ];
    const out = resolveHarnessScope('root', projects);
    expect(out).toEqual(['root', 'root/a', 'root/a/b', 'root/a/b/c']);
  });

  it('respects maxDepth cap', () => {
    const projects = [
      { slug: 'root', parent_slug: null },
      { slug: 'root/a', parent_slug: 'root' },
      { slug: 'root/a/b', parent_slug: 'root/a' },
      { slug: 'root/a/b/c', parent_slug: 'root/a/b' },
    ];
    const out = resolveHarnessScope('root', projects, { maxDepth: 2 });
    expect(out).toEqual(['root', 'root/a', 'root/a/b']);
  });

  it('returns just [slug] when picking a child as the root', () => {
    const projects = [
      { slug: 'papercup', parent_slug: null },
      { slug: 'papercup/libs/sync', parent_slug: 'papercup' },
    ];
    expect(resolveHarnessScope('papercup/libs/sync', projects)).toEqual([
      'papercup/libs/sync',
    ]);
  });

  it('survives a cycle without infinite-looping', () => {
    // Malformed registry: a→b→a
    const projects = [
      { slug: 'a', parent_slug: 'b' },
      { slug: 'b', parent_slug: 'a' },
    ];
    const out = resolveHarnessScope('a', projects);
    expect(out.length).toBeLessThan(10);
    expect(out[0]).toBe('a');
    expect(out).toContain('b');
  });

  it('returns empty array for empty slug', () => {
    expect(resolveHarnessScope('', [{ slug: 'a', parent_slug: null }])).toEqual([]);
  });

  it('ignores empty-string parent_slug as if absent', () => {
    const projects = [
      { slug: 'a', parent_slug: '' },
      { slug: 'b', parent_slug: '  ' },
    ];
    expect(resolveHarnessScope('a', projects)).toEqual(['a']);
  });
});

describe('harnessHasSubs', () => {
  it('returns true when any project lists slug as its parent', () => {
    const projects = [
      { slug: 'papercup', parent_slug: null },
      { slug: 'papercup/sync', parent_slug: 'papercup' },
    ];
    expect(harnessHasSubs('papercup', projects)).toBe(true);
  });

  it('returns false when no children exist', () => {
    const projects = [
      { slug: 'papercup', parent_slug: null },
      { slug: 'sheets', parent_slug: null },
    ];
    expect(harnessHasSubs('papercup', projects)).toBe(false);
  });

  it('returns false for empty slug', () => {
    expect(harnessHasSubs('', [{ slug: 'a', parent_slug: null }])).toBe(false);
  });
});
