/**
 * harness-axis-logic.test.ts — pure-logic tests for the Harnesses-tab member
 * axis (harnesses-tab-hive-model-2026-06-07 Phase 1, P-001/P-005).
 *
 * The `?harness=` axis picks which MEMBER harness of the selected hive
 * (`?slug=`) is focused in the dock. These cover the grouping + defaulting
 * precedence (D-001) without mounting HarnessesWorkspace — the logic lives in
 * `@/app/adv/harnesses/harness-axis` so the dock keying, the member rail
 * (P-002), and these tests share one seam.
 */

import { describe, expect, it } from 'vitest';
import {
  hiveMembers,
  resolveFocusedMember,
  isHarnessParamStale,
  type HarnessProjectLite,
  type HiveMember,
} from '@/app/adv/harnesses/harness-axis';

const p = (slug: string, extra: Partial<HarnessProjectLite> = {}): HarnessProjectLite => ({
  slug,
  ...extra,
});

const m = (slug: string, isRoot: boolean, extra: Partial<HiveMember> = {}): HiveMember => ({
  slug,
  harness_kind: null,
  is_shared: false,
  isRoot,
  ...extra,
});

describe('hiveMembers', () => {
  it('returns [] when no hive is selected', () => {
    expect(hiveMembers([p('a'), p('b')], null)).toEqual([]);
    expect(hiveMembers([p('a')], '')).toEqual([]);
  });

  it('returns a single root member for a solo harness (no children)', () => {
    const out = hiveMembers([p('solo'), p('other')], 'solo');
    expect(out).toEqual([m('solo', true)]);
    expect(out).toHaveLength(1);
    expect(out[0].isRoot).toBe(true);
  });

  it('lists the root FIRST, then children sorted by slug', () => {
    const projects = [
      p('zeta', { parent_slug: 'org' }),
      p('org'),
      p('alpha', { parent_slug: 'org' }),
      p('mid', { parent_slug: 'org' }),
      p('unrelated'),
    ];
    const out = hiveMembers(projects, 'org');
    expect(out.map((x) => x.slug)).toEqual(['org', 'alpha', 'mid', 'zeta']);
    expect(out[0].isRoot).toBe(true);
    expect(out.slice(1).every((x) => !x.isRoot)).toBe(true);
  });

  it('omits the root member when the hive root is not a real harness, keeping children', () => {
    // The `?slug=` scope names a hive that has no own dock (root absent from
    // the registry) but does have member harnesses.
    const out = hiveMembers(
      [p('ghost-rd', { parent_slug: 'ghost' }), p('ghost-mkt', { parent_slug: 'ghost' })],
      'ghost',
    );
    expect(out.map((x) => x.slug)).toEqual(['ghost-mkt', 'ghost-rd']);
    expect(out.every((x) => !x.isRoot)).toBe(true);
  });

  it('treats a blank / whitespace parent_slug as no parent (not a child)', () => {
    const out = hiveMembers([p('org'), p('loose', { parent_slug: '   ' }), p('nil', { parent_slug: null })], 'org');
    // Only the root — `loose`/`nil` are not children of `org`.
    expect(out.map((x) => x.slug)).toEqual(['org']);
  });

  it('does not treat a harness as its own child (self-parent guard)', () => {
    const out = hiveMembers([p('org', { parent_slug: 'org' }), p('kid', { parent_slug: 'org' })], 'org');
    expect(out.map((x) => x.slug)).toEqual(['org', 'kid']);
    // `org` appears once (as the root), not duplicated as a child of itself.
    expect(out.filter((x) => x.slug === 'org')).toHaveLength(1);
  });

  it('passes through harness_kind + is_shared, defaulting the absent fields', () => {
    const out = hiveMembers(
      [
        p('org', { harness_kind: 'hive', is_shared: true }),
        p('kid', { parent_slug: 'org' }),
      ],
      'org',
    );
    expect(out[0]).toEqual(m('org', true, { harness_kind: 'hive', is_shared: true }));
    expect(out[1]).toEqual(m('kid', false));
  });
});

describe('resolveFocusedMember', () => {
  const members = [m('org', true), m('org-rd', false), m('org-mkt', false)];

  it('returns null when there are no members', () => {
    expect(resolveFocusedMember({ members: [], urlHarness: null })).toBeNull();
    expect(resolveFocusedMember({ members: [], urlHarness: 'anything' })).toBeNull();
  });

  it('honours an explicit, valid ?harness= (deep link / refresh wins)', () => {
    expect(resolveFocusedMember({ members, urlHarness: 'org-rd' })).toBe('org-rd');
    expect(resolveFocusedMember({ members, urlHarness: 'org-mkt' })).toBe('org-mkt');
  });

  it('defaults to the hive root when ?harness= is unset', () => {
    expect(resolveFocusedMember({ members, urlHarness: null })).toBe('org');
  });

  it('falls back to the first member when there is no real root', () => {
    const rootless = [m('org-rd', false), m('org-mkt', false)];
    expect(resolveFocusedMember({ members: rootless, urlHarness: null })).toBe('org-rd');
  });

  it('ignores a stale ?harness= that names no current member (falls to default)', () => {
    expect(resolveFocusedMember({ members, urlHarness: 'from-a-different-hive' })).toBe('org');
  });
});

describe('isHarnessParamStale', () => {
  const members = [m('org', true), m('org-rd', false)];

  it('is false when ?harness= is unset', () => {
    expect(isHarnessParamStale(members, null)).toBe(false);
  });

  it('is false while members are still loading (empty) — do not clear a deep link early', () => {
    expect(isHarnessParamStale([], 'org-rd')).toBe(false);
  });

  it('is false when ?harness= names a current member', () => {
    expect(isHarnessParamStale(members, 'org')).toBe(false);
    expect(isHarnessParamStale(members, 'org-rd')).toBe(false);
  });

  it('is true when ?harness= names no current member (hive switched)', () => {
    expect(isHarnessParamStale(members, 'stale-from-old-hive')).toBe(true);
  });
});
