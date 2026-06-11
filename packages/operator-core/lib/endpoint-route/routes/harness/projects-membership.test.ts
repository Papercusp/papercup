/**
 * resolveProjectHiveMembership — the "add into hive" membership-edge decision
 * (harnesses-tab-hive-model P-011). Pins the formal-vs-legacy precedence + the
 * standalone/unknown-scope cases.
 */
import { describe, test, expect, vi } from 'vitest';
import {
  resolveProjectHiveMembership,
  resolveSubHarnessHiveSlug,
  enrichProjects,
} from './projects';
import { groupByHive } from '../../../harness/hive-groups';
import type { ProjectEntry } from '../../../harness-registry';

const PROJECTS = [
  { slug: 'acme', harness_kind: 'hive' }, // a FORMAL Hive home
  { slug: 'legacy-root' }, // a plain root harness (no kind)
  { slug: 'acme-web', harness_kind: 'coding' },
];

describe('resolveProjectHiveMembership', () => {
  test('empty scope → no membership (standalone harness)', () => {
    const r = resolveProjectHiveMembership(PROJECTS, '');
    expect(r).toEqual({ ok: true, membership: null });
  });

  test('a formal kind:hive home → hive_slug membership', () => {
    const r = resolveProjectHiveMembership(PROJECTS, 'acme');
    expect(r).toEqual({ ok: true, membership: { kind: 'hive_slug', value: 'acme' } });
  });

  test('a non-hive root scope → legacy parent_slug membership', () => {
    const r = resolveProjectHiveMembership(PROJECTS, 'legacy-root');
    expect(r).toEqual({ ok: true, membership: { kind: 'parent_slug', value: 'legacy-root' } });
  });

  test('unknown scope → hive_not_found error', () => {
    const r = resolveProjectHiveMembership(PROJECTS, 'ghost');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('hive_not_found');
  });

  test('whitespace scope is trimmed → standalone', () => {
    expect(resolveProjectHiveMembership(PROJECTS, '   ')).toEqual({ ok: true, membership: null });
  });
});

/**
 * enrichProjects cold-path cost model (EI-64). The route went pathologically
 * slow (76s/HTTP 408 on :3070) because the per-project enrichment opened a
 * PER-SLUG PG pool per project to probe pipeline state — N pool opens that blew
 * the 30s route budget on a cold cache. The fix probes hasState in ONE batched
 * query. These tests pin that contract: the probe fires EXACTLY ONCE with all
 * slugs, never once per project, so a regression back to per-slug probing fails.
 */
describe('enrichProjects — batched hasState probe (EI-64)', () => {
  // /nonexistent paths → existsSync false, no config.json read; keeps the test
  // pure (no fs fixtures) while exercising the per-project enrichment loop.
  const PROJECTS: ProjectEntry[] = [
    { slug: 'alpha', path: '/nonexistent/alpha' },
    { slug: 'beta', path: '/nonexistent/beta' },
    { slug: 'gamma', path: '/nonexistent/gamma' },
  ];

  test('probes hasState exactly once with ALL slugs (not per-project)', async () => {
    const fetchHasState = vi.fn(async (_slugs: readonly string[]) => new Set<string>(['beta']));
    const out = await enrichProjects(PROJECTS, fetchHasState);

    // The crux: ONE probe, not one-per-project. A revert to per-slug pools fails here.
    expect(fetchHasState).toHaveBeenCalledTimes(1);
    expect(fetchHasState).toHaveBeenCalledWith(['alpha', 'beta', 'gamma']);

    expect(out.map((p) => p.slug)).toEqual(['alpha', 'beta', 'gamma']);
    expect(out.find((p) => p.slug === 'beta')?.hasState).toBe(true);
    expect(out.find((p) => p.slug === 'alpha')?.hasState).toBe(false);
    // Nonexistent paths → no spec, null parent.
    expect(out.every((p) => p.hasSpec === false)).toBe(true);
    expect(out.every((p) => p.parent_slug === null)).toBe(true);
  });

  test('degrades to hasState=false for all when the probe throws', async () => {
    const fetchHasState = vi.fn(async () => { throw new Error('pg down'); });
    const out = await enrichProjects(PROJECTS, fetchHasState);
    expect(fetchHasState).toHaveBeenCalledTimes(1);
    expect(out.every((p) => p.hasState === false)).toBe(true);
  });

  test('empty registry → no probe overhead, empty result', async () => {
    const fetchHasState = vi.fn(async () => new Set<string>());
    const out = await enrichProjects([], fetchHasState);
    expect(out).toEqual([]);
    expect(fetchHasState).toHaveBeenCalledTimes(1);
    expect(fetchHasState).toHaveBeenCalledWith([]);
  });
});

