'use client';

/**
 * useColumnFilters — the app-side STATE hook for the generic column-filter
 * system (generic-column-filters-2026-06-14 Phase 2). It owns the URL state
 * (ONE nuqs param via a custom parser) and memoizes the pure filtering done by
 * @papercusp/grid-core (Phase 1 engine), then hands the visual <ColumnFilterBar/>
 * everything it needs through a `controller`.
 *
 * Design contract:
 *   - `cols` is the minimal FilterableColumn[] ({ key, header, filter? }) from
 *     grid-core, so BOTH RichGrid panels (which pass their ColumnDef[] —
 *     structurally assignable) AND non-grid panels can use the same hook.
 *   - State lives in a SINGLE `<ns>f` URL param (no hooks-in-a-loop): the custom
 *     `parseAsColumnFilters(cols)` parser (de)serializes the whole
 *     ColumnFilterState with the grid-core encode/decode codec.
 *   - The hook never mutates `rows`; applyColumnFilters fast-paths (returns the
 *     input ref) when no filter is active.
 */

import { useCallback, useMemo } from 'react';
import { createParser, useQueryState } from 'nuqs';
import {
  applyColumnFilters,
  decodeColumnFilters,
  deriveEnumOptions,
  encodeColumnFilters,
  filterChipLabel,
  type ColumnFilterState,
  type ColumnFilterValue,
  type EnumOption,
  type FilterableColumn,
} from '@papercusp/grid-core';

/** A single removable active-filter chip for the bar. */
export interface ActiveChip {
  /** Column key the chip filters. */
  colKey: string;
  /** Human label via grid-core's `filterChipLabel` (e.g. "Kind: Bug, Change"). */
  label: string;
  /** Drop just this column's filter. */
  clear: () => void;
}

/**
 * Everything <ColumnFilterBar/> needs to render + edit filters. Typed-erased on
 * the row type at the edge so the bar component stays generic-free.
 */
export interface ColumnFilterController<TRow> {
  /** Only the columns that declare a `filter` spec, in column order. */
  filterableColumns: FilterableColumn<TRow>[];
  /** Current value for a column key, or undefined when inactive. */
  valueFor: (colKey: string) => ColumnFilterValue | undefined;
  /** Set (or replace) a column's filter value. */
  setValue: (colKey: string, value: ColumnFilterValue) => void;
  /** Remove a column's filter entirely. */
  remove: (colKey: string) => void;
  /**
   * Live enum options for an `enum` column (value/label/count) derived from the
   * CURRENT rows via grid-core's `deriveEnumOptions`. Empty for non-enum columns.
   */
  optionsFor: (colKey: string) => EnumOption[];
}

export interface UseColumnFiltersResult<TRow> {
  /** Rows after AND-ing every active filter (memoized; input ref when none active). */
  rows: TRow[];
  /** State + actions the bar drives. */
  controller: ColumnFilterController<TRow>;
  /** Active filters as removable chips (label via filterChipLabel). */
  activeChips: ActiveChip[];
  /** Drop every active filter at once. */
  clearAll: () => void;
  /** Whether any filter is currently active. */
  hasActive: boolean;
}

export interface UseColumnFiltersOptions {
  /**
   * URL-param namespace prefix. The hook owns ONE param: `<ns>f`. Pick a prefix
   * that won't collide with the panel's other nuqs params (e.g. 'wi' → 'wif').
   */
  ns: string;
}

/**
 * Custom nuqs parser for a whole ColumnFilterState, backed by the grid-core
 * codec. Decode needs the column set (to map each key to its spec type); encode
 * does not. `eq` compares the canonical encoded form so clearOnDefault works for
 * the empty state ('').
 */
export function parseAsColumnFilters<TRow>(cols: readonly FilterableColumn<TRow>[]) {
  return createParser<ColumnFilterState>({
    parse: (value) => decodeColumnFilters(value, cols),
    serialize: (state) => encodeColumnFilters(state),
    eq: (a, b) => encodeColumnFilters(a) === encodeColumnFilters(b),
  }).withDefault({});
}

export function useColumnFilters<TRow>(
  cols: readonly FilterableColumn<TRow>[],
  rows: readonly TRow[],
  opts: UseColumnFiltersOptions,
): UseColumnFiltersResult<TRow> {
  const { ns } = opts;

  // The parser closes over `cols` (decode needs each key's spec type). cols is a
  // fresh array literal per render in most panels, but the decoded value only
  // depends on the keys+specs, so a referentially-new parser is harmless —
  // useQueryState re-parses the same URL string to the same state.
  const parser = useMemo(() => parseAsColumnFilters(cols), [cols]);
  const [state, setState] = useQueryState(ns + 'f', parser);

  const filterableColumns = useMemo(
    () => cols.filter((c): c is FilterableColumn<TRow> => Boolean(c.filter)),
    [cols],
  );

  const filteredRows = useMemo(
    () => applyColumnFilters(rows, state, cols),
    [rows, state, cols],
  );

  const setValue = useCallback(
    (colKey: string, value: ColumnFilterValue) => {
      void setState((prev) => ({ ...(prev ?? {}), [colKey]: value }));
    },
    [setState],
  );

  const remove = useCallback(
    (colKey: string) => {
      void setState((prev) => {
        if (!prev || !(colKey in prev)) return prev;
        const next = { ...prev };
        delete next[colKey];
        return next;
      });
    },
    [setState],
  );

  const clearAll = useCallback(() => {
    // Clearing to the default ({}) drops the param from the URL.
    void setState(null);
  }, [setState]);

  // Per-column enum options, derived from the live rows. Memoized as a Map so the
  // bar's `optionsFor` is a cheap lookup rather than a re-derive per call.
  const optionsByKey = useMemo(() => {
    const map = new Map<string, EnumOption[]>();
    for (const col of filterableColumns) {
      if (col.filter?.type === 'enum') {
        map.set(col.key, deriveEnumOptions(rows, col));
      }
    }
    return map;
  }, [filterableColumns, rows]);

  const controller = useMemo<ColumnFilterController<TRow>>(
    () => ({
      filterableColumns,
      valueFor: (colKey) => state?.[colKey],
      setValue,
      remove,
      optionsFor: (colKey) => optionsByKey.get(colKey) ?? [],
    }),
    [filterableColumns, state, setValue, remove, optionsByKey],
  );

  const activeChips = useMemo<ActiveChip[]>(() => {
    if (!state) return [];
    const chips: ActiveChip[] = [];
    // Order chips by column order, not object-key order, so the row reads stably.
    for (const col of filterableColumns) {
      const value = state[col.key];
      if (value === undefined) continue;
      const label = filterChipLabel(col, value);
      if (!label) continue; // inactive value ⇒ '' ⇒ no chip
      chips.push({ colKey: col.key, label, clear: () => remove(col.key) });
    }
    return chips;
  }, [state, filterableColumns, remove]);

  return {
    rows: filteredRows,
    controller,
    activeChips,
    clearAll,
    hasActive: activeChips.length > 0,
  };
}
