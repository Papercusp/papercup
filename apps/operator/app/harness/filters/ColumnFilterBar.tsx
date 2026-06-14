'use client';

/**
 * ColumnFilterBar — the visual surface for the generic column-filter system
 * (generic-column-filters-2026-06-14 Phase 2). Driven entirely by the
 * `controller` from `useColumnFilters`; renders NOTHING when the
 * `papercusp-grid-column-filters` flag is off.
 *
 * Chosen UX (plan P-009) — a single FILTER BAR, not per-column header funnels:
 *   - A `+ Add filter` design-system <Select> listing the filterable columns
 *     that are NOT yet active. Picking one opens a <Popover> editor for it.
 *   - Per-type editor inside the Popover: text → text input; enum → checkbox
 *     multiselect (each option shows its live count; single-select if !multi);
 *     number → min/max inputs; boolean → a true/false toggle.
 *   - Active filters render as removable `pc-advpanel__chip` chips (label + ×),
 *     with a `Clear all` when any is active.
 *
 * Built ONLY on the design-system Select / Popover / Checkbox primitives and the
 * existing `pc-advpanel__*` classes — no hand-rolled dropdowns/popovers, no
 * off-system component (P-009 design check). Bare <button>/<input> get explicit
 * frost tokens (they don't inherit the theme) or reuse the panel classes.
 */

import { useState, type CSSProperties } from 'react';
import { ListFilter, X } from 'lucide-react';
import { FLAGS } from '@papercusp/flags';
import type { ColumnFilterValue, FilterableColumn, NumberFilterValue } from '@papercusp/grid-core';
import { useFlag } from '@/lib/flag-hooks';
import { Select } from '../Select';
import { Popover } from '../Popover';
import { Checkbox } from '../Checkbox';
import type { ColumnFilterController } from './useColumnFilters';

const ADD_FILTER = '_add_filter_';

/** Plain-text header for a column (the editor heading + the Add-filter option). */
function headerText(col: FilterableColumn<unknown>): string {
  const h = col.header;
  if (typeof h === 'string' && h.length > 0) return h;
  if (typeof h === 'number') return String(h);
  if (typeof col.headerText === 'string' && col.headerText.length > 0) return col.headerText;
  return col.key;
}

const EDITOR_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  minWidth: 200,
  maxWidth: 280,
  padding: 10,
  background: 'color-mix(in srgb, var(--bg-deeper, #0b1622), transparent 2%)',
  color: 'var(--fg, #e7f7ff)',
  border: '1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 62%)',
  borderRadius: 10,
  boxShadow: '0 18px 54px rgba(0,0,0,0.62)',
  fontSize: 12,
};

const EDITOR_HEADING_STYLE: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--fg-mute, #7f9bb4)',
};

const NUMBER_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

const ENUM_LIST_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  maxHeight: 220,
  overflowY: 'auto',
};

const ENUM_OPTION_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  cursor: 'pointer',
};

const ENUM_COUNT_STYLE: CSSProperties = {
  marginLeft: 'auto',
  color: 'var(--fg-mute, #7f9bb4)',
  fontVariantNumeric: 'tabular-nums',
};

/** Frost-styled bare number input (bare <input> doesn't inherit the theme). */
const NUMBER_INPUT_STYLE: CSSProperties = {
  width: 70,
  padding: '4px 7px',
  fontSize: 12,
  fontFamily: 'inherit',
  color: 'var(--fg, #e7f7ff)',
  background: 'var(--bg-2, rgba(255,255,255,0.045))',
  border: '1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%))',
  borderRadius: 6,
};

