/**
 * hive-scope resolution tests (learning-packs-2026-06-11 P-004).
 * Pure member→hive resolution over registry entries; no PG.
 */
import { describe, expect, it } from 'vitest';
import { hiveScopeKey, hiveSlugFromScope, hiveSlugsForHarnesses } from './hive-scope';

const entries = [
  { slug: 'my-hive', harness_kind: 'hive' },
  { slug: 'member-a', hive_slug: 'my-hive' },
  { slug: 'member-b', hive_slug: 'my-hive' },
  { slug: 'other-hive', harness_kind: 'hive' },
  { slug: 'standalone' },
  { slug: 'joined-view', harness_kind: 'hive', remote_hive: true },
];

describe('hiveScopeKey / hiveSlugFromScope', () => {
  it('round-trips', () => {
    expect(hiveScopeKey('my-hive')).toBe('hive:my-hive');
    expect(hiveSlugFromScope('hive:my-hive')).toBe('my-hive');
    expect(hiveSlugFromScope('harness:my-hive')).toBeNull();
    expect(hiveSlugFromScope('user-123')).toBeNull();
  });
});

describe('hiveSlugsForHarnesses', () => {
  it('member harness resolves to its hive_slug', () => {
    expect(hiveSlugsForHarnesses(entries, ['member-a'])).toEqual(['my-hive']);
  });

  it('hive home resolves to its own slug (incl. remote joiner views)', () => {
    expect(hiveSlugsForHarnesses(entries, ['my-hive'])).toEqual(['my-hive']);
    expect(hiveSlugsForHarnesses(entries, ['joined-view'])).toEqual(['joined-view']);
  });

  it('standalone + unknown slugs resolve to nothing (D-008: hives only)', () => {
    expect(hiveSlugsForHarnesses(entries, ['standalone'])).toEqual([]);
    expect(hiveSlugsForHarnesses(entries, ['nope'])).toEqual([]);
  });

  it('de-dupes members of the same hive, preserves order across hives', () => {
    expect(hiveSlugsForHarnesses(entries, ['member-a', 'member-b', 'other-hive'])).toEqual([
      'my-hive',
      'other-hive',
    ]);
  });

  it('empty input → empty output', () => {
    expect(hiveSlugsForHarnesses(entries, [])).toEqual([]);
  });
});
