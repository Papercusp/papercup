'use client';

/**
 * FeatureFilterChips — Phase 8 P-047a.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.
 * v5 §9.1 — Features tab filter chips.
 *
 * Four chips:
 *   - mine       — features in MY queue (queue table joined with viewer github_user_id)
 *   - working    — features with non-empty working_users (someone's claim is live)
 *   - available  — features in_queue with empty working_users (orchestrator-claimable)
 *   - shipped    — features past `shipped`/`merged` state
 *
 * Pure UI. Consumer owns the filter state (recommended: nuqs
 * useQueryState so it's URL-backed per project convention) and
 * implements the filtering predicate. This component just renders the
 * chips + invokes onChange.
 *
 * Each chip can optionally show a count when the consumer knows how
 * many features match the filter. Counts go inside a small pill that
 * dims when count is 0.
 */

import type { CSSProperties, ReactNode } from 'react';

export type FeatureFilter = 'mine' | 'working' | 'available' | 'shipped';

export const FEATURE_FILTERS: readonly FeatureFilter[] = [
  'mine',
  'working',
  'available',
  'shipped',
] as const;

export interface FeatureFilterChipsProps {
  /** Currently-selected filter, or null for "all". */
  value: FeatureFilter | null;
  onChange: (next: FeatureFilter | null) => void;
  /** Optional per-filter counts. Missing entries render as no-count. */
  counts?: Partial<Record<FeatureFilter, number>>;
  /** Hide one or more chips by passing them in `hide`. */
  hide?: FeatureFilter[];
}

const LABELS: Record<FeatureFilter, string> = {
  mine: 'Mine',
  working: 'Working',
  available: 'Available',
  shipped: 'Shipped',
};

const TOOLTIPS: Record<FeatureFilter, string> = {
  mine: 'Features in your queue',
  working: 'Features someone is actively working on',
  available: 'Features no one has claimed yet',
  shipped: 'Features that have been merged + shipped',
};

const ROW: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
};

function chipStyle(active: boolean): CSSProperties {
  return {
    fontSize: 12,
    padding: '4px 10px',
    borderRadius: 999,
    border: `1px solid ${active ? 'var(--accent, #6aa)' : 'var(--border, #2a2a2a)'}`,
    background: active ? 'rgba(102, 170, 170, 0.12)' : 'transparent',
    color: active ? 'var(--accent, #6aa)' : 'var(--fg-dim, #aaa)',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontWeight: active ? 600 : 400,
    lineHeight: 1.4,
    whiteSpace: 'nowrap',
  };
}

function countPillStyle(active: boolean, zero: boolean): CSSProperties {
  return {
    fontSize: 10,
    fontWeight: 500,
    padding: '1px 5px',
    borderRadius: 999,
    background: active
      ? 'var(--accent, #6aa)'
      : 'var(--surface-2, #2a2a2a)',
    color: active ? 'var(--surface, #1a1a1a)' : 'var(--fg-dim, #aaa)',
    opacity: zero ? 0.5 : 1,
    minWidth: 14,
    textAlign: 'center',
  };
}

const ALL_CHIP: CSSProperties = {
  fontSize: 11,
  background: 'transparent',
  color: 'var(--fg-dim, #888)',
  border: 'none',
  cursor: 'pointer',
  padding: '4px 6px',
  textDecoration: 'underline',
};

export function FeatureFilterChips(props: FeatureFilterChipsProps): ReactNode {
  const hidden = new Set(props.hide ?? []);
  const visible = FEATURE_FILTERS.filter((f) => !hidden.has(f));
  return (
    <span role="radiogroup" data-testid="feature-filter-chips" style={ROW}>
      {visible.map((f) => {
        const active = props.value === f;
        const count = props.counts?.[f];
        const hasCount = typeof count === 'number';
        return (
          <button
            key={f}
            type="button"
            role="radio"
            aria-checked={active}
            data-testid={`feature-filter-${f}`}
            data-active={active ? '1' : '0'}
            style={chipStyle(active)}
            title={TOOLTIPS[f]}
            onClick={() => props.onChange(active ? null : f)}
          >
            <span>{LABELS[f]}</span>
            {hasCount && (
              <span
                data-testid={`feature-filter-${f}-count`}
                style={countPillStyle(active, count === 0)}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
      {props.value !== null && (
        <button
          type="button"
          data-testid="feature-filter-clear"
          style={ALL_CHIP}
          onClick={() => props.onChange(null)}
          title="Clear filter"
        >
          Clear
        </button>
      )}
    </span>
  );
}
