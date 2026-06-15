// @vitest-environment jsdom
/**
 * useColumnFilters.test.tsx — whole-app-test-coverage-breadth.
 *
 * Two layers:
 *  1. parseAsColumnFilters — the pure custom nuqs parser. Tested WITHOUT React:
 *     parse/serialize round-trip through the grid-core codec, `eq` compares the
 *     canonical encoded form (so clearOnDefault collapses equivalent states),
 *     and the empty default ('{}') is returned for an empty URL value.
 *  2. useColumnFilters — the state hook, driven via renderHook +
 *     withNuqsTestingAdapter so the ONE `<ns>f` URL param is seeded + observed.
 *     Pins: rows are filtered (AND) by the seeded state, the fast-path returns
 *     the input ref when nothing is active, setValue/remove/clearAll write the
 *     expected URL string, activeChips order by column order + carry the
 *     grid-core label, and enum optionsFor derives live counts.
 *
 * Run with:
 *   npx vitest run app/harness/filters/useColumnFilters.test.tsx
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, renderHook, act, waitFor } from '@testing-library/react';
import { withNuqsTestingAdapter, type UrlUpdateEvent } from 'nuqs/adapters/testing';
import type { FilterableColumn } from '@papercusp/grid-core';
import { parseAsColumnFilters, useColumnFilters } from './useColumnFilters';

afterEach(() => cleanup());

interface Row {
  name: string;
  kind: string | null;
  prio: number | null;
  open: boolean;
}

// A stable column set used by the hook tests (text + enum + number + boolean).
const COLS: ReadonlyArray<FilterableColumn<Row>> = [
  { key: 'name', header: 'Name', filter: { type: 'text', accessor: (r) => r.name } },
  {
    key: 'kind',
    header: 'Kind',
    filter: {
      type: 'enum',
      accessor: (r) => r.kind,
      options: [
        { value: 'bug', label: 'Bug' },
        { value: 'change', label: 'Change' },
      ],
    },
  },
  { key: 'prio', header: 'Prio', filter: { type: 'number', accessor: (r) => r.prio } },
  { key: 'open', header: 'Open', filter: { type: 'boolean', accessor: (r) => r.open } },
  // A column WITHOUT a filter spec — must be excluded from filterableColumns.
  { key: 'noFilter', header: 'Plain' },
];

const ROWS: Row[] = [
  { name: 'alpha', kind: 'bug', prio: 1, open: true },
  { name: 'beta', kind: 'change', prio: 3, open: false },
  { name: 'gamma', kind: 'bug', prio: 5, open: true },
  { name: 'delta', kind: null, prio: null, open: false },
];

// ─── pure parser ─────────────────────────────────────────────────────────────

describe('parseAsColumnFilters (pure parser)', () => {
  const parser = parseAsColumnFilters(COLS);

  it('defaults an empty URL value to the empty state {}', () => {
    expect(parser.parse('')).toEqual({});
    expect(parser.defaultValue).toEqual({});
  });

  it('round-trips parse(serialize(state)) for every value type', () => {
    const state = {
      name: 'al',
      kind: ['bug', 'change'],
      prio: { min: 1, max: 3 },
      open: true,
    };
    const wire = parser.serialize(state);
    expect(parser.parse(wire)).toEqual(state);
  });

  it('drops clauses whose key is not a filterable column on decode', () => {
    // "ghost" isn't in COLS → decoded away; "name" survives.
    const decoded = parser.parse('ghost:zzz~name:al');
    expect(decoded).toEqual({ name: 'al' });
  });

  it('eq compares the canonical encoded form', () => {
    // Same insertion order ⇒ identical encoding ⇒ equal.
    expect(parser.eq?.({ name: 'a', open: true }, { name: 'a', open: true })).toBe(true);
    // Different value ⇒ different encoding ⇒ not equal.
    expect(parser.eq?.({ name: 'a' }, { name: 'b' })).toBe(false);
    // The empty state equals itself (clearOnDefault collapses to the URL default).
    expect(parser.eq?.({}, {})).toBe(true);
    // An inactive clause encodes to nothing, so {name:''} ≡ {} under eq.
    expect(parser.eq?.({ name: '' }, {})).toBe(true);
  });

  it('serialize omits inactive clauses (empty text, empty enum, open-ended range)', () => {
    expect(parser.serialize({ name: '', kind: [], prio: {} })).toBe('');
  });
});

// ─── the hook ────────────────────────────────────────────────────────────────

function renderFilters(searchParams: string, rows: Row[] = ROWS) {
  let lastSearch: URLSearchParams | null = null;
  const onUrlUpdate = (e: UrlUpdateEvent) => {
    lastSearch = e.searchParams;
  };
  const view = renderHook(() => useColumnFilters(COLS, rows, { ns: 'wi' }), {
    wrapper: withNuqsTestingAdapter({ searchParams, onUrlUpdate }),
  });
  return { view, getLastSearch: () => lastSearch };
}

describe('useColumnFilters (hook)', () => {
  it('returns all rows and the SAME array ref when no filter is active (fast path)', () => {
    const { view } = renderFilters('');
    expect(view.result.current.hasActive).toBe(false);
    expect(view.result.current.activeChips).toEqual([]);
    // Fast path: applyColumnFilters returns the input ref when nothing is active.
    expect(view.result.current.rows).toBe(ROWS);
  });

  it('only filterable columns appear in the controller (the no-filter col is excluded)', () => {
    const { view } = renderFilters('');
    const keys = view.result.current.controller.filterableColumns.map((c) => c.key);
    expect(keys).toEqual(['name', 'kind', 'prio', 'open']);
  });

  it('AND-filters rows from a seeded URL state (enum membership + number range)', () => {
    // kind ∈ {bug} AND 1 <= prio <= 3 → only "alpha" (gamma is bug but prio 5).
    const { view } = renderFilters('?wif=kind:bug~prio:1..3');
    expect(view.result.current.rows.map((r) => r.name)).toEqual(['alpha']);
    expect(view.result.current.hasActive).toBe(true);
  });

  it('a nullish accessor value fails an active filter', () => {
    // open:true excludes "delta" (open=false) and any row whose open is nullish.
    const { view } = renderFilters('?wif=open:true');
    expect(view.result.current.rows.map((r) => r.name)).toEqual(['alpha', 'gamma']);
  });

  it('activeChips are ordered by column order and carry the grid-core label', () => {
    // Seed prio (after kind in COLS) before kind in the URL; chips must still
    // read in column order: kind, then prio.
    const { view } = renderFilters('?wif=prio:2..~kind:bug,change');
    const chips = view.result.current.activeChips;
    expect(chips.map((c) => c.colKey)).toEqual(['kind', 'prio']);
    expect(chips[0].label).toBe('Kind: Bug, Change'); // enum labels via options
    expect(chips[1].label).toBe('Prio: ≥2');
  });

  it('setValue writes the column value into the <ns>f param', async () => {
    const { view, getLastSearch } = renderFilters('');
    act(() => {
      view.result.current.controller.setValue('name', 'al');
    });
    // The nuqs update queue flushes asynchronously — wait for it.
    await waitFor(() => expect(getLastSearch()).not.toBeNull());
    expect(getLastSearch()!.get('wif')).toBe('name:al');
    expect(view.result.current.rows.map((r) => r.name)).toEqual(['alpha']);
  });

  it('remove drops just that column; clearAll drops the whole param', async () => {
    const { view, getLastSearch } = renderFilters('?wif=name:al~open:true');
    expect(view.result.current.rows.map((r) => r.name)).toEqual(['alpha']);

    act(() => {
      view.result.current.controller.remove('open');
    });
    // name filter still active → alpha remains, the URL no longer carries open.
    await waitFor(() => expect(getLastSearch()).not.toBeNull());
    expect(view.result.current.rows.map((r) => r.name)).toEqual(['alpha']);
    expect(getLastSearch()!.get('wif')).toBe('name:al');

    act(() => {
      view.result.current.clearAll();
    });
    // Clearing to the default drops the param entirely.
    await waitFor(() => expect(getLastSearch()!.has('wif')).toBe(false));
    expect(view.result.current.hasActive).toBe(false);
    expect(view.result.current.rows).toBe(ROWS);
  });

  it('valueFor reflects the current state; remove makes it undefined', () => {
    const { view } = renderFilters('?wif=name:beta');
    expect(view.result.current.controller.valueFor('name')).toBe('beta');
    expect(view.result.current.controller.valueFor('kind')).toBeUndefined();
    act(() => {
      view.result.current.controller.remove('name');
    });
    expect(view.result.current.controller.valueFor('name')).toBeUndefined();
  });

  it('optionsFor derives live enum counts; non-enum columns get []', () => {
    const { view } = renderFilters('');
    const opts = view.result.current.controller.optionsFor('kind');
    // Explicit options order is kept; counts come from ROWS (bug×2, change×1).
    expect(opts).toEqual([
      { value: 'bug', label: 'Bug', count: 2 },
      { value: 'change', label: 'Change', count: 1 },
    ]);
    expect(view.result.current.controller.optionsFor('name')).toEqual([]);
    expect(view.result.current.controller.optionsFor('prio')).toEqual([]);
  });
});