/**
 * resolveSubHarnessHiveSlug — the register-subs FORMAL membership resolver
 * (EI-332 / hive-pr-rollup-and-subharness-membership P-001). Pins the three
 * root shapes: hive home, hive member (home passes through), plain root.
 */
describe('resolveSubHarnessHiveSlug', () => {
  test('a kind:hive home owns its subs directly', () => {
    expect(resolveSubHarnessHiveSlug({ slug: 'acme', harness_kind: 'hive' })).toBe('acme');
  });

  test('a hive MEMBER root passes its home through (sub-of-a-member no longer orphans)', () => {
    expect(
      resolveSubHarnessHiveSlug({ slug: 'acme-web', harness_kind: 'coding', hive_slug: 'acme' }),
    ).toBe('acme');
  });

  test('a plain root confers no formal membership (legacy parent_slug only)', () => {
    expect(resolveSubHarnessHiveSlug({ slug: 'legacy-root' })).toBeNull();
    expect(resolveSubHarnessHiveSlug({ slug: 'legacy-root', hive_slug: '  ' })).toBeNull();
  });

  test('a hive home with a stray hive_slug edge is still its own home', () => {
    expect(
      resolveSubHarnessHiveSlug({ slug: 'acme', harness_kind: 'hive', hive_slug: 'other' }),
    ).toBe('acme');
  });
});

/**
 * Registered subs group as FORMAL hive members (P-003): entries shaped exactly
 * as registerSubs writes them — hive_slug stamped, NO parent_slug edge in the
 * fixture — must land under the hive home via groupByHive's formal precedence.
 * Proves the grouping has no dependence on the legacy config.json fallback.
 */
describe('register-subs entries group formally via groupByHive', () => {
  test('subs of a hive home group under it with parent_slug absent', () => {
    const home = { slug: 'acme', harness_kind: 'hive' };
    const subHive = resolveSubHarnessHiveSlug(home);
    const projects = [
      home,
      // What registerSubs writes for each classified submodule (P-001):
      { slug: 'acme/libs/sync', harness_kind: 'sub-harness', hive_slug: subHive! },
      { slug: 'acme/libs/db', harness_kind: 'sub-harness', hive_slug: subHive! },
      { slug: 'unrelated' },
    ];
    const groups = groupByHive(projects);
    const acme = groups.find((g) => g.root.slug === 'acme');
    expect(acme?.members.map((m) => m.slug)).toEqual(['acme', 'acme/libs/db', 'acme/libs/sync']);
    expect(groups.find((g) => g.root.slug === 'unrelated')?.members.map((m) => m.slug)).toEqual([
      'unrelated',
    ]);
  });

  test('subs of a hive MEMBER group under the home, not the member (orphan fix)', () => {
    const member = { slug: 'acme-web', harness_kind: 'coding', hive_slug: 'acme' };
    const subHive = resolveSubHarnessHiveSlug(member);
    const projects = [
      { slug: 'acme', harness_kind: 'hive' },
      member,
      { slug: 'acme-web/libs/ui', harness_kind: 'sub-harness', hive_slug: subHive! },
    ];
    const groups = groupByHive(projects);
    expect(groups).toHaveLength(1);
    expect(groups[0].root.slug).toBe('acme');
    expect(groups[0].members.map((m) => m.slug)).toEqual([
      'acme',
      'acme-web',
      'acme-web/libs/ui',
    ]);
  });
});
