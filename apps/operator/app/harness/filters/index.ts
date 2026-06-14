// Generic column-filter app layer (generic-column-filters-2026-06-14 Phase 2):
// the nuqs-backed STATE hook + the flag-gated visual FILTER BAR, composing the
// pure @papercusp/grid-core engine (Phase 1). Panels import from here.

export { useColumnFilters, parseAsColumnFilters } from './useColumnFilters';
export type {
  UseColumnFiltersResult,
  UseColumnFiltersOptions,
  ColumnFilterController,
  ActiveChip,
} from './useColumnFilters';

export { ColumnFilterBar } from './ColumnFilterBar';
