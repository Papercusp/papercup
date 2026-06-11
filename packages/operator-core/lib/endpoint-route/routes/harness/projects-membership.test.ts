/**
 * resolveProjectHiveMembership — the "add into hive" membership-edge decision
 * (harnesses-tab-hive-model P-011). Pins the formal-vs-legacy precedence + the
 * standalone/unknown-scope cases.
 */
import { describe, test, expect, vi } from 'vitest';
import { resolveProjectHiveMembership, enrichProjects } from './projects';
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
