import { describe, expect, it } from 'vitest';
import { groupByHive, hiveRootOf, type HiveGroupProject } from './harness-hive-groups';

function p(slug: string, parent_slug?: string | null, extra: Partial<HiveGroupProject> = {}): HiveGroupProject {
  return { slug, parent_slug: parent_slug ?? null, ...extra };
}

function bySlug(projects: HiveGroupProject[]): Map<string, HiveGroupProject> {
  return new Map(projects.map((x) => [x.slug, x]));
}

describe('hiveRootOf', () => {
  it('returns the slug itself when it has no parent', () => {
    const ps = [p('root')];
    expect(hiveRootOf('root', bySlug(ps))).toBe('root');
  });

  it('walks parent_slug up to the top-most ancestor', () => {
    const ps = [p('root'), p('child', 'root'), p('grandchild', 'child')];
    expect(hiveRootOf('grandchild', bySlug(ps))).toBe('root');
    expect(hiveRootOf('child', bySlug(ps))).toBe('root');
    expect(hiveRootOf('root', bySlug(ps))).toBe('root');
  });

  it('treats an orphan (parent not in registry) as its own root', () => {
    const ps = [p('orphan', 'missing-parent')];
    expect(hiveRootOf('orphan', bySlug(ps))).toBe('orphan');
  });

  it('returns an unknown slug as itself', () => {
    expect(hiveRootOf('ghost', bySlug([p('root')]))).toBe('ghost');
  });

  it('is cycle-safe (back-edge does not loop forever)', () => {
    // a → b → a (malformed registry)
    const ps = [p('a', 'b'), p('b', 'a')];
    // Whichever it lands on, it must terminate and return one of the cycle nodes.
    expect(['a', 'b']).toContain(hiveRootOf('a', bySlug(ps)));
  });

  it('treats blank/whitespace parent_slug as no parent', () => {
    const ps = [p('root', '   ')];
    expect(hiveRootOf('root', bySlug(ps))).toBe('root');
  });

  it('returns empty string for an empty slug', () => {
    expect(hiveRootOf('', bySlug([]))).toBe('');
  });
});

describe('groupByHive', () => {
  it('returns [] for no projects', () => {
    expect(groupByHive([])).toEqual([]);
  });

  it('a single solo root → one group with just the root', () => {
    const groups = groupByHive([p('solo')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].root.slug).toBe('solo');
    expect(groups[0].members.map((m) => m.slug)).toEqual(['solo']);
  });

  it('root + children → one group, root first then children sorted by slug', () => {
    const groups = groupByHive([p('zeta', 'root'), p('root'), p('alpha', 'root')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].root.slug).toBe('root');
    expect(groups[0].members.map((m) => m.slug)).toEqual(['root', 'alpha', 'zeta']);
  });

  it('a deep tree collapses to its top root (grandchild groups with the hive)', () => {
    const groups = groupByHive([p('root'), p('child', 'root'), p('grandchild', 'child')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].root.slug).toBe('root');
    expect(new Set(groups[0].members.map((m) => m.slug))).toEqual(
      new Set(['root', 'child', 'grandchild']),
    );
    // root is always listed first.
    expect(groups[0].members[0].slug).toBe('root');
  });

  it('multiple hives → one group each, sorted by root slug', () => {
    const groups = groupByHive([
      p('beta'),
      p('alpha'),
      p('alpha-sub', 'alpha'),
      p('beta-sub', 'beta'),
    ]);
    expect(groups.map((g) => g.root.slug)).toEqual(['alpha', 'beta']);
    expect(groups[0].members.map((m) => m.slug)).toEqual(['alpha', 'alpha-sub']);
    expect(groups[1].members.map((m) => m.slug)).toEqual(['beta', 'beta-sub']);
  });

  it('an orphan (parent missing from registry) becomes its own hive group', () => {
    const groups = groupByHive([p('root'), p('orphan', 'gone')]);
    expect(groups.map((g) => g.root.slug)).toEqual(['orphan', 'root']);
    expect(groups.find((g) => g.root.slug === 'orphan')!.members.map((m) => m.slug)).toEqual([
      'orphan',
    ]);
  });

  it('carries through card metadata (hasState / is_shared / harness_kind) on members', () => {
    const groups = groupByHive([
      p('root', null, { is_shared: true, hasState: true }),
      p('sub', 'root', { harness_kind: 'sub-harness', hasState: false }),
    ]);
    const [root, sub] = groups[0].members;
    expect(root).toMatchObject({ slug: 'root', is_shared: true, hasState: true });
    expect(sub).toMatchObject({ slug: 'sub', harness_kind: 'sub-harness', hasState: false });
  });

  it('does not infinite-loop on a malformed cycle (terminates; every node still appears)', () => {
    // a → b → a is a malformed registry. The only guarantees are that it
    // terminates and that no project vanishes; the exact bucketing of a cycle
    // is undefined (each node roots at the other).
    const groups = groupByHive([p('a', 'b'), p('b', 'a')]);
    const allMembers = new Set(groups.flatMap((g) => g.members.map((m) => m.slug)));
    expect(allMembers).toEqual(new Set(['a', 'b']));
  });
});
