// @vitest-environment node
/**
 * `filterPlanListRows` — the client-side half of the plans.list superset
 * collapse (slim-plans-attention-sync-payload-2026-07-26 P-001/P-002).
 *
 * `usePlanList` now always fetches the SUPERSET (`includeArchived: true,
 * includeLegacy: true`) so eight call sites share ONE sync cache entry instead
 * of three, and narrows to each caller's request client-side. That is only
 * correct while this predicate matches the SERVER's filter exactly, so these
 * tests pin both halves:
 *
 *   1. the predicate itself, over a fixture covering all four
 *      archived × legacy quadrants;
 *   2. the DEFAULTS, which are asymmetric and easy to invert —
 *      `includeArchived` defaults FALSE, `includeLegacy` defaults TRUE;
 *   3. a source-level guard that reads the two literal expressions out of
 *      `agent-tools/plans/list.ts`, so a server-side default flip fails HERE
 *      rather than silently changing which plans the UI shows.
 *
 * (3) is the load-bearing one: (1) and (2) only prove the client is
 * self-consistent. Measured motivation: the three arg shapes were ~763KB each
 * on live :3070 for one 895-row dataset differing by 15 rows.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { filterPlanListRows, mergePlanListResults } from './plans-api';
import type { PlanListRow } from './plans-api';

const row = (slug: string, archived: boolean, isLegacy: boolean): PlanListRow =>
  ({ slug, archived, isLegacy }) as PlanListRow;

/** All four quadrants of the two-boolean axis. */
const SUPERSET: PlanListRow[] = [
  row('live', false, false),
  row('legacy', false, true),
  row('archived', true, false),
  row('archived-legacy', true, true),
];

const slugsOf = (rows: PlanListRow[]) => rows.map((r) => r.slug).sort();

describe('filterPlanListRows', () => {
  it('returns the whole superset untouched when both flags are on', () => {
    const out = filterPlanListRows(SUPERSET, { includeArchived: true, includeLegacy: true });
    expect(slugsOf(out)).toEqual(slugsOf(SUPERSET));
    // Identity, not a copy — the common case must not allocate.
    expect(out).toBe(SUPERSET);
  });

  it('drops archived plans when includeArchived is false', () => {
    const out = filterPlanListRows(SUPERSET, { includeArchived: false, includeLegacy: true });
    expect(slugsOf(out)).toEqual(['legacy', 'live']);
  });

  it('drops legacy plans when includeLegacy is false', () => {
    const out = filterPlanListRows(SUPERSET, { includeArchived: true, includeLegacy: false });
    expect(slugsOf(out)).toEqual(['archived', 'live']);
  });

  it('drops both when both are false', () => {
    const out = filterPlanListRows(SUPERSET, { includeArchived: false, includeLegacy: false });
    expect(slugsOf(out)).toEqual(['live']);
  });

  it('treats an absent row set as empty rather than throwing', () => {
    expect(filterPlanListRows(undefined, { includeArchived: true, includeLegacy: true })).toEqual([]);
  });

  it('never mutates the superset it filters (it is a shared sync cache row array)', () => {
    const before = slugsOf(SUPERSET);
    filterPlanListRows(SUPERSET, { includeArchived: false, includeLegacy: false });
    expect(slugsOf(SUPERSET)).toEqual(before);
  });
});

describe('server default parity (the drift guard)', () => {
  const listToolSrc = readFileSync(
    join(
      __dirname,
      '../../../../../packages/operator-core/lib/agent-tools/plans/list.ts',
    ),
    'utf8',
  );

  it('reads the plans:list tool source (the path below is part of the assertion)', () => {
    expect(listToolSrc).toContain('const argsSchema');
  });

  it('pins includeArchived to default FALSE on the server', () => {
    // `usePlanList` maps an omitted flag with `params?.includeArchived === true`,
    // which is only equivalent while the server uses the same `=== true` form.
    expect(listToolSrc).toContain('const includeArchived = args.includeArchived === true;');
  });

  it('pins includeLegacy to default TRUE on the server', () => {
    // Note the asymmetry vs includeArchived — `!== false`, so omitting the flag
    // INCLUDES legacy plans. `usePlanList` mirrors it with `!== false`.
    expect(listToolSrc).toContain('const includeLegacy = args.includeLegacy !== false;');
  });

  it('narrows an omitted-flag caller ({}) to archived-off + legacy-on', () => {
    // The exact mapping usePlanList applies for `usePlanList()` / `usePlanList({})`.
    const params: { includeArchived?: boolean; includeLegacy?: boolean } = {};
    const out = filterPlanListRows(SUPERSET, {
      includeArchived: params.includeArchived === true,
      includeLegacy: params.includeLegacy !== false,
    });
    expect(slugsOf(out)).toEqual(['legacy', 'live']);
  });
});

describe('mergePlanListResults', () => {
  const result = (plans: PlanListRow[], over: Partial<{ loading: boolean; error: string | null }> = {}) => ({
    data: { plans },
    loading: over.loading ?? false,
    error: over.error ?? null,
    refresh: vi.fn(),
  });

  it('unions lazy terminal slices with the base and de-duplicates by harness+slug', () => {
    const base = result([row('live', false, false)]);
    const shipped = result([row('live', false, false), row('shipped', false, false)]);
    const merged = mergePlanListResults([base, shipped]);
    expect(slugsOf(merged.data?.plans ?? [])).toEqual(['live', 'shipped']);
    merged.refresh();
    expect(base.refresh).toHaveBeenCalledOnce();
    expect(shipped.refresh).toHaveBeenCalledOnce();
  });
});
