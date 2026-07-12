import { describe, it, expect } from 'vitest';
import {
  computeFacets,
  facetPredicate,
  applyFacetSelection,
  toggleFacetValue,
  facetSelectionSize,
  serializeFacetSelection,
  parseFacetSelection,
  type FacetDef,
  type FacetSelection,
} from './index';

interface Row {
  id: string;
  kind: string;
  fleet?: string | null;
  fleetColor?: string | null;
  owners?: string[];
  status: 'active' | 'ended';
}

const rows: Row[] = [
  { id: 'a', kind: 'claude', fleet: 'blue', fleetColor: '#00f', owners: ['x', 'y'], status: 'active' },
  { id: 'b', kind: 'claude', fleet: 'blue', fleetColor: '#00f', owners: ['x'], status: 'active' },
  { id: 'c', kind: 'codex', fleet: null, owners: ['z'], status: 'ended' },
  { id: 'd', kind: 'claude', fleet: 'red', fleetColor: '#f00', owners: [], status: 'active' },
];

const defs: FacetDef<Row, { color?: string | null }>[] = [
  { key: 'status', label: 'Status', extract: (r) => r.status },
  { key: 'kind', label: 'Agent', extract: (r) => r.kind },
  {
    key: 'fleet',
    label: 'Fleet',
    extract: (r) => (r.fleet ? { value: r.fleet, meta: { color: r.fleetColor } } : null),
  },
  { key: 'owner', label: 'Owner', extract: (r) => r.owners ?? [] },
];

const sel = (entries: Record<string, string[]>): FacetSelection =>
  new Map(Object.entries(entries).map(([k, v]) => [k, new Set(v)]));

describe('computeFacets', () => {
  it('omits a facet the drill-down pool empties out (never a bare label with no pills)', () => {
    // status:ended keeps only row c, which has NO fleet. `fleet` clears the
    // ≥2-distinct hide-rule over the FULL set (blue, red), so the stability rule
    // alone would keep rendering it — with zero values under it. A facet with
    // nothing to offer must not render at all.
    const groups = computeFacets(rows, defs, { selection: sel({ status: ['ended'] }) });
    expect(groups.find((g) => g.key === 'fleet')).toBeUndefined();

    // the facets that DO still have values in the pool are unaffected
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));
    expect(byKey.owner.values.map((v) => [v.value, v.count])).toEqual([['z', 1]]);
    // and the selected facet still counts its OWN values over the unfiltered set
    expect(byKey.status.values.map((v) => [v.value, v.count])).toEqual([
      ['active', 3],
      ['ended', 1],
    ]);
  });

  it('tallies counts per value, sorted count-desc', () => {
    const groups = computeFacets(rows, defs);
    const kind = groups.find((g) => g.key === 'kind')!;
    expect(kind.values.map((v) => [v.value, v.count])).toEqual([
      ['claude', 3],
      ['codex', 1],
    ]);
  });

  it('hides a facet with a single distinct value (context-dependent rule)', () => {
    // All four rows are kind=claude except one — but make a facet everyone shares.
    const singleValue: FacetDef<Row>[] = [{ key: 'const', extract: () => 'same' }];
    expect(computeFacets(rows, singleValue)).toEqual([]);
    // minDistinctValues:1 keeps it.
    const kept = computeFacets(rows, singleValue, { minDistinctValues: 1 });
    expect(kept).toHaveLength(1);
    expect(kept[0].values).toEqual([{ value: 'same', count: 4, meta: undefined }]);
  });

  it('counts multi-valued extracts and skips missing values', () => {
    const groups = computeFacets(rows, defs);
    const owner = groups.find((g) => g.key === 'owner')!;
    // x appears in a+b (2), y in a (1), z in c (1); row d has no owners → contributes nothing.
    expect(owner.values.map((v) => [v.value, v.count])).toEqual([
      ['x', 2],
      ['y', 1],
      ['z', 1],
    ]);
    const fleet = groups.find((g) => g.key === 'fleet')!;
    // c has null fleet → not counted; blue=2, red=1.
    expect(fleet.values.map((v) => [v.value, v.count])).toEqual([
      ['blue', 2],
      ['red', 1],
    ]);
  });

  it('carries opaque per-value meta through from the first contributing row', () => {
    const groups = computeFacets(rows, defs);
    const fleet = groups.find((g) => g.key === 'fleet')!;
    expect(fleet.values.find((v) => v.value === 'blue')!.meta).toEqual({ color: '#00f' });
    expect(fleet.values.find((v) => v.value === 'red')!.meta).toEqual({ color: '#f00' });
  });

  it('de-dupes the same value within one row', () => {
    const dupRows = [{ tags: ['a', 'a', 'b'] }, { tags: ['a'] }];
    const groups = computeFacets(dupRows, [{ key: 'tag', extract: (r) => r.tags }]);
    const tag = groups[0];
    // 'a' counted once for row1 despite appearing twice → a:2 (row1+row2), b:1.
    expect(tag.values.map((v) => [v.value, v.count])).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
  });

  it('caps values and reports hiddenValueCount', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ v: `v${i}` }));
    const groups = computeFacets(many, [{ key: 'v', extract: (r) => r.v }], { maxValuesPerFacet: 2 });
    expect(groups[0].values).toHaveLength(2);
    expect(groups[0].hiddenValueCount).toBe(3);
    expect(groups[0].distinctCount).toBe(5);
  });

  it('breaks count ties by first-seen order (stable)', () => {
    const tied = [{ v: 'b' }, { v: 'a' }, { v: 'a' }, { v: 'b' }];
    const groups = computeFacets(tied, [{ key: 'v', extract: (r) => r.v }]);
    // b and a both count 2; b was seen first → b before a.
    expect(groups[0].values.map((v) => v.value)).toEqual(['b', 'a']);
  });

  it('drill-down: a facet is counted against OTHER facets’ selection, not its own', () => {
    const selection = sel({ kind: ['claude'] });
    const groups = computeFacets(rows, defs, { selection });
    // status counted over claude rows only (a,b,d) → active:3 (no ended).
    const status = groups.find((g) => g.key === 'status')!;
    expect(status.values.map((v) => [v.value, v.count])).toEqual([['active', 3]]);
    // kind counted over the pool that ignores kind's OWN selection → full set: claude:3, codex:1.
    const kind = groups.find((g) => g.key === 'kind')!;
    expect(kind.values.map((v) => [v.value, v.count])).toEqual([
      ['claude', 3],
      ['codex', 1],
    ]);
  });

  it('drill-down never strands a selected value (keeps it at count 0)', () => {
    // Select fleet=red AND status=ended: no row is both → red drops from the pool
    // but must still appear so it can be deselected.
    const selection = sel({ status: ['ended'], fleet: ['red'] });
    const groups = computeFacets(rows, defs, { selection });
    const fleet = groups.find((g) => g.key === 'fleet')!;
    const red = fleet.values.find((v) => v.value === 'red');
    expect(red).toBeDefined();
    expect(red!.count).toBe(0);
  });
});

