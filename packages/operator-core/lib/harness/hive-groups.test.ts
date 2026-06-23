/**
 * hive-groups — the server-side Hive grouping (harnesses-tab-hive-model P-021).
 * Pins the membership precedence (formal hive_slug > legacy parent_slug), the
 * Hive-home-is-its-own-root rule, and the cycle/orphan guards.
 */
import { describe, test, expect } from 'vitest';
import { groupByHive, hiveRootOf, isRepoLessHiveHome, type HiveGroupProject } from './hive-groups';

function bySlug(projects: HiveGroupProject[]): Map<string, HiveGroupProject> {
  const m = new Map<string, HiveGroupProject>();
  for (const p of projects) m.set(p.slug, p);
  return m;
}

describe('isRepoLessHiveHome — selector visibility discriminator', () => {
  test('a repo-less hive home (separate member holds the repo) is hidden', () => {
    expect(isRepoLessHiveHome({ harness_kind: 'hive' })).toBe(true);
    expect(isRepoLessHiveHome({ harness_kind: 'hive', self_repo: false })).toBe(true);
    expect(isRepoLessHiveHome({ harness_kind: 'hive', self_repo: null })).toBe(true);
  });
  test('a self-hive (its own repo checkout, e.g. papercusp) stays selectable', () => {
    expect(isRepoLessHiveHome({ harness_kind: 'hive', self_repo: true })).toBe(false);
  });
  test('member / standalone harnesses stay selectable', () => {
    expect(isRepoLessHiveHome({ harness_kind: null })).toBe(false);
    expect(isRepoLessHiveHome({ harness_kind: undefined })).toBe(false);
    expect(isRepoLessHiveHome({ harness_kind: 'coding' })).toBe(false);
  });
});

describe('groupByHive — after hiding repo-less homes (selector behaviour)', () => {
  test('a member re-roots to itself when its repo-less home is filtered; self-hive stays', () => {
    const all: HiveGroupProject[] = [
      { slug: 'oddsmith-hive', harness_kind: 'hive' },
      { slug: 'oddsmith', hive_slug: 'oddsmith-hive' },
      { slug: 'papercusp', harness_kind: 'hive', self_repo: true },
      { slug: 'standalone' },
    ];
    const selectable = all.filter((p) => !isRepoLessHiveHome(p));
    expect(selectable.map((p) => p.slug).sort()).toEqual(['oddsmith', 'papercusp', 'standalone']);
    // The repo-less home is gone; its member stands alone as its own root; the
    // self-hive (papercusp) and the standalone harness remain selectable roots.
    const roots = groupByHive(selectable).map((g) => g.root.slug).sort();
    expect(roots).toEqual(['oddsmith', 'papercusp', 'standalone']);
  });
});

describe('hiveRootOf — membership precedence', () => {
  test('formal hive_slug beats legacy parent_slug', () => {
    // A member that carries BOTH edges groups by the FORMAL hive home, not the
    // legacy parent — the Phase-3 source wins (D-008).
    const projects: HiveGroupProject[] = [
      { slug: 'home', harness_kind: 'hive' },
      { slug: 'legacy-root' },
      { slug: 'member', hive_slug: 'home', parent_slug: 'legacy-root' },
    ];
    expect(hiveRootOf('member', bySlug(projects))).toBe('home');
  });

  test('falls back to parent_slug when no hive_slug (legacy tree)', () => {
    const projects: HiveGroupProject[] = [
      { slug: 'root' },
      { slug: 'child', parent_slug: 'root' },
      { slug: 'grandchild', parent_slug: 'child' },
    ];
    expect(hiveRootOf('grandchild', bySlug(projects))).toBe('root');
  });

  test('a harness_kind:hive home is its own root even with a stray edge', () => {
    const projects: HiveGroupProject[] = [
      { slug: 'home', harness_kind: 'hive', hive_slug: 'other', parent_slug: 'other' },
      { slug: 'other', harness_kind: 'hive' },
    ];
    expect(hiveRootOf('home', bySlug(projects))).toBe('home');
  });

  test('orphan edge (target not in registry) resolves to self', () => {
    const projects: HiveGroupProject[] = [{ slug: 'lonely', hive_slug: 'ghost' }];
    expect(hiveRootOf('lonely', bySlug(projects))).toBe('lonely');
  });

  test('cycle guard — a back-edge loop resolves without spinning', () => {
    // a→b→a: walking from 'a' reaches 'b', whose parent 'a' is already seen, so
    // it terminates at 'b'. The contract is "terminates", not which node wins.
    const projects: HiveGroupProject[] = [
      { slug: 'a', parent_slug: 'b' },
      { slug: 'b', parent_slug: 'a' },
    ];
    expect(hiveRootOf('a', bySlug(projects))).toBe('b');
  });

  test('unknown slug returns itself; empty returns empty', () => {
    expect(hiveRootOf('nope', bySlug([]))).toBe('nope');
    expect(hiveRootOf('', bySlug([]))).toBe('');
  });
});

describe('groupByHive', () => {
  test('groups members under their formal Hive home, root-first', () => {
    const projects: HiveGroupProject[] = [
      { slug: 'zeta', hive_slug: 'acme' },
      { slug: 'acme', harness_kind: 'hive' },
      { slug: 'alpha', hive_slug: 'acme' },
    ];
    const groups = groupByHive(projects);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.root.slug).toBe('acme');
    expect(groups[0]!.members.map((m) => m.slug)).toEqual(['acme', 'alpha', 'zeta']);
  });

  test('mixes formal hives and legacy parent_slug trees into distinct groups', () => {
    const projects: HiveGroupProject[] = [
      { slug: 'acme', harness_kind: 'hive' },
      { slug: 'acme-web', hive_slug: 'acme' },
      { slug: 'legacy', parent_slug: undefined },
      { slug: 'legacy-sub', parent_slug: 'legacy' },
      { slug: 'solo' },
    ];
    const groups = groupByHive(projects);
    const roots = groups.map((g) => g.root.slug);
    expect(roots).toEqual(['acme', 'legacy', 'solo']); // sorted by root slug
    expect(groups.find((g) => g.root.slug === 'acme')!.members.map((m) => m.slug)).toEqual(['acme', 'acme-web']);
    expect(groups.find((g) => g.root.slug === 'legacy')!.members.map((m) => m.slug)).toEqual(['legacy', 'legacy-sub']);
    expect(groups.find((g) => g.root.slug === 'solo')!.members.map((m) => m.slug)).toEqual(['solo']);
  });

  test('carries extra fields through on root + members (generic)', () => {
    const projects = [
      { slug: 'acme', harness_kind: 'hive', is_shared: true, hasState: true },
      { slug: 'acme-web', hive_slug: 'acme', is_shared: false, hasState: false },
    ];
    const groups = groupByHive(projects);
    expect(groups[0]!.root.is_shared).toBe(true);
    expect(groups[0]!.members[1]!.hasState).toBe(false);
  });

  test('empty input → empty grouping', () => {
    expect(groupByHive([])).toEqual([]);
  });
});
