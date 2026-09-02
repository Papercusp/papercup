/**
 * hive-scope resolution tests (learning-packs-2026-06-11 P-004).
 * Pure member→hive resolution over registry entries; no PG.
 */
import { describe, expect, it } from 'vitest';
import {
  hiveScopeKey,
  potSlugFromScope,
  potSlugsForHarnesses,
  narrowHarnessSlugsToSessionHive,
} from './hive-scope';

const entries = [
  { slug: 'my-hive', harness_kind: 'hive' },
  { slug: 'member-a', hive_slug: 'my-hive' },
  { slug: 'member-b', hive_slug: 'my-hive' },
  { slug: 'other-hive', harness_kind: 'hive' },
  { slug: 'standalone' },
  { slug: 'joined-view', harness_kind: 'hive', remote_hive: true },
];

describe('hiveScopeKey / potSlugFromScope', () => {
  it('round-trips', () => {
    expect(hiveScopeKey('my-hive')).toBe('hive:my-hive');
    expect(potSlugFromScope('hive:my-hive')).toBe('my-hive');
    expect(potSlugFromScope('harness:my-hive')).toBeNull();
    expect(potSlugFromScope('user-123')).toBeNull();
  });
});

describe('potSlugsForHarnesses', () => {
  it('member harness resolves to its hive_slug', () => {
    expect(potSlugsForHarnesses(entries, ['member-a'])).toEqual(['my-hive']);
  });

  it('hive home resolves to its own slug (incl. remote joiner views)', () => {
    expect(potSlugsForHarnesses(entries, ['my-hive'])).toEqual(['my-hive']);
    expect(potSlugsForHarnesses(entries, ['joined-view'])).toEqual(['joined-view']);
  });

  it('standalone + unknown slugs resolve to nothing (D-008: hives only)', () => {
    expect(potSlugsForHarnesses(entries, ['standalone'])).toEqual([]);
    expect(potSlugsForHarnesses(entries, ['nope'])).toEqual([]);
  });

  it('de-dupes members of the same hive, preserves order across hives', () => {
    expect(potSlugsForHarnesses(entries, ['member-a', 'member-b', 'other-hive'])).toEqual([
      'my-hive',
      'other-hive',
    ]);
  });

  it('empty input → empty output', () => {
    expect(potSlugsForHarnesses(entries, [])).toEqual([]);
  });
});

describe('narrowHarnessSlugsToSessionHive (P-018 — confine default fan-out to the session hive)', () => {
  const allSlugs = ['my-hive', 'member-a', 'member-b', 'other-hive', 'standalone', 'joined-view'];

  it('a hive-confined session (member harness) keeps only its own hive subtree', () => {
    expect(narrowHarnessSlugsToSessionHive(entries, allSlugs, 'member-a')).toEqual([
      'my-hive',
      'member-a',
      'member-b',
    ]);
  });

  it('a session pinned to the hive HOME narrows the same as a member', () => {
    expect(narrowHarnessSlugsToSessionHive(entries, allSlugs, 'my-hive')).toEqual([
      'my-hive',
      'member-a',
      'member-b',
    ]);
  });

  it("a workspace/unscoped session ('*'/empty/null) is NOT narrowed (Queen spans its hives)", () => {
    expect(narrowHarnessSlugsToSessionHive(entries, allSlugs, '*')).toEqual(allSlugs);
    expect(narrowHarnessSlugsToSessionHive(entries, allSlugs, '')).toEqual(allSlugs);
    expect(narrowHarnessSlugsToSessionHive(entries, allSlugs, undefined)).toEqual(allSlugs);
    expect(narrowHarnessSlugsToSessionHive(entries, allSlugs, null)).toEqual(allSlugs);
  });

  it('a session on a standalone (no-hive) harness is NOT narrowed (no hive to confine to)', () => {
    expect(narrowHarnessSlugsToSessionHive(entries, allSlugs, 'standalone')).toEqual(allSlugs);
  });

  it('drops a sibling hive entirely from a confined fan-out', () => {
    expect(narrowHarnessSlugsToSessionHive(entries, allSlugs, 'other-hive')).toEqual(['other-hive']);
  });

  it('an unknown candidate slug is dropped from a confined fan-out', () => {
    expect(narrowHarnessSlugsToSessionHive(entries, ['member-a', 'ghost'], 'member-a')).toEqual([
      'member-a',
    ]);
  });

  it('returns a fresh array (no aliasing of the input) on the pass-through path', () => {
    const out = narrowHarnessSlugsToSessionHive(entries, allSlugs, '*');
    expect(out).not.toBe(allSlugs);
    expect(out).toEqual(allSlugs);
  });
});