describe('facetPredicate / applyFacetSelection', () => {
  it('empty selection matches everything', () => {
    const pred = facetPredicate(defs, new Map());
    expect(rows.every(pred)).toBe(true);
  });

  it('AND across facets, OR within a facet', () => {
    // (kind = claude OR codex) AND (status = active)
    const selection = sel({ kind: ['claude', 'codex'], status: ['active'] });
    const kept = applyFacetSelection(rows, defs, selection);
    expect(kept.map((r) => r.id).sort()).toEqual(['a', 'b', 'd']); // c is ended
  });

  it('matches multi-valued rows when any value is selected', () => {
    const selection = sel({ owner: ['z'] });
    expect(applyFacetSelection(rows, defs, selection).map((r) => r.id)).toEqual(['c']);
  });
});

describe('selection helpers', () => {
  it('toggleFacetValue adds/removes immutably and prunes empty facets', () => {
    const s0: FacetSelection = new Map();
    const s1 = toggleFacetValue(s0, 'kind', 'claude');
    expect(s0.size).toBe(0); // original untouched
    expect([...s1.get('kind')!]).toEqual(['claude']);
    const s2 = toggleFacetValue(s1, 'kind', 'codex');
    expect([...s2.get('kind')!].sort()).toEqual(['claude', 'codex']);
    const s3 = toggleFacetValue(toggleFacetValue(s2, 'kind', 'claude'), 'kind', 'codex');
    expect(s3.has('kind')).toBe(false); // emptied facet removed
  });

  it('facetSelectionSize totals across facets', () => {
    expect(facetSelectionSize(sel({ a: ['1', '2'], b: ['3'] }))).toBe(3);
    expect(facetSelectionSize(new Map())).toBe(0);
  });
});

describe('serialize/parse round-trip', () => {
  it('round-trips a selection including reserved characters', () => {
    const s = sel({ plan: ['my-plan:v2', 'a,b'], fleet: ['blue'] });
    const encoded = serializeFacetSelection(s);
    const back = parseFacetSelection(encoded);
    expect([...back.get('plan')!].sort()).toEqual(['a,b', 'my-plan:v2'].sort());
    expect([...back.get('fleet')!]).toEqual(['blue']);
  });

  it('empty selection ⇒ empty string ⇒ empty map', () => {
    expect(serializeFacetSelection(new Map())).toBe('');
    expect(parseFacetSelection('').size).toBe(0);
    expect(parseFacetSelection(null).size).toBe(0);
    expect(parseFacetSelection(undefined).size).toBe(0);
  });

  it('tolerates malformed input', () => {
    expect(parseFacetSelection('garbage-no-colon').size).toBe(0);
    expect(parseFacetSelection(';;;').size).toBe(0);
    const m = parseFacetSelection('kind:claude;broken;fleet:');
    expect([...m.get('kind')!]).toEqual(['claude']);
    expect(m.has('fleet')).toBe(false); // no values after colon
  });
});
