// @vitest-environment jsdom
/**
 * Facet + recency-window helpers for the agents-pill search
 * (facet-pills-and-recency-2026-07-12). Heavy neighbors are mocked exactly like
 * AgentsPillSessions.test.tsx so importing the module stays cheap; the facet
 * engine (@papercusp/facets) is the real pure lib.
 */
import { describe, expect, it } from 'vitest';
import { computeFacets } from '@papercusp/facets';

// Match the sibling test's mocks so importing the module is cheap + side-effect-free.
import { vi } from 'vitest';
vi.mock('@papercusp/sync', () => ({ useSyncQuery: () => ({ data: [{ active: [] }] }) }));
vi.mock('@/app/coord/presence-ui', () => ({ LivenessDot: () => null }));
vi.mock('@/app/harness/AgentInspectorModal', () => ({ default: () => null }));
vi.mock('@/app/harness/AgentThinkingStream', () => ({ ThinkingDot: () => null }));

import { SESSION_FACETS, windowToSinceIso } from './AgentsPillSessions';
import type { SearchSessionResult } from './AgentsPillSessions';

const NOW = Date.parse('2026-07-12T12:00:00Z');

function result(over: Partial<SearchSessionResult> & { sessionId: string }): SearchSessionResult {
  return {
    sourceKind: 'claude',
    topScore: 1,
    hits: [],
    active: null,
    session: null,
    ...over,
  } as SearchSessionResult;
}

const activeAgent = (over: Record<string, unknown>) => over as unknown as SearchSessionResult['active'];

describe('windowToSinceIso', () => {
  it('maps tokens to a since ISO, null for all-time', () => {
    expect(windowToSinceIso('day', NOW)).toBe(new Date(NOW - 86_400_000).toISOString());
    expect(windowToSinceIso('week', NOW)).toBe(new Date(NOW - 7 * 86_400_000).toISOString());
    expect(windowToSinceIso(null, NOW)).toBeNull();
    expect(windowToSinceIso('', NOW)).toBeNull();
    expect(windowToSinceIso(undefined, NOW)).toBeNull();
  });
});

describe('SESSION_FACETS via computeFacets', () => {
  const sessions: SearchSessionResult[] = [
    result({
      sessionId: 's1',
      sourceKind: 'claude',
      active: activeAgent({ ownerId: 'o1', fleetSlug: 'blue', fleetColor: '#00f', role: 'su', currentPlanSlug: 'plan-a' }),
    }),
    result({
      sessionId: 's2',
      sourceKind: 'claude',
      active: activeAgent({ ownerId: 'o2', fleetSlug: 'blue', fleetColor: '#00f', role: 'bee', currentPlanSlug: 'plan-a' }),
    }),
    result({
      sessionId: 's3',
      sourceKind: 'codex',
      active: null,
      session: { planSlug: 'plan-b', role: 'worker' } as SearchSessionResult['session'],
    }),
  ];

  it('derives facets + counts from the actual results (context-dependent)', () => {
    const groups = computeFacets(sessions, SESSION_FACETS, { maxValuesPerFacet: 8 });
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));

    // status: active (s1,s2) vs ended (s3) → both present, 2 distinct → shown.
    expect(byKey.status.values.map((v) => [v.value, v.count])).toEqual([
      ['active', 2],
      ['ended', 1],
    ]);
    // backend: claude x2, codex x1.
    expect(byKey.backend.values.map((v) => [v.value, v.count])).toEqual([
      ['claude', 2],
      ['codex', 1],
    ]);
    // plan: plan-a x2 (active), plan-b x1 (ended fallback).
    expect(byKey.plan.values.map((v) => [v.value, v.count])).toEqual([
      ['plan-a', 2],
      ['plan-b', 1],
    ]);
  });

  it('hides a facet that cannot filter (single distinct value)', () => {
    const groups = computeFacets(sessions, SESSION_FACETS);
    // fleet is only ever "blue" (s3 has none) → single distinct value → HIDDEN.
    expect(groups.find((g) => g.key === 'fleet')).toBeUndefined();
    // machine is absent everywhere → HIDDEN.
    expect(groups.find((g) => g.key === 'machine')).toBeUndefined();
  });

  it('counts are DRILL-DOWN aware — a selection never leaves a dead-end pill behind', () => {
    // Regression (live pixel-drive, 2026-07-12): the popover called computeFacets
    // WITHOUT `selection`, so counts described the unfiltered result set. With
    // status:active selected (1 result, role=su) the role facet still advertised
    // "mug 1" — and clicking it landed on "No results match the selected filters".
    const selection = new Map([['status', new Set(['active'])]]);
    const groups = computeFacets(sessions, SESSION_FACETS, { maxValuesPerFacet: 8, selection });
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));

    // role is tallied over the items matching the OTHER facets' selection (status:active)
    // ⇒ only the roles actually reachable from here. 'worker' belongs to the ENDED
    // session (s3), so it is GONE — before this fix it was still offered, at count 1,
    // and clicking it produced zero results.
    expect(byKey.role.values.map((v) => [v.value, v.count])).toEqual([
      ['su', 1],
      ['bee', 1],
    ]);
    expect(byKey.role.values.some((v) => v.value === 'worker')).toBe(false);
    // plan likewise narrows to the active pool: plan-b (the ended session's) drops out.
    expect(byKey.plan.values.map((v) => [v.value, v.count])).toEqual([['plan-a', 2]]);

    // ...but a facet's OWN values still count as if it weren't filtered, so you can
    // always switch your selection within it (standard faceted-search behavior).
    expect(byKey.status.values.map((v) => [v.value, v.count])).toEqual([
      ['active', 2],
      ['ended', 1],
    ]);
  });

  it('carries fleet color through as opaque meta when the fleet facet DOES show', () => {
    // add a second fleet so the facet clears the ≥2 hide-rule
    const withRed = [
      ...sessions,
      result({ sessionId: 's4', active: activeAgent({ ownerId: 'o4', fleetSlug: 'red', fleetColor: '#f00' }) }),
    ];
    const groups = computeFacets(withRed, SESSION_FACETS);
    const fleet = groups.find((g) => g.key === 'fleet')!;
    expect(fleet.values.find((v) => v.value === 'blue')!.meta).toEqual({ color: '#00f' });
    expect(fleet.values.find((v) => v.value === 'red')!.meta).toEqual({ color: '#f00' });
  });
});
