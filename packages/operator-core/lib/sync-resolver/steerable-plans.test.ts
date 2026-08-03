/**
 * steerable-plans.test — the server-side projection behind `plans.steerable`
 * (no-http-anywhere-2026-07-28 D-071).
 *
 * These branches used to live in the client as MugTab's `selectSteerablePlans`
 * (pinned by MugTab.derivation.test.ts). They moved here WITH their coverage
 * when the selection moved server-side, so the behaviour is asserted once, in
 * the place that now computes it — and a regression here is what would silently
 * change which plans the owner can steer.
 */
import { describe, expect, it } from 'vitest';
import {
  selectSteerablePlanRows,
  steerablePlanRank,
  type PlanRowLike,
  type SteerablePlanRow,
} from './steerable-plans';

function plan(over: Partial<Record<keyof PlanRowLike, unknown>>): PlanRowLike {
  return { slug: 'p', title: 'P', status: 'draft', archived: false, isLegacy: false, harness: 'h', ...over };
}

function row(over: Partial<SteerablePlanRow> = {}): SteerablePlanRow {
  return { slug: 'a', title: null, status: null, startStatus: null, updated: null, harness: 'h', ...over };
}

describe('selectSteerablePlanRows', () => {
  it('drops shipped, superseded, and archived plans', () => {
    const rows = [
      plan({ slug: 'draft-x', status: 'draft' }),
      plan({ slug: 'shipped-x', status: 'shipped' }),
      plan({ slug: 'superseded-x', status: 'superseded' }),
      plan({ slug: 'archived-x', status: 'ready', archived: true }),
    ];
    expect(selectSteerablePlanRows(rows).map((p) => p.slug)).toEqual(['draft-x']);
  });

  it('drops legacy rows — the client narrowed with includeLegacy:false before this moved server-side', () => {
    const rows = [plan({ slug: 'keep', status: 'ready' }), plan({ slug: 'legacy-x', status: 'ready', isLegacy: true })];
    expect(selectSteerablePlanRows(rows).map((p) => p.slug)).toEqual(['keep']);
  });

  it('ranks started < active < ready < other, then by recency desc', () => {
    const rows = [
      plan({ slug: 'ready-old', status: 'ready', updated: '2026-01-01' }),
      plan({ slug: 'draft-1', status: 'draft', updated: '2026-06-01' }),
      plan({ slug: 'active-1', status: 'active', updated: '2026-02-01' }),
      plan({ slug: 'started-1', status: 'active', startStatus: 'started', updated: '2026-01-01' }),
      plan({ slug: 'ready-new', status: 'ready', updated: '2026-05-01' }),
    ];
    expect(selectSteerablePlanRows(rows).map((p) => p.slug)).toEqual([
      'started-1', // rank 0
      'active-1', // rank 1
      'ready-new', // rank 2, newer
      'ready-old', // rank 2, older
      'draft-1', // rank 3
    ]);
  });

  it('projects to exactly the six fields the panel reads — a fat row does not leak onto the wire', () => {
    const [projected] = selectSteerablePlanRows([
      plan({
        slug: 'a',
        title: 'A',
        status: 'active',
        startStatus: 'started',
        updated: '2026-06-15',
        harness: 'pot-a',
        // the bulk `plans.list` carries and the panel never reads:
        itemCounts: { done: 12, todo: 30 },
        nextAction: 'a long sentence of prose',
        ownerIdentity: { handle: 'x', avatarUrl: 'y' },
        lastEditor: { handle: 'z' },
        created: '2026-01-01',
        owner: 'someone',
        initiative: 'some-initiative',
      }),
    ]);
    expect(Object.keys(projected).sort()).toEqual([
      'harness',
      'slug',
      'startStatus',
      'status',
      'title',
      'updated',
    ]);
    expect(projected).toEqual({
      slug: 'a',
      title: 'A',
      status: 'active',
      startStatus: 'started',
      updated: '2026-06-15',
      harness: 'pot-a',
    });
  });

  it('normalises absent/blank optional fields to null — but harness to the tree\'s "" sentinel', () => {
    const [projected] = selectSteerablePlanRows([{ slug: 'a' }]);
    expect(projected).toEqual({
      slug: 'a',
      title: null,
      status: null,
      startStatus: null,
      updated: null,
      harness: '',
    });
  });

  it('carries harness through — the nested hive→plan picker groups on it, and losing it silently unassigns every plan', () => {
    const rows = selectSteerablePlanRows([
      plan({ slug: 'a', harness: 'pot-a', status: 'active' }),
      plan({ slug: 'b', harness: 'papercup-hive', status: 'active' }),
    ]);
    expect(rows.map((p) => [p.slug, p.harness])).toEqual([
      ['a', 'pot-a'],
      ['b', 'papercup-hive'],
    ]);
  });

  it('skips malformed rows rather than emitting a slug-less entry', () => {
    const rows = [null, undefined, 42, { title: 'no slug' }, plan({ slug: 'ok' })] as unknown as PlanRowLike[];
    expect(selectSteerablePlanRows(rows).map((p) => p.slug)).toEqual(['ok']);
  });

  it('returns [] for a missing / non-array input', () => {
    expect(selectSteerablePlanRows(undefined)).toEqual([]);
    expect(selectSteerablePlanRows(null as unknown as PlanRowLike[])).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const rows = [plan({ slug: 'b', status: 'ready' }), plan({ slug: 'a', status: 'active' })];
    const snapshot = rows.map((r) => r.slug);
    selectSteerablePlanRows(rows);
    expect(rows.map((r) => r.slug)).toEqual(snapshot);
  });
});

describe('steerablePlanRank', () => {
  it('puts an in-flight plan ahead of its own status rank', () => {
    // startStatus wins over status: a STARTED ready plan outranks an active one.
    expect(steerablePlanRank(row({ status: 'ready', startStatus: 'started' }))).toBe(0);
    expect(steerablePlanRank(row({ status: 'active' }))).toBe(1);
    expect(steerablePlanRank(row({ status: 'ready' }))).toBe(2);
    expect(steerablePlanRank(row({ status: 'draft' }))).toBe(3);
  });
});