function asString(v: ColumnFilterValue | undefined): string {
  return typeof v === 'string' ? v : '';
}
function asArray(v: ColumnFilterValue | undefined): string[] {
  return Array.isArray(v) ? v : [];
}
function asNumberValue(v: ColumnFilterValue | undefined): NumberFilterValue {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as NumberFilterValue) : {};
}
function asBool(v: ColumnFilterValue | undefined): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function FilterEditor<TRow>({
  col,
  controller,
}: {
  col: FilterableColumn<TRow>;
  controller: ColumnFilterController<TRow>;
}) {
  const spec = col.filter;
  if (!spec) return null;
  const value = controller.valueFor(col.key);

  if (spec.type === 'text') {
    return (
      <input
        type="text"
        className="pc-advpanel__input"
        autoFocus
        value={asString(value)}
        onChange={(e) => controller.setValue(col.key, e.target.value)}
        placeholder={`Filter ${headerText(col as FilterableColumn<unknown>)}…`}
        aria-label={`Filter ${headerText(col as FilterableColumn<unknown>)}`}
        style={{ width: '100%' }}
      />
    );
  }

  if (spec.type === 'enum') {
    const options = controller.optionsFor(col.key);
    const selected = asArray(value);
    const multi = spec.multi !== false;
    const toggle = (optValue: string, on: boolean) => {
      if (!multi) {
        controller.setValue(col.key, on ? [optValue] : []);
        return;
      }
      const next = on
        ? [...selected, optValue]
        : selected.filter((s) => s !== optValue);
      controller.setValue(col.key, next);
    };
    return (
      <div style={ENUM_LIST_STYLE}>
        {options.length === 0 ? (
          <span style={{ color: 'var(--fg-mute, #7f9bb4)' }}>No values</span>
        ) : (
          options.map((opt) => {
            const on = selected.includes(opt.value);
            return (
              <label key={opt.value} style={ENUM_OPTION_STYLE}>
                <Checkbox
                  checked={on}
                  onChange={(c) => toggle(opt.value, c)}
                  ariaLabel={opt.label ?? opt.value}
                />
                <span>{opt.label ?? opt.value}</span>
                <span style={ENUM_COUNT_STYLE}>{opt.count}</span>
              </label>
            );
          })
        )}
      </div>
    );
  }

  if (spec.type === 'number') {
    const range = asNumberValue(value);
    const setBound = (bound: 'min' | 'max', raw: string) => {
      const next: NumberFilterValue = { ...range };
      if (raw === '') delete next[bound];
      else {
        const n = Number(raw);
        if (Number.isNaN(n)) return;
        next[bound] = n;
      }
      controller.setValue(col.key, next);
    };
    return (
      <div style={NUMBER_ROW_STYLE}>
        <input
          type="number"
          style={NUMBER_INPUT_STYLE}
          value={range.min ?? ''}
          onChange={(e) => setBound('min', e.target.value)}
          placeholder="min"
          aria-label={`${headerText(col as FilterableColumn<unknown>)} minimum`}
        />
        <span style={{ color: 'var(--fg-mute, #7f9bb4)' }}>–</span>
        <input
          type="number"
          style={NUMBER_INPUT_STYLE}
          value={range.max ?? ''}
          onChange={(e) => setBound('max', e.target.value)}
          placeholder="max"
          aria-label={`${headerText(col as FilterableColumn<unknown>)} maximum`}
        />
      </div>
    );
  }

  // boolean
  const current = asBool(value);
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {[
        { label: 'True', val: true },
        { label: 'False', val: false },
      ].map((opt) => (
        <button
          key={opt.label}
          type="button"
          className="pc-advpanel__chip"
          aria-pressed={current === opt.val}
          onClick={() => controller.setValue(col.key, opt.val)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function ColumnFilterBar<TRow>({
  controller,
  activeChips,
  hasActive,
  clearAll,
}: {
  controller: ColumnFilterController<TRow>;
  activeChips: { colKey: string; label: string; clear: () => void }[];
  hasActive: boolean;
  clearAll: () => void;
}) {
  // Gate the WHOLE bar behind the flag — when off, render nothing (the panel
  // still lists unfiltered rows). Hook order is stable: useFlag + useState run
  // unconditionally, the early return is below them.
  const enabled = useFlag(FLAGS.GRID_COLUMN_FILTERS);
  // Which column's editor popover is open. Transient render-only UI state — the
  // filter VALUES live in nuqs (via the controller); this is just the open flag.
  const [editingKey, setEditingKey] = useState<string | null>(null);

  if (!enabled) return null;

  const activeKeys = new Set(activeChips.map((c) => c.colKey));
  const addable = controller.filterableColumns.filter((c) => !activeKeys.has(c.key));
  const editingCol = controller.filterableColumns.find((c) => c.key === editingKey) ?? null;

  const addOptions = [
    { value: ADD_FILTER, label: 'Add filter…', disabled: true },
    ...addable.map((c) => ({
      value: c.key,
      label: headerText(c as FilterableColumn<unknown>),
    })),
  ];

  return (
    <div className="pc-advpanel__filterbar">
      <ListFilter size={13} aria-hidden style={{ color: 'var(--fg-mute, #7f9bb4)', flexShrink: 0 }} />

      {activeChips.map((chip) => (
        <button
          key={chip.colKey}
          type="button"
          className="pc-advpanel__chip"
          aria-pressed
          onClick={() => setEditingKey(chip.colKey)}
          title="Edit filter"
        >
          {chip.label}
          <X
            size={11}
            aria-label={`Remove ${chip.label} filter`}
            onClick={(e) => {
              e.stopPropagation();
              if (editingKey === chip.colKey) setEditingKey(null);
              chip.clear();
            }}
          />
        </button>
      ))}

      {addable.length > 0 ? (
        <Select
          value={ADD_FILTER}
          onChange={(key) => {
            if (key !== ADD_FILTER) setEditingKey(key);
          }}
          ariaLabel="Add a column filter"
          triggerClassName="pc-advpanel__chip"
          options={addOptions}
        />
      ) : null}

      {hasActive ? (
        <button type="button" className="pc-advpanel__chip" onClick={clearAll}>
          Clear all
        </button>
      ) : null}

      {/* One Popover, anchored to a 0-size sentinel, opened for the column being
          edited. The chip / Select pick sets editingKey; closing clears it. */}
      <Popover
        open={editingCol != null}
        onOpenChange={(open) => {
          if (!open) setEditingKey(null);
        }}
        trigger={<span aria-hidden style={{ width: 0, height: 0 }} />}
        side="bottom"
        align="start"
        ariaLabel={editingCol ? `Edit ${headerText(editingCol as FilterableColumn<unknown>)} filter` : 'Edit filter'}
        autoFocusOnOpen
        contentStyle={EDITOR_STYLE}
      >
        {editingCol ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={EDITOR_HEADING_STYLE}>{headerText(editingCol as FilterableColumn<unknown>)}</span>
              <button
                type="button"
                className="pc-advpanel__iconbtn"
                style={{ marginLeft: 'auto', width: 22, height: 22 }}
                aria-label="Close filter editor"
                onClick={() => setEditingKey(null)}
              >
                <X size={12} />
              </button>
            </div>
            <FilterEditor col={editingCol} controller={controller} />
          </>
        ) : null}
      </Popover>
    </div>
  );
}
