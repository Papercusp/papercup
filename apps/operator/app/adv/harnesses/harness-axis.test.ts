// @vitest-environment node
/**
 * harness-axis.ts — the pure member-axis seam behind the Harnesses tab's
 * `?harness=` param (harnesses-tab-hive-model-2026-06-07 P-001/P-005; the
 * module header names this unit suite as part of the seam contract). Pins:
 *   - hiveMembers: root-first ordering, root-only-when-registered, direct
 *     children by parent_slug sorted by slug, blank-parent normalization,
 *     dedup, solo-harness single-member list, null-hive → [].
 *   - resolveFocusedMember precedence (D-001): valid ?harness= wins → root →
 *     first member → null.
 *   - isHarnessParamStale: set-but-not-a-member, with the empty-members and
 *     unset-param guards.
 */
import { describe, expect, it } from 'vitest';
import {
  hiveMembers,
  isHarnessParamStale,
  resolveFocusedMember,
  type HarnessProjectLite,
  type HiveMember,
} from './harness-axis';

const p = (slug: string, over: Partial<HarnessProjectLite> = {}): HarnessProjectLite => ({
  slug,
  ...over,
});

const member = (slug: string, isRoot = false, over: Partial<HiveMember> = {}): HiveMember => ({
  slug,
  harness_kind: null,
  is_shared: false,
  isRoot,
  ...over,
});

describe('hiveMembers', () => {
  it('lists the registered root first, then children sorted by slug', () => {
    const projects = [
      p('hive', { harness_kind: 'coding', is_shared: true }),
      p('zeta', { parent_slug: 'hive' }),
      p('alpha', { parent_slug: 'hive', harness_kind: 'research' }),
      p('unrelated', { parent_slug: 'other-hive' }),
    ];
    expect(hiveMembers(projects, 'hive')).toEqual([
      member('hive', true, { harness_kind: 'coding', is_shared: true }),
      member('alpha', false, { harness_kind: 'research' }),
      member('zeta'),
    ]);
  });

  it('omits an unregistered root but still lists its children', () => {
    const projects = [p('child-b', { parent_slug: 'ghost' }), p('child-a', { parent_slug: 'ghost' })];
    expect(hiveMembers(projects, 'ghost')).toEqual([member('child-a'), member('child-b')]);
  });

  it('a solo harness yields the single-member [root] list (collapsed-rail contract)', () => {
    expect(hiveMembers([p('solo')], 'solo')).toEqual([member('solo', true)]);
  });

  it('returns [] when no hive is selected', () => {
    expect(hiveMembers([p('a')], null)).toEqual([]);
  });

  it('normalizes blank/whitespace parent_slug to no-parent', () => {
    const projects = [p('hive'), p('blank', { parent_slug: '   ' }), p('empty', { parent_slug: '' })];
    expect(hiveMembers(projects, 'hive').map((m) => m.slug)).toEqual(['hive']);
  });

  it('a self-parented root appears once, as the root', () => {
    // Defensive: parent_slug === own slug must not duplicate the entry.
    const projects = [p('hive', { parent_slug: 'hive' }), p('kid', { parent_slug: 'hive' })];
    expect(hiveMembers(projects, 'hive')).toEqual([
      member('hive', true),
      member('kid'),
    ]);
  });
});

describe('resolveFocusedMember (D-001 precedence)', () => {
  const members = [member('hive', true), member('alpha'), member('zeta')];

  it('a valid ?harness= deep link wins', () => {
    expect(resolveFocusedMember({ members, urlHarness: 'zeta' })).toBe('zeta');
  });

  it('an invalid ?harness= falls back to the root', () => {
    expect(resolveFocusedMember({ members, urlHarness: 'not-a-member' })).toBe('hive');
  });

  it('no ?harness= → root', () => {
    expect(resolveFocusedMember({ members, urlHarness: null })).toBe('hive');
  });

  it('rootless member list → first member', () => {
    expect(resolveFocusedMember({ members: [member('beta'), member('gamma')], urlHarness: null })).toBe('beta');
  });

  it('empty members → null', () => {
    expect(resolveFocusedMember({ members: [], urlHarness: 'anything' })).toBeNull();
  });
});

describe('isHarnessParamStale', () => {
  const members = [member('hive', true), member('alpha')];

  it('true when ?harness= names a non-member (hive switched under it)', () => {
    expect(isHarnessParamStale(members, 'old-hive-member')).toBe(true);
  });

  it('false when ?harness= names a current member', () => {
    expect(isHarnessParamStale(members, 'alpha')).toBe(false);
  });

  it('false when ?harness= is unset', () => {
    expect(isHarnessParamStale(members, null)).toBe(false);
  });

  it('false while members have not loaded yet (deep-link protection)', () => {
    expect(isHarnessParamStale([], 'alpha')).toBe(false);
  });
});
